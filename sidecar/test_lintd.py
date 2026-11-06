#!/usr/bin/env python3
'''Tests for lintd.py (stdlib unittest). Run: python3 -m unittest sidecar/test_lintd.py -v

Every test spawns the real daemon. All tests are skipped when the hep-paper-writing skill is not found.
'''
import json
import os
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LINTD = os.path.join(HERE, 'lintd.py')
FIXTURE = os.path.join(ROOT, 'fixtures', 'canto-demo', 'tex', 'main.tex')
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
import lintd  # noqa: E402  (only its locate() is used here; the daemon itself runs as a subprocess)


def find_skill():
    try:
        path = lintd.locate(os.environ.get('PAPER_SKILL_DIR') or None)
    except lintd.StartError:
        return None
    return os.path.dirname(os.path.dirname(path)) if os.path.basename(os.path.dirname(path)) == 'scripts' \
        else os.path.dirname(path)


SKILL = find_skill()


class Daemon:
    def __init__(self, *extra, env=None):
        self.p = subprocess.Popen([sys.executable, '-B', LINTD] + list(extra), stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        self.ready = json.loads(self.p.stdout.readline().decode('utf-8'))
        self.n = 0

    def raw(self, line):
        self.p.stdin.write(line.encode('utf-8') + b'\n')
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline().decode('utf-8'))

    def req(self, cmd, **kw):
        self.n += 1
        r = self.raw(json.dumps(dict(id=self.n, cmd=cmd, **kw)))
        assert r['id'] == self.n, r
        return r

    def close(self):
        if self.p.poll() is None:
            try:
                self.req('shutdown')
            except Exception:
                pass
            try:
                self.p.wait(5)
            except subprocess.TimeoutExpired:
                self.p.kill()
        for f in (self.p.stdin, self.p.stdout, self.p.stderr):
            try:
                f.close()
            except Exception:
                pass


def read_bytes(path):
    with open(path, 'rb') as f:
        return f.read()


def lint(d, text, part='body', **kw):
    r = d.req('lint.sentences', items=[dict(sid='s1', text=text, part=part)], **kw)
    assert r['ok'], r
    return r['flags']


def keys(flags):
    return {f['key'] for f in flags}


