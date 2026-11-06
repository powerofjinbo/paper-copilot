import { describe, expect, it } from 'vitest';
import type { Fact, GateContext, GateIssue, GateResult } from '@paper-copilot/core';
import type { PostToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { createGateHook, DraftCollector, MAX_PARAGRAPH_ATTEMPTS, PROPOSE_TOOL, provisionalResult, type Verdict } from '../src/services/agents/collector';
import { editorHandlers, factLine } from '../src/services/agents/editor';
import { emptyOutline } from '@paper-copilot/core';

/** Deterministic stand-in for core gateSentence: numbers must be fact aliases, cites must be allowed. */
export function stubGate(text: string, c: GateContext): GateResult {
  const issues: GateIssue[] = [];
  let repaired = text;
  const factIds: string[] = [];
  const citeKeys: string[] = [];
  let scan = text.replace(/\\(?:ref|eqref|label)\{[^}]*\}/g, ' ');
  for (const m of text.matchAll(/\\cite\{([^}]*)\}/g)) {
    scan = scan.replace(m[0], ' ');
    const keys = m[1]!.split(',').map((k) => k.trim());
    const bad = keys.filter((k) => !c.allowedCiteKeys.includes(k));
    citeKeys.push(...keys.filter((k) => c.allowedCiteKeys.includes(k)));
    if (bad.length) {
      issues.push({ code: 'unknown_cite', severity: 'block', message: `unknown cite ${bad.join(',')}`, raw: m[0] });
      repaired = repaired.replace(m[0], '[ref]');
    }
  }
  for (const f of c.facts) {
    for (const a of f.aliases) {
      if (scan.includes(a)) {
        factIds.push(f.id);
        scan = scan.split(a).join(' ');
      }
    }
  }
  scan = scan.replace(/\[[^\]]*\?[^\]]*\]/g, ' ');
  for (const m of scan.matchAll(/\d+(?:[.,]\d+)*/g)) {
    if (c.intentText?.includes(m[0])) continue;
    issues.push({ code: 'unmatched_number', severity: 'block', message: `${m[0]} matches no fact`, raw: m[0] });
    repaired = repaired.replace(m[0], '[fact?: number]');
  }
  if (!text.trim()) issues.push({ code: 'empty', severity: 'block', message: 'empty' });
  const placeholders = [...repaired.matchAll(/\[(?:fact\?|ref)[^\]]*\]/g)].map((m) => m[0]);
  return { ok: !issues.some((i) => i.severity === 'block'), issues, repaired, factIds, citeKeys, unlinked: [], placeholders };
}

const delta: Fact = {
  id: 'f.delta', kind: 'number', value: 2.319, sigfigs: null, unit: 'points', uncertainties: {}, definition: 'd', definitionSource: 'm', artifact: 'a.json', locator: '#/d',
  artifactSha256: 's', fingerprint: 'f', stale: false, validationState: 'candidate', aliases: ['2.32 points'], confirmed: false, excluded: false, proseOnly: false, tags: [],
};

const env = () => ({ facts: [delta], allowedCiteKeys: ['Good2020'], knownLabels: [], fictionalNumbers: [] });

const make = () =>
  new DraftCollector(
    [
      { pid: 'p1', job: 'State the gain', intentNotes: [] },
      { pid: 'p2', job: '', intentNotes: ['增益是 3.1 点'] },
    ],
    env,
    stubGate,
  );

const s = (text: string, extra: Record<string, unknown> = {}) => ({ text, fact_ids: [], cite_keys: [], placeholders: [], note_zh: null, referee_question: null, move: null, ...extra });

