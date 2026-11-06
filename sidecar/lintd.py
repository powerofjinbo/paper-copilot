#!/usr/bin/env python3
'''lintd.py - long-lived JSON-lines lint daemon around the user's hep-paper-writing style_check.py.

Protocol: sidecar/PROTOCOL.md. Python 3 standard library only.

    python3 sidecar/lintd.py [--skill-dir DIR]

The skill directory is found from --skill-dir, else $PAPER_SKILL_DIR, else ~/.claude/skills/hep-paper-writing,
else the repository's .skill directory. style_check.py is imported once, as a module, from its own path; it is
never modified or copied, and no bytecode cache is written next to it. style_check.flag is wrapped at run time so
that every flag also records the sentence index (Sent.i), the paragraph block and the raw sentence text.

One request per stdin line, one response per stdout line, in order, flushed after each line. Anything
style_check itself prints during a call goes to stderr, so stdout carries only protocol lines.
'''
import argparse
import hashlib
import importlib.util
import json
import os
import re
import statistics
import sys
import traceback
from contextlib import redirect_stdout

PROTOCOL_VERSION = 1
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_SKILL = os.path.normpath(os.path.join(HERE, '..', '.skill'))

#: Checks run by lint.sentences (the sentence-local ones; see PROTOCOL.md).
SENTENCE_CHECKS = frozenset({1, 2, 3, 4, 5, 10})
#: Parts a sentence may belong to (packages/core/src/schemas.ts Part, same vocabulary as style_check).
PARTS = ('abstract', 'intro', 'body', 'concl', 'app', 'caption', 'footnote')
PART_ALIASES = {
    'introduction': 'intro', 'conclusion': 'concl', 'conclusions': 'concl', 'summary': 'concl',
    'appendix': 'app', 'appendices': 'app', 'main': 'body', 'prose': 'body', 'fig': 'caption',
    'figure': 'caption', 'table': 'caption', 'note': 'footnote',
}
EMPH_RE = re.compile(r'\*([^*\n]+?)\*')
MAX_LINE_BYTES = 64 * 1024 * 1024

sc = None            # the style_check module, once loaded
CHECK_KEY = {}       # 1 -> 'long', ...
STYLE_CHECK_PATH = None
VERSION = None
_MACRO_CACHE = {}    # sha256(preamble) -> macros dict (bounded)


# =============================================================================================
# Locating and loading style_check.py
# =============================================================================================
class StartError(Exception):
    pass


def style_check_in(path):
    '''The style_check.py inside a skill dir, its scripts/ dir, or the file itself; None if absent.'''
    if not path:
        return None
    path = os.path.abspath(os.path.expanduser(path))
    for cand in (os.path.join(path, 'scripts', 'style_check.py'), os.path.join(path, 'style_check.py'), path):
        if os.path.isfile(cand) and cand.endswith('.py'):
            return cand
    return None


def locate(skill_dir_arg):
    '''Explicit locations (--skill-dir, then $PAPER_SKILL_DIR) must hold the file; defaults are tried in order.'''
    explicit = [('--skill-dir', skill_dir_arg), ('PAPER_SKILL_DIR', os.environ.get('PAPER_SKILL_DIR'))]
    for src, val in explicit:
        if val:
            hit = style_check_in(val)
            if hit:
                return hit
            raise StartError('no scripts/style_check.py under %s (from %s)' % (val, src))
    tried = []
    for d in (os.path.join(os.path.expanduser('~'), '.claude', 'skills', 'hep-paper-writing'), REPO_SKILL,
              '/home/user/paper-copilot/.skill'):
        if d in tried:
            continue
        tried.append(d)
        hit = style_check_in(d)
        if hit:
            return hit
    raise StartError('hep-paper-writing skill not found (pass --skill-dir or set PAPER_SKILL_DIR; tried %s)'
                     % ', '.join(tried))


REQUIRED = ('flag', 'analyse', 'run_checks', 'CHECKS', 'CORPUS_RATE', 'Store', 'TexConv', 'text_block',
            'make_sentences', 'Doc', 'parse_macros', 'strip_tex_comments', 'length_rows', 'check_passive',
            'check_verb', 'passive_count', 'CORPUS_LEN', 'CORPUS_PASSIVE')