@unittest.skipIf(SKILL is None, 'hep-paper-writing skill not found')
class LintdTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = Daemon('--skill-dir', SKILL)

    @classmethod
    def tearDownClass(cls):
        cls.d.close()

    # -- start --------------------------------------------------------------------------------
    def test_ready_line(self):
        r = self.d.ready
        self.assertTrue(r['ready'])
        self.assertTrue(r['style_check'].endswith('style_check.py'))
        self.assertTrue(os.path.isfile(r['style_check']))
        self.assertRegex(r['version'], r'^[0-9a-f]{12}$')

    def test_ping(self):
        r = self.d.req('ping')
        self.assertEqual(r, dict(id=r['id'], ok=True, pong=True, version=self.d.ready['version']))

    # -- lint.sentences -----------------------------------------------------------------------
    def test_long_sentence(self):
        text = ' '.join(['the tracker finds the particle'] * 10) + '.'      # 50 words
        flags = lint(self.d, text)
        self.assertIn('long', keys(flags))
        f = [f for f in flags if f['key'] == 'long'][0]
        self.assertEqual(f['check'], 1)
        self.assertTrue(f['msg'].startswith('50 words'))
        self.assertIsNone(f['word'])
        self.assertEqual(f['sid'], 's1')
        self.assertNotIn('long', keys(lint(self.d, text, max_words=60)))

    def test_vocab_and_hype(self):
        flags = lint(self.d, 'We utilize a novel method.')
        by = {f['key']: f for f in flags}
        self.assertEqual(by['vocab']['word'], 'utilize')
        self.assertEqual(by['vocab']['check'], 4)
        self.assertEqual(by['hype']['word'], 'novel')
        self.assertEqual(by['hype']['check'], 5)
        self.assertEqual(by['vocab']['excerpt'], 'We utilize a novel method.')

    def test_connectors(self):
        flags = lint(self.d, 'Moreover, the tracker finds more particles in order to beat the baseline.')
        words = {f['word'] for f in flags if f['key'] == 'connectors'}
        self.assertEqual(words, {'Moreover', 'in order to'})
        self.assertTrue(all(f['check'] == 3 for f in flags if f['key'] == 'connectors'))

    def test_late_verb(self):
        s = ('By measuring the energy and momentum of the HNL decay products at FASER2 using only this '
             'fully-visible decay mode, we show that the HNL mass and coupling can be constrained.')
        self.assertIn('verb', keys(lint(self.d, s)))
        self.assertNotIn('verb', keys(lint(self.d, s, part='caption')))      # check 2 skips captions

    def test_it_passive_is_sentence_local(self):
        flags = lint(self.d, 'It is found that the rate is 0.55\\% against 1.38\\%~\\cite{x}.')
        self.assertEqual([f['word'] for f in flags if f['key'] == 'passive'], ['It is found that'])

    def test_doc_level_flags_dropped(self):
        # Two CONN_B openers in a row and an all-passive abstract are document-level; neither may appear.
        items = [dict(sid='a%d' % k, text='Therefore, the cut was applied.', part='abstract') for k in range(4)]
        r = self.d.req('lint.sentences', items=items)
        self.assertTrue(r['ok'])
        self.assertEqual(r['flags'], [])
        flags = lint(self.d, 'Therefore, we go. Therefore, we stop.')
        self.assertEqual(flags, [])

    def test_fixture_sentences_clean_and_flagged(self):
        clean = [
            'Searches for long-lived particles look for tracks that do not point back to the beam line~\\cite{Ju2022Zenodo}.',
            'A target particle has $p_T > 1$~GeV, $|\\eta| < 4$ and at least five space points.',
            'The test set holds 8,710 targets.',
        ]
        items = [dict(sid='c%d' % k, text=t, part='body') for k, t in enumerate(clean)]
        items.append(dict(sid='bad', text='We leverage a very powerful paradigm.', part='intro'))
        r = self.d.req('lint.sentences', items=items, known=['GeV'])
        self.assertTrue(r['ok'])
        self.assertEqual({f['sid'] for f in r['flags']}, {'bad'})
        self.assertEqual({f['word'] for f in r['flags']}, {'leverage', 'very', 'powerful', 'paradigm'})

    def test_caption_and_footnote_parts(self):
        f = lint(self.d, 'Solid: the remarkably new tracker; dashed: acorn.', part='caption')
        self.assertIn('hype', keys(f))
        f = lint(self.d, 'The bootstrap utilizes one fixed list.', part='footnote')
        self.assertIn('vocab', keys(f))
        f = lint(self.d, 'We utilize it.', part='no-such-part')      # unknown part reads as body
        self.assertIn('vocab', keys(f))

    def test_preamble_macros(self):
        r = self.d.req('lint.sentences', items=[dict(sid='m', text='We \\use the \\ttbar{} sample.', part='body')],
                       preamble='\\newcommand{\\use}{utilize}\\newcommand{\\ttbar}{\\ensuremath{t\\bar{t}}}')
        self.assertTrue(r['ok'])
        self.assertIn('vocab', keys(r['flags']))

    def test_empty_and_odd_items(self):
        r = self.d.req('lint.sentences', items=[])
        self.assertEqual(r['flags'], [])
        r = self.d.req('lint.sentences', items=[dict(sid='e', text='', part='body'),
                                                dict(sid='m', text='$x = 1$', part='body'),
                                                dict(sid='u', text='Ünïcødé, very short text — with “quotes” and 中文.', part='body'),
                                                dict(sid=7, text='We utilize it.', part='body')])
        self.assertTrue(r['ok'])
        self.assertEqual([f['sid'] for f in r['flags']], ['u', '7'])

    def test_order_is_item_order(self):
        items = [dict(sid='z', text='We utilize a novel method.', part='body'),
                 dict(sid='a', text='Moreover, it works.', part='body')]
        r = self.d.req('lint.sentences', items=items)
        self.assertEqual([f['sid'] for f in r['flags']], ['z', 'z', 'a'])
        self.assertEqual(r, self.d.req('lint.sentences', items=items) | dict(id=r['id']))

    def test_thousand_sentences_fast(self):
        with open(FIXTURE, encoding='utf-8') as f:
            lines = [l for l in f.read().split('\n') if l and not l.startswith(('\\', '%', ' '))]
        lines.append('We utilize a novel method.')
        items = [dict(sid=str(k), text=lines[k % len(lines)], part=['body', 'intro', 'abstract', 'caption'][k % 4])
                 for k in range(1000)]
        t = time.time()
        r = self.d.req('lint.sentences', items=items)
        dt = time.time() - t
        self.assertTrue(r['ok'])
        self.assertNotIn('errors', r)
        self.assertGreater(len(r['flags']), 0)
        self.assertLess(dt, 2.0, '1,000 sentences took %.2f s' % dt)

    # -- lint.document ------------------------------------------------------------------------
    def test_lint_document_fixture(self):
        with open(FIXTURE, encoding='utf-8') as f:
            tex = f.read()
        r = self.d.req('lint.document', text=tex)
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['words'], 366)
        self.assertEqual(r['sentences'], 26)
        self.assertEqual(set(r['rates']), {'long', 'verb', 'connectors', 'vocab', 'hype', 'vague', 'acronyms',
                                           'terms', 'figures', 'passive'})
        self.assertEqual(r['reference_rates']['long'], 3.3)
        acr = [f for f in r['flags'] if f['key'] == 'acronyms']
        self.assertEqual(len(acr), 1)
        self.assertEqual(acr[0]['word'], 'HNL')
        self.assertEqual(acr[0]['line'], 49)
        self.assertEqual(acr[0]['part'], 'body')
        self.assertIsInstance(acr[0]['sent_index'], int)
        self.assertIn('acorn (HNL)', acr[0]['excerpt'])
        fig = [f for f in r['flags'] if f['key'] == 'figures']
        self.assertTrue(fig and 'app:val' in fig[0]['msg'])
        for f in r['flags']:
            self.assertEqual(set(f), {'check', 'key', 'line', 'part', 'excerpt', 'msg', 'word', 'sent_index'})
        # --known silences the acronym flag
        r2 = self.d.req('lint.document', text=tex, known=['HNL'])
        self.assertFalse([f for f in r2['flags'] if f['key'] == 'acronyms'])

    def test_lint_document_matches_cli(self):
        with open(FIXTURE, encoding='utf-8') as f:
            tex = f.read()
        cli = subprocess.run([sys.executable, '-B', self.d.ready['style_check'], FIXTURE, '--json'],
                             capture_output=True, text=True, check=True)
        ref = json.loads(cli.stdout)
        r = self.d.req('lint.document', text=tex)
        want = [(int(k), f['line'], f['msg']) for k, c in ref['checks'].items() for f in c['flags']]
        got = [(f['check'], f['line'], f['msg']) for f in r['flags']]
        self.assertEqual(sorted(got), sorted(want))
        self.assertEqual(r['words'], ref['words'])

    def test_lint_document_bad_flags(self):
        tex = ('\\documentclass{article}\\begin{document}\\begin{abstract}It was found that the cut was applied. '
               'The fit was done. The data were taken. The plots were made.\\end{abstract}'
               '\\section{Introduction}Moreover, we utilize a novel method.\\end{document}')
        r = self.d.req('lint.document', text=tex)
        ks = keys(r['flags'])
        self.assertTrue({'passive', 'connectors', 'vocab', 'hype'} <= ks, ks)
        ab = [f for f in r['flags'] if f['msg'].startswith('The abstract has a passive')]
        self.assertEqual(len(ab), 1)
        self.assertIsNone(ab[0]['word'])
        self.assertEqual(r['rates']['vocab'], round(1000.0 / r['words'], 2))

    def test_lint_document_empty(self):
        r = self.d.req('lint.document', text='')
        self.assertTrue(r['ok'])
        self.assertEqual((r['flags'], r['words'], r['sentences']), ([], 0, 0))

    # -- corpus.stats -------------------------------------------------------------------------
    def test_corpus_stats(self):
        texts = ['We measure the rate. The rate is shown in Fig. 1. We find 12 events.',
                 'The detector was built in 2010. We use it.']
        r = self.d.req('corpus.stats', texts=texts, fmt='txt')
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['texts'], 2)
        self.assertEqual(r['sentences'], 5)
        for k in ('median_length', 'mean_length', 'p90_length', 'passive_share', 'we_per_1k',
                  'median_verb_position', 'length_by_part', 'passive_by_part', 'corpus'):
            self.assertIn(k, r)
        self.assertAlmostEqual(r['passive_share'], 0.4)
        with open(FIXTURE, encoding='utf-8') as f:
            r = self.d.req('corpus.stats', texts=[f.read()], fmt='tex')
        self.assertEqual(r['words'], 366)
        r = self.d.req('corpus.stats', texts=[])
        self.assertTrue(r['ok'])
        self.assertIsNone(r['median_length'])

    # -- errors -------------------------------------------------------------------------------
    def test_errors_keep_process_alive(self):
        r = self.d.raw('this is not json')
        self.assertEqual((r['id'], r['ok']), (None, False))
        r = self.d.raw('[1, 2]')
        self.assertFalse(r['ok'])
        self.assertFalse(self.d.req('no.such.cmd')['ok'])
        self.assertIn('unknown cmd', self.d.req('no.such.cmd')['error'])
        self.assertFalse(self.d.req('lint.sentences', items='x')['ok'])
        self.assertFalse(self.d.req('lint.sentences', items=[dict(sid='a', text=3, part='body')])['ok'])
        self.assertFalse(self.d.req('lint.sentences', items=[], max_words=2)['ok'])
        self.assertFalse(self.d.req('lint.sentences', items=[], known=[1])['ok'])
        self.assertFalse(self.d.req('lint.document')['ok'])
        self.assertFalse(self.d.req('corpus.stats', texts=[1])['ok'])
        r = self.d.raw(json.dumps(dict(cmd='ping')))          # no id
        self.assertEqual((r['id'], r['ok']), (None, True))
        r = self.d.raw(json.dumps(dict(id='abc', cmd='ping')))
        self.assertEqual(r['id'], 'abc')
        self.assertTrue(self.d.req('ping')['pong'])
        # deeply nested braces must not crash the process
        r = self.d.req('lint.sentences', items=[dict(sid='n', text='{' * 3000 + 'x' + '}' * 3000, part='body')])
        self.assertIn('ok', r)
        self.assertTrue(self.d.req('ping')['pong'])
        self.assertIsNone(self.d.p.poll())