describe('DraftCollector', () => {
  it('accepts a clean paragraph atomically with gate-linked facts', () => {
    const c = make();
    const v = c.propose({ pid: 'p1', job: 'x', sentences: [s('We find a gain of 2.32 points.', { fact_ids: ['f.delta'], note_zh: '说明' }), s('It holds for every species~\\cite{Good2020}.')] });
    expect(v.status).toBe('accepted');
    expect(v.message).toMatch(/accepted with 2 sentences.*p2/);
    expect(v.paragraph).toMatchObject({ pid: 'p1', job: 'State the gain' });
    expect(v.paragraph!.sentences.map((x) => x.state)).toEqual(['proposed', 'proposed']);
    expect(v.paragraph!.sentences[0]).toMatchObject({ factIds: ['f.delta'], noteZh: '说明', issues: [] });
    expect(v.paragraph!.sentences[1]!.citeKeys).toEqual(['Good2020']);
    expect(c.remaining()).toEqual(['p2']);
  });

  it('asks for a retry, then keeps a sentence that failed twice as unsupported with a placeholder', () => {
    const c = make();
    const bad = s('The gain reaches 7.77 points.');
    const v1 = c.propose({ pid: 'p1', job: 'x', sentences: [s('We find 2.32 points.'), bad] });
    expect(v1.status).toBe('retry');
    expect(v1.failing).toEqual([{ index: 1, repaired: 'The gain reaches [fact?: number] points.', codes: ['unmatched_number'] }]);
    expect(v1.message).toContain('Sentence 2');
    expect(v1.message).toContain('unmatched_number');
    expect(v1.message).toContain('pid "p1"');
    const v2 = c.propose({ pid: 'p1', job: 'x', sentences: [s('We find 2.32 points.'), bad] });
    expect(v2.status).toBe('accepted');
    const kept = v2.paragraph!.sentences[1]!;
    expect(kept.state).toBe('unsupported');
    expect(kept.text).toBe('The gain reaches [fact?: number] points.');
    expect(kept.issues[0]).toMatchObject({ code: 'unmatched_number', severity: 'block', raw: '7.77' });
    expect(kept.placeholders).toEqual(['[fact?: number]']);
    expect(v2.paragraph!.sentences[0]!.state).toBe('proposed');
  });

  it('accepts the retry when the model fixes the sentence', () => {
    const c = make();
    expect(c.propose({ pid: 'p1', sentences: [s('Cited~\\cite{Bad1999}.')] }).status).toBe('retry');
    const v = c.propose({ pid: 'p1', sentences: [s('Cited~\\cite{Good2020}.')] });
    expect(v.status).toBe('accepted');
    expect(v.paragraph!.sentences[0]!.state).toBe('proposed');
  });

  it('closes a paragraph after the attempt cap even when different sentences keep failing', () => {
    const c = make();
    const attempts = [
      [s('A 1.11 x.'), s('Fine.')],
      [s('Fine.'), s('A 2.22 x.')],
      [s('A 3.33 x.'), s('Fine.')],
    ];
    const vs: Verdict[] = attempts.map((a) => c.propose({ pid: 'p1', sentences: a }));
    expect(vs.map((v) => v.status)).toEqual(['retry', 'retry', 'accepted']);
    expect(MAX_PARAGRAPH_ATTEMPTS).toBe(3);
    expect(vs[2]!.paragraph!.sentences.map((x) => x.state)).toEqual(['unsupported', 'proposed']);
  });

  it('lets numbers typed in the intent notes through and uses the model job only when the plan has none', () => {
    const c = make();
    const v = c.propose({ pid: 'p2', job: 'Model job', sentences: [s('The gain is 3.1 points.')] });
    expect(v.status).toBe('accepted');
    expect(v.paragraph!.job).toBe('Model job');
  });

  it('refuses unknown, already accepted, malformed and empty proposals without counting attempts', () => {
    const c = make();
    expect(c.propose({ pid: 'p9', sentences: [s('x.')] })).toMatchObject({ status: 'refused', pid: 'p9' });
    expect(c.propose({ nope: true }).status).toBe('refused');
    expect(c.propose({ pid: 'p1', sentences: [s('   ')] }).message).toMatch(/no sentences/);
    expect(c.propose({ pid: 'p1', sentences: [s('Ok.')] }).status).toBe('accepted');
    expect(c.propose({ pid: 'p1', sentences: [s('Again.')] }).message).toMatch(/already accepted/);
    expect(c.paragraphs()).toHaveLength(1);
  });

  it('returns paragraphs in outline order and judges proposals whose hook never ran', () => {
    const c = make();
    c.recordPending('t1', { pid: 'p2', sentences: [s('Second 9.99 x.')] });
    c.propose({ pid: 'p1', sentences: [s('First.')] });
    c.finalize();
    expect(c.paragraphs().map((p) => p.pid)).toEqual(['p1', 'p2']);
    expect(c.paragraphs()[1]!.sentences[0]!.state).toBe('unsupported'); // judged as a final attempt
    expect(c.done()).toBe(true);
  });
});

