#!/usr/bin/env python3
"""Regenerate excessVocab.ts and styleCheckLists.ts in this directory.

Usage (numpy and pandas needed only for the excess vocabulary):
  git clone --depth 1 https://github.com/berenslab/llm-excess-vocab /tmp/llm-excess-vocab
  python3 -I regenerate.py /tmp/llm-excess-vocab /path/to/hep-paper-writing/scripts/style_check.py

What it does
1. Imports style_check.py (definitions only; its main() is not run) and copies its word lists and regexes.
2. Reproduces compute_excess(2024) of llm-excess-vocab/scripts/03-figures.ipynb from
   results/yearly-counts.csv.gz and keeps the 2024 excess words annotated `style` in results/excess_words.csv,
   with their excess ratio r and gap delta.
3. Lists unmeasured inflections of flagged words (FLAG RULE in ../aiese.ts; MIN_RATIO, TOP_GAP and
   HEP_NEUTRAL below must match that file).
"""
import hashlib, importlib.util, json, os, subprocess, sys, textwrap

sys.dont_write_bytecode = True   # never write __pycache__ into the skill checkout
import numpy as np
import pandas as pd

MIN_RATIO, TOP_GAP, TOP_GAP_MIN_RATIO = 3, 100, 1.5
HEP_NEUTRAL = set("""achieving addressing aligning challenges contributing demonstrates distinct diverse emerged emerges employed
exhibit exhibited exhibits explores focusing holds offer particularly precise presents primarily stands substantial""".split())