@unittest.skipIf(SKILL is None, 'hep-paper-writing skill not found')
class LifecycleTest(unittest.TestCase):
    def test_shutdown(self):
        d = Daemon('--skill-dir', SKILL)
        try:
            r = d.req('shutdown')
            self.assertEqual(r, dict(id=1, ok=True))
            self.assertEqual(d.p.wait(5), 0)
        finally:
            d.close()

    def test_eof_exits_zero(self):
        d = Daemon('--skill-dir', SKILL)
        try:
            d.p.stdin.close()
            self.assertEqual(d.p.wait(5), 0)
        finally:
            d.close()

    def test_env_skill_dir(self):
        env = dict(os.environ, PAPER_SKILL_DIR=SKILL)
        d = Daemon(env=env)
        try:
            self.assertTrue(d.ready['ready'])
        finally:
            d.close()

    def test_bad_skill_dir(self):
        p = subprocess.run([sys.executable, '-B', LINTD, '--skill-dir', '/nonexistent/skill'],
                           capture_output=True, text=True, timeout=10)
        self.assertNotEqual(p.returncode, 0)
        r = json.loads(p.stdout.splitlines()[0])
        self.assertFalse(r['ready'])
        self.assertIn('/nonexistent/skill', r['error'])

    def test_no_stray_output_and_no_skill_changes(self):
        script = os.path.join(SKILL, 'scripts', 'style_check.py')
        before = os.stat(script).st_mtime_ns, read_bytes(script)
        listing = sorted(os.listdir(os.path.dirname(script)))
        d = Daemon('--skill-dir', SKILL)
        try:
            d.req('lint.sentences', items=[dict(sid='a', text='We utilize it.', part='body')])
            d.req('shutdown')
            out = d.p.stdout.read()
            self.assertEqual(out, b'')
        finally:
            d.close()
        self.assertEqual((os.stat(script).st_mtime_ns, read_bytes(script)), before)
        self.assertEqual(sorted(os.listdir(os.path.dirname(script))), listing)


if __name__ == '__main__':
    unittest.main()