describe('gate hook and editor tools', () => {
  const hookInput = (input: unknown, id = 'tu1', tool = PROPOSE_TOOL): PostToolUseHookInput => ({
    hook_event_name: 'PostToolUse', session_id: 's', transcript_path: '', cwd: '/', tool_name: tool, tool_input: input, tool_response: [{ type: 'text', text: 'provisional' }], tool_use_id: id,
  });
  const signal = new AbortController().signal;

  it('replaces the provisional tool result with the gate verdict (updatedToolOutput)', async () => {
    const c = make();
    const verdicts: Verdict[] = [];
    const hook = createGateHook(c, (v) => verdicts.push(v));
    const h = editorHandlers({ outline: emptyOutline, facts: () => [delta], sentences: () => [], allowedKeys: () => [], litRecord: () => undefined, collector: c });
    const input = { pid: 'p1', job: 'j', sentences: [s('A 5.55 x.')] };
    expect(h.propose_paragraph(input, 'tu1')).toBe(provisionalResult(input));
    const out = (await hook(hookInput(input), 'tu1', { signal })) as SyncHookJSONOutput;
    const spec = out.hookSpecificOutput as { hookEventName: string; updatedToolOutput: Array<{ type: string; text: string }> };
    expect(spec.hookEventName).toBe('PostToolUse');
    expect(spec.updatedToolOutput[0]!.type).toBe('text');
    expect(spec.updatedToolOutput[0]!.text).toMatch(/NOT accepted/);
    expect(verdicts.map((v) => v.status)).toEqual(['retry']);
    // The pending entry was taken by the hook (it is not judged again as a pending proposal); the run
    // ended before the fix, so finalize closes the paragraph once from its last proposal: the failing
    // sentence is kept as unsupported with a placeholder, not dropped with the paragraph.
    c.finalize();
    expect(c.log.map((l) => l.status)).toEqual(['retry', 'accepted']);
    expect(c.paragraphs().map((p) => p.sentences.map((x) => x.state))).toEqual([['unsupported']]);
    expect(c.paragraphs()[0]!.sentences[0]!.text).not.toContain('5.55');
    c.finalize();
    expect(c.log).toHaveLength(2);
    expect(await hook(hookInput(input, 'tu2', 'mcp__editor__get_facts'), 'tu2', { signal })).toEqual({});
  });

  it('serves facts with their renderings and refuses unknown cite keys', () => {
    const c = make();
    const h = editorHandlers({
      outline: emptyOutline,
      facts: () => [delta],
      sentences: () => [{ id: 'u1', text: 'Old.', state: 'human', paragraphId: 'sec:r/p0', move: null }],
      allowedKeys: () => [{ key: 'Good2020', title: 'Good paper' }],
      litRecord: (k) => (k === 'Good2020' ? { key: k, status: 'resolved', texkey: k, recid: 1, arxiv: null, doi: null, title: 'Good paper', authors: 'A', year: 2020, abstract: 'abs', quotable: [], usableFor: [], source: 'inspire' } : undefined),
      collector: c,
    });
    const facts = JSON.parse(h.get_facts({ query: 'gain' }));
    expect(facts.facts[0]).toMatchObject({ id: 'f.delta', aliases: ['2.32 points'] });
    expect(factLine(delta).rendering).toContain('f.delta');
    expect(h.lookup_cite({ key: 'Missing' })).toMatch(/\[ref\]/);
    expect(JSON.parse(h.lookup_cite({ key: 'Good2020' })).allowed).toBe(true);
    expect(JSON.parse(h.get_sentences({ section_id: 'sec:r' }))[0].id).toBe('u1');
    expect(h.get_plan({ section_id: 'nope' })).toMatch(/Unknown section/);
    expect(JSON.parse(h.get_lit()).keys).toEqual([{ key: 'Good2020', title: 'Good paper' }]);
  });
});