def load_style_check(path):
    global sc, CHECK_KEY, STYLE_CHECK_PATH, VERSION
    with open(path, 'rb') as f:
        data = f.read()
    VERSION = hashlib.sha256(data).hexdigest()[:12]
    STYLE_CHECK_PATH = path
    old = sys.dont_write_bytecode
    sys.dont_write_bytecode = True          # never write __pycache__ into the user's skill
    try:
        spec = importlib.util.spec_from_file_location('style_check', path)
        if spec is None or spec.loader is None:
            raise StartError('cannot import %s' % path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules['style_check'] = mod
        with redirect_stdout(sys.stderr):
            spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode = old
    missing = [n for n in REQUIRED if not hasattr(mod, n)]
    if missing:
        raise StartError('%s lacks %s (unsupported style_check version)' % (path, ', '.join(missing)))
    sc = mod
    CHECK_KEY = {k: key for k, key, _ in mod.CHECKS}
    install_flag_wrapper(mod)


def install_flag_wrapper(mod):
    '''Replace mod.flag (looked up as a module global by every check) with a wrapper that records the Sent.'''
    orig = mod.flag
    if getattr(orig, '_lintd_wrapped', False):
        return

    def flag(*args, **kw):
        f = orig(*args, **kw)
        s = args[1] if len(args) > 1 else kw.get('s')
        try:
            f['sent_index'] = s.i if s is not None else None
            f['block'] = s.block if s is not None else None
            f['raw'] = s.raw if s is not None else None
        except AttributeError:
            f['sent_index'] = f['block'] = f['raw'] = None
        return f

    flag._lintd_wrapped = True
    flag.__wrapped__ = orig
    flag.__doc__ = orig.__doc__
    mod.flag = flag


# =============================================================================================
# Helpers
# =============================================================================================
class ReqError(Exception):
    pass


class Opts:
    '''The argparse namespace style_check's checks read (only, max_words, known).'''

    def __init__(self, only, max_words, known):
        self.only = set(only)
        self.max_words = max_words
        self.known = set(known)


def req_known(req):
    known = req.get('known', [])
    if known is None:
        return set()
    if isinstance(known, str):
        known = [k for k in re.split(r'[,\s]+', known) if k]
    if not isinstance(known, list):
        raise ReqError('known must be a list of strings')
    out = set()
    for k in known:
        if not isinstance(k, str):
            raise ReqError('known must be a list of strings')
        k = k.strip()
        if k:
            out.add(k)
    return out


def req_max_words(req):
    mw = req.get('max_words', req.get('maxWords', 40))
    if mw is None:
        return 40
    if isinstance(mw, bool) or not isinstance(mw, (int, float)) or mw != int(mw):
        raise ReqError('max_words must be an integer')
    mw = int(mw)
    if mw < 5:
        raise ReqError('max_words must be at least 5')
    return mw


def norm_part(p):
    if p is None:
        return 'body'
    if not isinstance(p, str):
        raise ReqError('part must be a string')
    p = p.strip().lower()
    p = PART_ALIASES.get(p, p)
    return p if p in PARTS else 'body'


def macros_for(preamble):
    '''Macros from an optional preamble string (\\newcommand, \\def), cached by content.'''
    if not preamble:
        return {}
    if not isinstance(preamble, str):
        raise ReqError('preamble must be a string')
    h = hashlib.sha256(preamble.encode('utf-8', 'surrogatepass')).hexdigest()
    m = _MACRO_CACHE.get(h)
    if m is None:
        t = preamble.replace('\r\n', '\n').replace('\r', '\n')
        m = sc.parse_macros(sc.strip_tex_comments(t))
        if len(_MACRO_CACHE) >= 16:
            _MACRO_CACHE.clear()
        _MACRO_CACHE[h] = m
    return m


def emphasis_word(check, msg, plain):
    '''The offending word or phrase: the first *emphasis* in msg that occurs in the sentence, else None.'''
    if check == 1 or not msg:
        return None          # check 1's emphasis is a split hint, not an offending word
    if check == 10 and msg.startswith('The abstract has a passive'):
        return None
    low = (plain or '').lower()
    for m in EMPH_RE.finditer(msg):
        w = m.group(1).strip()
        if not w or not re.search(r'[A-Za-z]', w):
            continue
        if low and re.search(r'(?<![A-Za-z])%s(?![A-Za-z])' % re.escape(w.lower()), low):
            return w
    return None


def is_doc_level(f):
    '''Flags of checks 3 and 10 that depend on other sentences, not on the sentence itself.'''
    c, msg = f.get('check'), f.get('msg') or ''
    if c == 3 and msg.startswith('Second stock connector'):
        return True
    if c == 10 and msg.startswith('The abstract has a passive'):
        return True
    return f.get('sent_index') is None


def sorted_flags(res):
    out = []
    for k in sorted(res):
        out.extend(res[k].get('flags', []))
    return out


def make_doc(name, store, sents, conv):
    doc = sc.Doc()
    doc.name, doc.fmt, doc.store, doc.conv = name, 'tex', store, conv
    doc.includes, doc.heads = [], []
    doc.sents = sents
    doc.words = sum(s.words for s in sents)
    doc.roman_tables = False
    doc.rawrefs = set()
    doc.pdf_like = False
    return doc


def as_int(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return 0


# =============================================================================================
# Commands
# =============================================================================================
def item_blocks(idx, text, part, store, macros):
    '''Convert one LaTeX sentence into a paragraph block of the given part (a tiny document of its own).'''
    conv = sc.TexConv(store, macros)
    t = text.replace('\r\n', '\n').replace('\r', '\n')
    t = sc.strip_tex_comments(t)
    kind = part if part in ('caption', 'footnote') else 'prose'
    t = conv.envpass(t, 1)
    body = conv.conv(t, 1, 'caption' if kind == 'caption' else ('footnote' if kind == 'footnote' else 'body'))
    blk = sc.text_block(body, 1, kind)
    if kind == 'prose':
        blk['part'] = part
    blk['_item'] = idx
    return blk, conv


def sentence_flags(doc, opts, items_by_block, sid_of_item):
    with redirect_stdout(sys.stderr):
        res = sc.run_checks(doc, opts)
    out, order = [], []
    for f in sorted_flags(res):
        if is_doc_level(f) or f.get('info'):
            continue
        bi = f.get('block')
        if bi is None or bi not in items_by_block:
            continue
        si = f.get('sent_index')
        s = doc.sents[si] if isinstance(si, int) and 0 <= si < len(doc.sents) else None
        c = f.get('check')
        order.append(items_by_block[bi])
        out.append(dict(sid=sid_of_item[items_by_block[bi]], check=c, key=CHECK_KEY.get(c, str(c)),
                        msg=f.get('msg', ''), word=emphasis_word(c, f.get('msg', ''), s.plain if s else ''),
                        excerpt=f.get('text') or ''))
    # Item order first, then style_check's check order (a stable, deterministic order).
    return [f for _, _, f in sorted(zip(order, range(len(out)), out), key=lambda t: (t[0], t[1]))]


def cmd_lint_sentences(req):
    items = req.get('items')
    if not isinstance(items, list):
        raise ReqError('items must be a list')
    known = req_known(req)
    opts = Opts(SENTENCE_CHECKS, req_max_words(req), known)
    macros = macros_for(req.get('preamble'))
    parsed = []
    for n, it in enumerate(items):
        if not isinstance(it, dict):
            raise ReqError('items[%d] must be an object' % n)
        sid = it.get('sid')
        if isinstance(sid, bool) or not isinstance(sid, (str, int)):
            raise ReqError('items[%d].sid must be a string' % n)
        text = it.get('text')
        if not isinstance(text, str):
            raise ReqError('items[%d].text must be a string' % n)
        parsed.append((str(sid), text, norm_part(it.get('part'))))

    errors = []
    store = sc.Store()
    blocks, convs, sid_of_item = [], [], []
    for idx, (sid, text, part) in enumerate(parsed):
        sid_of_item.append(sid)
        if not text.strip():
            continue
        try:
            with redirect_stdout(sys.stderr):
                blk, conv = item_blocks(idx, text, part, store, macros)
        except Exception as e:                 # one unparsable sentence never sinks the batch
            errors.append(dict(sid=sid, error='%s: %s' % (type(e).__name__, e)))
            continue
        if blk['pieces']:
            blocks.append(blk)
            convs.append(conv)

    def run(blks):
        with redirect_stdout(sys.stderr):
            sents = sc.make_sentences(blks, store, None)
        doc = make_doc('sentences', store, sents, convs[-1] if convs else sc.TexConv(store))
        by_block = {b_id: b['_item'] for b_id, b in enumerate(blks)}
        return sentence_flags(doc, opts, by_block, sid_of_item)

    flags = []
    if blocks:
        try:
            flags = run(blocks)      # one combined pass; every check here is local to its sentence
        except Exception:
            flags = []
            for b in blocks:         # isolate the item that breaks style_check
                try:
                    flags.extend(run([b]))
                except Exception as e:
                    errors.append(dict(sid=sid_of_item[b['_item']], error='%s: %s' % (type(e).__name__, e)))
    resp = dict(flags=flags)
    if errors:
        resp['errors'] = errors
    return resp


def cmd_lint_document(req):
    text = req.get('text')
    if not isinstance(text, str):
        raise ReqError('text must be a string')
    fmt = req.get('fmt', 'tex') or 'tex'
    if fmt not in ('tex', 'md', 'txt', 'auto'):
        raise ReqError('fmt must be tex, md, txt or auto')
    opts = Opts({k for k in CHECK_KEY}, req_max_words(req), req_known(req))
    text = text.lstrip('﻿')
    if fmt == 'auto':
        fmt = sc.sniff(text) if hasattr(sc, 'sniff') else 'tex'
    with redirect_stdout(sys.stderr):
        doc = sc.analyse(text, fmt, 'document')
        res = sc.run_checks(doc, opts)
    flags = []
    for f in sorted_flags(res):
        if f.get('info'):
            continue
        si = f.get('sent_index')
        s = doc.sents[si] if isinstance(si, int) and 0 <= si < len(doc.sents) else None
        c = f.get('check')
        flags.append(dict(check=c, key=CHECK_KEY.get(c, str(c)), line=as_int(f.get('line')),
                          part=f.get('part') or '', excerpt=f.get('text') or '', msg=f.get('msg', ''),
                          word=emphasis_word(c, f.get('msg', ''), s.plain if s else ''), sent_index=si))
    W = doc.words or 1
    rates, ref = {}, {}
    for k, key, _ in sc.CHECKS:
        n = len(res.get(k, {}).get('flags', []))
        rates[key] = round(1000.0 * n / W, 2)
        ref[key] = sc.CORPUS_RATE.get(k)
    return dict(flags=flags, rates=rates, reference_rates=ref, words=doc.words, sentences=len(doc.sents),
                includes=list(doc.includes))


def cmd_corpus_stats(req):
    texts = req.get('texts')
    if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
        raise ReqError('texts must be a list of strings')
    fmt = req.get('fmt', 'txt') or 'txt'
    if fmt not in ('tex', 'txt', 'md', 'auto'):
        raise ReqError('fmt must be tex, txt, md or auto')
    sents, errors = [], []
    store_conv = None
    for n, t in enumerate(texts):
        if not t.strip():
            continue
        f = fmt
        t = t.lstrip('﻿')
        if f == 'auto':
            f = sc.sniff(t) if hasattr(sc, 'sniff') else 'txt'
        try:
            with redirect_stdout(sys.stderr):
                d = sc.analyse(t, f, 'text%d' % n)
        except Exception as e:
            errors.append(dict(index=n, error='%s: %s' % (type(e).__name__, e)))
            continue
        sents.extend(d.sents)
        store_conv = (d.store, d.conv)
    for k, s in enumerate(sents):
        s.i = k
    out = dict(texts=len(texts), words=sum(s.words for s in sents), sentences=len(sents))
    prose = [s.words for s in sents if s.kind == 'prose']
    out['prose_sentences'] = len(prose)
    if prose:
        srt = sorted(prose)
        n = len(srt)
        out['median_length'] = statistics.median(srt)
        out['mean_length'] = round(statistics.mean(srt), 1)
        out['p90_length'] = srt[min(n - 1, int(round(0.9 * (n - 1))))]
        out['gt40_pct'] = round(100.0 * sum(1 for x in srt if x > 40) / n, 1)
    else:
        out['median_length'] = out['mean_length'] = out['p90_length'] = out['gt40_pct'] = None
    out['length_by_part'] = sc.length_rows(sents)
    if sents:
        doc = make_doc('corpus', store_conv[0], sents, store_conv[1])
        opts = Opts({2, 10}, 40, set())
        with redirect_stdout(sys.stderr):
            pas = sc.check_passive(doc, opts)
            verb = sc.check_verb(doc, opts)
        pp = [s for s in sents if s.kind == 'prose']
        npass = sum(1 for s in pp if sc.passive_count(s.low))
        out['passive_share'] = round(npass / len(pp), 4) if pp else None
        out['passive_pct'] = round(100.0 * npass / len(pp), 1) if pp else None
        out['passive_by_part'] = pas['rows']
        out['we_per_1k'] = pas['we_per_1k'] if pp else None
        out['median_verb_position'] = verb['median']
        out['verb_positions_n'] = verb['n']
    else:
        out.update(passive_share=None, passive_pct=None, passive_by_part=[], we_per_1k=None,
                   median_verb_position=None, verb_positions_n=0)
    out['corpus'] = dict(
        length={p: dict(zip(['sentences', 'median', 'mean', 'p90', 'le12', 'gt30', 'gt40'], v))
                for p, v in sc.CORPUS_LEN.items()},
        passive_pct=dict(sc.CORPUS_PASSIVE),
        we_per_1k=getattr(sc, 'CORPUS_WE_PER_1K', None))
    if errors:
        out['errors'] = errors
    return out


def cmd_ping(req):
    return dict(pong=True, version=VERSION)


COMMANDS = {
    'ping': cmd_ping,
    'lint.sentences': cmd_lint_sentences,
    'lint.sentence': None,       # alias handled in handle(): {text, part} -> one item
    'lint.document': cmd_lint_document,
    'corpus.stats': cmd_corpus_stats,
}


# =============================================================================================
# Loop
# =============================================================================================
def write(out, obj):
    line = json.dumps(obj, ensure_ascii=True, separators=(',', ':'), default=str) + '\n'
    out.write(line.encode('ascii'))
    out.flush()


def handle(line):
    '''Returns (response, stop).'''
    try:
        req = json.loads(line)
    except ValueError as e:
        return dict(id=None, ok=False, error='bad JSON: %s' % e), False
    if not isinstance(req, dict):
        return dict(id=None, ok=False, error='request must be a JSON object'), False
    rid = req.get('id')
    if not (rid is None or isinstance(rid, (int, str))) or isinstance(rid, bool):
        rid = None
    cmd = req.get('cmd')
    if cmd == 'shutdown':
        return dict(id=rid, ok=True), True
    if not isinstance(cmd, str) or cmd not in COMMANDS:
        return dict(id=rid, ok=False, error='unknown cmd %r' % (cmd,)), False
    try:
        if cmd == 'lint.sentence':
            req = dict(req, items=[dict(sid=req.get('sid', '0'), text=req.get('text'), part=req.get('part'))])
            body = cmd_lint_sentences(req)
        else:
            body = COMMANDS[cmd](req)
    except ReqError as e:
        return dict(id=rid, ok=False, error=str(e)), False
    except RecursionError:
        return dict(id=rid, ok=False, error='%s: input nested too deeply' % cmd), False
    except (Exception, SystemExit) as e:
        traceback.print_exc(file=sys.stderr)
        return dict(id=rid, ok=False, error='%s failed: %s: %s' % (cmd, type(e).__name__, e)), False
    resp = dict(id=rid, ok=True)
    resp.update(body)
    return resp, False


def serve(inp, out):
    while True:
        raw = inp.readline(MAX_LINE_BYTES)
        if not raw:
            return 0
        if len(raw) >= MAX_LINE_BYTES and not raw.endswith(b'\n'):
            while True:                              # drain the rest of an oversized line
                more = inp.readline(MAX_LINE_BYTES)
                if not more or more.endswith(b'\n'):
                    break
            write(out, dict(id=None, ok=False, error='request line too long'))
            continue
        line = raw.decode('utf-8', 'replace').strip()
        if not line:
            continue
        resp, stop = handle(line)
        write(out, resp)
        if stop:
            return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='JSON-lines lint daemon around hep-paper-writing style_check.py')
    ap.add_argument('--skill-dir', default=None, help='the hep-paper-writing skill directory')
    args = ap.parse_args(argv)
    out = sys.stdout.buffer
    # Protocol lines go only to `out`; any other print goes to stderr.
    sys.stdout = sys.stderr
    try:
        path = locate(args.skill_dir)
        load_style_check(path)
    except (StartError, OSError, SyntaxError, ImportError) as e:
        write(out, dict(ready=False, error=str(e)))
        return 2
    except Exception as e:
        write(out, dict(ready=False, error='%s: %s' % (type(e).__name__, e)))
        return 2
    write(out, dict(ready=True, style_check=STYLE_CHECK_PATH, version=VERSION, protocol=PROTOCOL_VERSION))
    try:
        return serve(sys.stdin.buffer, out)
    except (BrokenPipeError, KeyboardInterrupt):
        return 0


if __name__ == '__main__':
    sys.setrecursionlimit(max(sys.getrecursionlimit(), 5000))
    sys.exit(main())