root, style_path = sys.argv[1], sys.argv[2]
outdir = os.path.dirname(os.path.abspath(__file__))
commit = subprocess.run(['git', '-C', root, 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
sha = hashlib.sha256(open(style_path, 'rb').read()).hexdigest()

# ---- 1. style_check.py lists
spec = importlib.util.spec_from_file_location('style_check', style_path)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
style = {}
for name in ['AUX','VERB_BASES','IRREG_PAST','NOUN_BASES','DOUBLE_FINAL','NOT_PART','PRONOUNS','NOT_PLURAL','SUBORD','OPENER_PREP',
             'FW','DETS','PREPS','NUMWORDS','LABEL_WORDS','SUBJ_PRON','NOUN_S_ENDINGS','ADJ_ENDINGS','CLAUSE_START','AFTER_VERB','SKIP_ADV',
             'BE','PASS_ADV','PARTICIPLE_IRREG','CONNECTIVE_OPENERS']:
    v = getattr(m, name)
    style[name] = sorted(v) if isinstance(v, (set, frozenset)) else list(v)
for k in ['MORPH_VERB_RE', 'CONN_A', 'CONN_B', 'STOCK_RE', 'WORD_RE']:
    style[k] = getattr(m, k).pattern
style['INFLATED'] = m.INFLATED
style['HYPE'] = m.HYPE
style['PUNCT'] = m.PUNCT
for k in ['LABEL_NUM_RE','YEAR_RE','NUM_TOKEN_RE','SPELLED_NUM_RE','STAT_RE','STAT_CS_RE','IT_PASSIVE_RE','IN_ORDER_RE']:
    style[k] = [getattr(m, k).pattern, bool(getattr(m, k).flags & 2)]

# ---- 2. excess vocabulary (scripts/03-figures.ipynb, compute_excess)
df = pd.read_csv(root + "/results/yearly-counts.csv.gz")
words = np.array([str(w) for w in df.word.tolist()[:-1]])
years = df.columns[1:].astype(int)
counts = df.iloc[:-1, 1:].to_numpy().astype(int)
totals = df.iloc[-1, 1:].to_numpy().astype(int)
freqs = (counts.astype(float) + 1) / (totals + 1)
alphabet = set('abcdefghijklmnopqrstuvwxyz')
allowed = np.array([all(c in alphabet for c in w) and len(w) >= 4 for w in words])
def compute_excess(t, cutoff=1e-4):
    sub = allowed & (freqs[:, years == t].ravel() >= cutoff) & (freqs[:, years == t - 1].ravel() >= cutoff)
    proj = freqs[sub, years == t - 2] + np.maximum((freqs[sub, years == t - 2] - freqs[sub, years == t - 3]) * 2, 0)
    return sub, freqs[sub, years == t] / proj, freqs[sub, years == t] - proj, freqs[sub][:, years == t].ravel()
sub, r, d, x = compute_excess(2024)
ind = np.log10(r) > np.log10(2) - (np.log10(x) + 4) * (np.log10(2) / 4)
ind |= d > 0.01
ann = pd.read_csv(root + "/results/excess_words.csv")
w2t = dict(zip(ann.word, ann.type)); w2p = dict(zip(ann.word, ann.part_of_speech))
exc = [dict(word=w, ratio=round(float(rr), 1), gap=round(float(dd), 4), pos=w2p.get(w))
       for w, rr, dd in zip(words[sub][ind], r[ind], d[ind]) if w2t.get(w) == 'style']

# ---- 3. unmeasured inflections of flagged words
top = set(e['word'] for e in sorted(exc, key=lambda e: (-e['gap'], e['word']))[:TOP_GAP])
flagged = {e['word']: e['pos'] for e in exc
           if (e['ratio'] >= MIN_RATIO or (e['word'] in top and e['ratio'] >= TOP_GAP_MIN_RATIO)) and e['word'] not in HEP_NEUTRAL}
analyzed = set(words[sub]); known = dict(zip(words, counts.sum(axis=1))); index = {w: i for i, w in enumerate(words)}

def verb_bases(w):
    b = set()
    if w.endswith('ing'):
        s = w[:-3]; b |= {s, s + 'e'}
        if len(s) > 2 and s[-1] == s[-2]: b.add(s[:-1])
    elif w.endswith('ied'): b.add(w[:-3] + 'y')
    elif w.endswith('ed'):
        b |= {w[:-2], w[:-1]}
        s = w[:-2]
        if len(s) > 2 and s[-1] == s[-2]: b.add(s[:-1])
    elif w.endswith('ies'): b.add(w[:-3] + 'y')
    elif w.endswith('es'): b |= {w[:-2], w[:-1]}
    elif w.endswith('s'): b.add(w[:-1])
    else: b.add(w)
    return b
def verb_forms(b):
    f = {b}
    if b.endswith(('s', 'sh', 'ch', 'x', 'z', 'o')): f.add(b + 'es')
    elif len(b) > 1 and b.endswith('y') and b[-2] not in 'aeiou': f.add(b[:-1] + 'ies')
    else: f.add(b + 's')
    if b.endswith('e'): f |= {b + 'd', b[:-1] + 'ing'}
    elif len(b) > 1 and b.endswith('y') and b[-2] not in 'aeiou': f |= {b[:-1] + 'ied', b + 'ing'}
    else: f |= {b + 'ed', b + 'ing'}
    return f
def forms(w, pos):
    out = set()
    if pos == 'verb':
        for b in verb_bases(w): out |= verb_forms(b)
    elif pos.startswith('noun'):
        out |= {w, w + 's', w + 'es'}
        if w.endswith('ies'): out.add(w[:-3] + 'y')
        elif w.endswith('y'): out.add(w[:-1] + 'ies')
        if w.endswith('s'): out.add(w[:-1])
    elif pos.startswith('adj'):
        out |= {w, w + 'ly'}
    elif pos.startswith('adv') and w.endswith('ly'):
        out |= {w, w[:-2]}
    else:
        out.add(w)
    more = set()
    for f in out:
        if 'iz' in f: more.add(f.replace('iz', 'is'))
        if 'is' in f and 'iz' not in f: more.add(f.replace('is', 'iz'))
    return out | more
infl = {}
for w, pos in sorted(flagged.items()):
    for f in sorted(forms(w, pos)):
        if f in flagged or f in analyzed or f in infl: continue
        if known.get(f, 0) <= 0: continue
        fr = freqs[index[f]]
        q = fr[-3] + max(fr[-3] - fr[-4], 0) * 2
        if fr[-1] / q < 2: continue          # below the cutoff and not clearly rising: not an excess word
        infl[f] = w
print('flagged measured words:', len(flagged), ' unmeasured inflections:', len(infl), file=sys.stderr)

# ---- 4. write the TypeScript files
def js_str(s):
    return json.dumps(s, ensure_ascii=False)


def wl(name, words, doc):
    body = textwrap.fill(' '.join(words), 108, break_on_hyphens=False, break_long_words=False)
    body = textwrap.indent(body, '  ')
    return f"/** {doc} */\nexport const {name}: ReadonlySet<string> = words(`\n{body}\n`);\n"


L = []
L.append(f"""/**
 * Word lists and patterns copied verbatim from the user's hep-paper-writing skill:
 * .skill/scripts/style_check.py (sha256 {sha}).
 * Each constant keeps the name it has in style_check.py so the two can be compared line by line. The
 * Python regexes are copied as source strings; they use only syntax JavaScript shares (lookaheads,
 * non-capturing groups, character classes) and are compiled case-insensitively where style_check.py uses re.I.
 *
 * GENERATED by regenerate.py (this directory); do not edit by hand. If the skill changes, regenerate so the
 * style meter and the sidecar linter keep the same vocabulary.
 */

function words(s: string): ReadonlySet<string> {{
  return new Set(s.split(/\\s+/).filter((w) => w.length > 0));
}}
""")
docs = {
 'AUX': 'Auxiliary and modal verbs (finite whenever they appear).',
 'VERB_BASES': 'Base forms of verbs used in physics prose (style_check.py VERB_BASES), inflected by `inflect`.',
 'IRREG_PAST': 'Irregular simple-past forms.',
 'NOUN_BASES': 'Verb bases that are also common nouns (use, study, fit, ...).',
 'DOUBLE_FINAL': 'Bases that double the final consonant before -ed (fit -> fitted).',
 'NOT_PART': 'Words ending in -ed that are not participles.',
 'PRONOUNS': 'Pronouns that can be a subject.',
 'NOT_PLURAL': 'Words in -s that are not plurals.',
 'SUBORD': 'Subordinating conjunctions that open a clause before the main verb.',
 'OPENER_PREP': 'Prepositions and participles that open a fronted phrase.',
 'FW': 'Function words.',
 'DETS': 'Determiners.',
 'PREPS': 'Prepositions.',
 'NUMWORDS': 'Spelled numerals one..ten.',
 'LABEL_WORDS': 'Label words (Fig., Table, Eq., ...) that precede a number.',
 'SUBJ_PRON': 'Subject pronouns.',
 'CLAUSE_START': 'Words that start a new clause.',
 'AFTER_VERB': 'Words that typically follow a verb.',
 'SKIP_ADV': 'Adverbs skipped between a subject pronoun and its verb.',
 'BE': 'Forms of *be* for the passive detector (check 10).',
 'PASS_ADV': 'Adverbs allowed between *be* and the participle (check 10).',
 'PARTICIPLE_IRREG': 'Irregular past participles (check 10).',
 'CONNECTIVE_OPENERS': 'Connective openers that may front a main clause (check 2).',
}
for k in ['AUX','VERB_BASES','IRREG_PAST','NOUN_BASES','DOUBLE_FINAL','NOT_PART','PRONOUNS','NOT_PLURAL','SUBORD','OPENER_PREP','FW','DETS','PREPS','NUMWORDS','LABEL_WORDS','SUBJ_PRON','CLAUSE_START','AFTER_VERB','SKIP_ADV','BE','PASS_ADV','PARTICIPLE_IRREG','CONNECTIVE_OPENERS']:
    w = style[k] if k != 'VERB_BASES' else style[k]  # keep source order for VERB_BASES
    L.append(wl(k, w, docs[k]))
L.append("/** Noun endings in -s (check 2). */\nexport const NOUN_S_ENDINGS: readonly string[] = " + json.dumps(style['NOUN_S_ENDINGS']) + ";\n")
L.append("/** Adjective endings (check 2). */\nexport const ADJ_ENDINGS: readonly string[] = " + json.dumps(style['ADJ_ENDINGS']) + ";\n")
L.append("/** Morphological verb test: -izes/-ated/-ified/... and -ed after a non-e letter. */\nexport const MORPH_VERB_RE = new RegExp(" + js_str(style['MORPH_VERB_RE']) + ");\n")
L.append("/** A token is a word (style_check.py WORD_RE). */\nexport const WORD_RE = new RegExp(" + js_str(style['WORD_RE']) + ");\n")
L.append("/** Punctuation stripped from token edges (style_check.py PUNCT). */\nexport const PUNCT = " + js_str(style['PUNCT']) + ";\n")
L.append("/** Check 3, class A sentence openers (Moreover, Furthermore, Thus, Hence, Also, ...), flagged on sight. */\nexport const CONN_A = new RegExp(" + js_str(style['CONN_A']) + ", 'i');\n")
L.append("/** Check 3, class B sentence openers (In addition, Additionally, Therefore, Consequently). */\nexport const CONN_B = new RegExp(" + js_str(style['CONN_B']) + ", 'i');\n")
L.append("/** Check 3, stock filler (It is worth noting that, ...). */\nexport const STOCK_RE = new RegExp(" + js_str(style['STOCK_RE']) + ", 'gi');\n")
for k, doc in [('LABEL_NUM_RE', 'Numbers that are labels (Fig. 3, Sec. II, Run 2), removed before the number test.'),
               ('YEAR_RE', 'Years, removed before the number test.'),
               ('NUM_TOKEN_RE', 'A numeral.'),
               ('SPELLED_NUM_RE', 'A spelled-out quantity (three, twice, factor of, percent, ...).'),
               ('STAT_RE', 'Statistics words that license *significant*.'),
               ('STAT_CS_RE', 'CL / CLs (case-sensitive).'),
               ('IT_PASSIVE_RE', 'It was found that ... (check 10).'),
               ('IN_ORDER_RE', 'in order to / in order for (check 3).')]:
    pat, ci = style[k]
    L.append("/** " + doc + " */\nexport const " + k + " = new RegExp(" + js_str(pat) + ", '" + ('gi' if ci else 'g') + "');\n")
inf = ',\n'.join('  [' + js_str(p) + ', ' + js_str(a) + ']' for p, a in style['INFLATED'])
L.append("/** Check 4, inflated words and phrases: [pattern, plain alternative]. */\nexport const INFLATED: ReadonlyArray<readonly [string, string]> = [\n" + inf + ",\n];\n")
hy = ',\n'.join('  [' + js_str(p) + ', ' + js_str(k) + ', ' + js_str(a) + ']' for p, k, a in style['HYPE'])
L.append("""/**
 * Check 5, hype and intensifiers: [pattern, kind, alternative]. Kinds: `always` (flag on sight),
 * `comparative` (not after more/less/as), `number` (not in a sentence with a number), `stat` (not in a
 * sentence with a number or a statistics word).
 */
export const HYPE: ReadonlyArray<readonly [string, 'always' | 'comparative' | 'number' | 'stat', string]> = [
""" + hy + ",\n];\n")
open(outdir + '/styleCheckLists.ts', 'w').write('\n'.join(L))

# excess vocabulary
rows = sorted(exc, key=lambda e: e['word'])
lines = []
for e in rows:
    lines.append(f"  [{js_str(e['word'])}, {e['ratio']:.1f}, {e['gap']}, {js_str(e['pos'])}],")
E = f"""/**
 * Excess style vocabulary of 2024, from Kobak, Gonzalez-Marquez, Horvat and Lause, "Delving into LLM-assisted
 * writing in biomedical publications through excess vocabulary", Sci. Adv. 11, eadt3813 (2025), with data and
 * code at github.com/berenslab/llm-excess-vocab (MIT licence, copyright (c) 2024 Dmitry Kobak, Rita
 * Gonzalez-Marquez; see packages/core/THIRD_PARTY.md). Commit {commit}.
 *
 * Rows: [word, r, delta, part of speech]. The word list is the set of 2024 excess words that the authors
 * annotated as `style` in results/excess_words.csv ({len(rows)} words). r (excess frequency ratio) and delta
 * (excess frequency gap) are the paper's own definitions, recomputed exactly as its notebook
 * scripts/03-figures.ipynb (`compute_excess(2024)`) does from results/yearly-counts.csv.gz:
 *   p = (count + 1) / (abstracts + 1),  q = p2022 + max(p2022 - p2021, 0) * 2,  r = p2024 / q,  delta = p2024 - q.
 * The recomputation reproduces every value the notebook prints (delves 28.0, showcasing 10.7,
 * underscores 13.8, potential 1.3, findings 1.3, crucial 2.1). r is rounded to 0.1 and delta to 1e-4.
 * Words are lower-case PubMed abstract tokens (letters only, 4 or more letters).
 *
 * GENERATED by regenerate.py (this directory); do not edit by hand.
 */
export const KOBAK_SOURCE = 'Kobak et al., Sci. Adv. 11, eadt3813 (2025); github.com/berenslab/llm-excess-vocab@{commit[:7]}';

export const KOBAK_2024_STYLE: ReadonlyArray<readonly [word: string, ratio: number, gap: number, pos: string]> = [
""" + '\n'.join(lines) + "\n];\n"
E += """
/**
 * Inflections of flagged words (see FLAG RULE in ../aiese.ts) that the paper could not measure: they occur in
 * PubMed but fall below its 1e-4 frequency cutoff in 2023 or 2024, so it reports no ratio for them. Kept only
 * when their 2024 frequency is at least twice the paper's projection (computed as above), so plain forms that
 * merely share a stem (aid, promised) are not flagged. Their ratio is unknown (null in EXCESS_VOCAB).
 * Rows: [form, listed word it inflects].
 */
export const KOBAK_UNMEASURED_INFLECTIONS: ReadonlyArray<readonly [form: string, of: string]> = [
""" + '\n'.join(f"  [{js_str(k)}, {js_str(v)}]," for k, v in sorted(infl.items())) + "\n];\n"
open(outdir + '/excessVocab.ts', 'w').write(E)
