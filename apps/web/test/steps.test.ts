/**
 * The four-step information architecture: step/section mapping of the older panel names, the merged
 * To-do list, badges, the submission status, the first-run flag with blocked storage, report navigation
 * indexes, and the store's normalization of setLeftTab (older names -> step + section; 'voice' -> Settings).
 */
import { describe, expect, it } from 'vitest';
import type { RefereeQuestion, SentenceUnit, SubmissionReport } from '@paper-copilot/core';
import { buildTodo, firstRunSeen, markFirstRunSeen, openTodoCount, orderSubmissionItems, otherFileTodo, sectionOf, stepOf, submissionStatus } from '../src/components/steps';
import { refIndex } from '../src/panels/check/refs';
import { splitLit } from '../src/panels/LiteraturePanel';
import { useShell } from '../src/state/extra';
import { useWorkspace } from '../src/state/store';
import { MESSAGES, codeLabel, translate } from '../src/i18n';
import type { ProjectFileInfo } from '../src/contracts';

function unit(id: string, start: number, state: SentenceUnit['state'], placeholders: string[] = [], sectionId = 'intro'): SentenceUnit {
  return {
    id,
    file: 'main.tex',
    start,
    end: start + 10,
    line: 1 + start / 10,
    kind: 'prose',
    part: 'body',
    sectionId,
    paragraphId: `${sectionId}/p1`,
    textNorm: id,
    hashNorm: id,
    state,
    everAi: state !== 'human',
    imported: false,
    model: null,
    facts: [],
    cites: [],
    placeholders,
    move: null,
    intentNote: null,
    acceptedAt: null,
    orphaned: false,
  } as unknown as SentenceUnit;
}

const q = (id: string, sectionId: string): RefereeQuestion => ({ id, sectionId, sentenceId: null, question: `q ${id}`, estimate: null });

describe('steps', () => {
  it('maps every older panel name to its step and section', () => {
    expect(stepOf('outline')).toBe('plan');
    expect(stepOf('facts')).toBe('sources');
    expect(stepOf('review')).toBe('todo');
    expect(stepOf('placeholders')).toBe('todo');
    expect(stepOf('questions')).toBe('todo');
    expect(stepOf('sync')).toBe('check');
    expect(stepOf('voice')).toBeNull();
    for (const s of ['plan', 'sources', 'todo', 'check'] as const) expect(stepOf(s)).toBe(s);
    expect(sectionOf('sync')).toBe('sync');
    expect(sectionOf('check')).toBeNull();
  });

  it('builds one To-do list: review and placeholders in document order, questions in section order', () => {
    const units = [unit('c', 30, 'human', ['[ref]']), unit('a', 0, 'proposed'), unit('b', 10, 'unsupported', ['[fact?: x]', '[claim: y?]']), unit('d', 40, 'ai-drafted')];
    const groups = buildTodo(units, [q('2', 'results'), q('1', 'intro'), q('3', 'zzz')], (p) => (p.startsWith('[fact') ? 'fact' : p.startsWith('[claim') ? 'claim' : 'ref'), ['intro', 'results']);
    expect(groups.map((g) => g.kind)).toEqual(['review', 'placeholders', 'questions']);
    expect(groups[0]!.items.map((i) => i.key)).toEqual(['r:a', 'r:b']);
    expect(groups[1]!.items.map((i) => i.key)).toEqual(['p:b:0', 'p:b:1', 'p:c:0']);
    expect(groups[1]!.items.map((i) => (i.kind === 'placeholder' ? i.phKind : null))).toEqual(['fact', 'claim', 'ref']);
    expect(groups[2]!.items.map((i) => i.key)).toEqual(['q:1', 'q:2', 'q:3']);
    expect(openTodoCount(units)).toBe(2 + 3);
  });

  it('lists open items of the other files only', () => {
    const f = (file: string, proposed: number, unsupported: number, placeholders: number): ProjectFileInfo => ({ file, main: file === 'main.tex', parent: null, depth: 0, included: true, appendix: false, open: true, units: 10, proposed, unsupported, placeholders, aiTouched: 0 });
    expect(otherFileTodo([f('main.tex', 3, 0, 1), f('a.tex', 0, 0, 0), f('b.tex', 1, 2, 4)], 'main.tex')).toEqual([{ file: 'b.tex', review: 3, placeholders: 4 }]);
  });

  it('derives the submission status and orders blockers first', () => {
    const item = (id: string, ok: boolean, severity: 'block' | 'warn' | 'info') => ({ id, ok, severity, count: ok ? 0 : 2, items: [], note: null }) as unknown as SubmissionReport['items'][number];
    const r = (items: SubmissionReport['items']): SubmissionReport => ({ ok: !items.some((i) => !i.ok && i.severity === 'block'), blockers: 0, warnings: 0, items });
    expect(submissionStatus(null).tone).toBe('unknown');
    expect(submissionStatus(r([item('unreviewed', true, 'block'), item('lint_warnings', false, 'info')]))).toEqual({ tone: 'ready', issues: 0, blockers: 0 });
    expect(submissionStatus(r([item('echo_drift', false, 'warn')]))).toEqual({ tone: 'issues', issues: 1, blockers: 0 });
    const mixed = r([item('lint_warnings', false, 'info'), item('echo_drift', false, 'warn'), item('unreviewed', true, 'block'), item('placeholders', false, 'block')]);
    expect(submissionStatus(mixed)).toEqual({ tone: 'blocked', issues: 2, blockers: 1 });
    expect(orderSubmissionItems(mixed).map((i) => i.id)).toEqual(['placeholders', 'echo_drift', 'lint_warnings', 'unreviewed']);
  });

  it('remembers the first-run hint and survives blocked storage', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(firstRunSeen(store)).toBe(false);
    markFirstRunSeen(store);
    expect(firstRunSeen(store)).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(firstRunSeen(throwing)).toBe(false);
    expect(() => markFirstRunSeen(throwing)).not.toThrow();
  });

  it('indexes report sentence refs by id for cross-file navigation', () => {
    const report = { flags: [{ sentenceIds: ['s2'] }], quantities: [{ occurrences: [{ sentenceId: 's1', file: 'a.tex', line: 3 }, { sentenceId: 's2', file: 'sections/b.tex', line: 9 }] }], contribution: { sentenceId: 's1', file: 'other.tex', line: 1 } };
    const idx = refIndex(report);
    expect(idx.get('s2')).toEqual({ file: 'sections/b.tex', line: 9 });
    expect(idx.get('s1')).toEqual({ file: 'a.tex', line: 3 });
    expect(idx.size).toBe(2);
  });

  it('puts unresolved literature first', () => {
    const rec = (key: string, status: 'resolved' | 'unresolved' | 'user_confirmed') => ({ key, status }) as never;
    const s = splitLit([rec('b', 'resolved'), rec('z', 'unresolved'), rec('a', 'user_confirmed'), rec('c', 'unresolved')]);
    expect(s.unresolved.map((r: { key: string }) => r.key)).toEqual(['c', 'z']);
    expect(s.usable.map((r: { key: string }) => r.key)).toEqual(['a', 'b']);
  });
});

describe('store normalization', () => {
  it('turns older panel names into a step plus a section request; voice opens Settings', () => {
    const ws = useWorkspace.getState();
    ws.setLeftTab('sync');
    expect(useWorkspace.getState().leftTab).toBe('check');
    expect(useShell.getState().focus?.section).toBe('sync');
    ws.setLeftTab('review');
    expect(useWorkspace.getState().leftTab).toBe('todo');
    expect(useShell.getState().focus?.section).toBe('review');
    const before = useWorkspace.getState().leftTab;
    ws.setLeftTab('voice');
    expect(useWorkspace.getState().leftTab).toBe(before);
    expect(useShell.getState().settingsOpen).toBe(true);
    useShell.getState().setSettingsOpen(false);
    ws.setLeftTab('facts');
    expect(useShell.getState().sourcesTab).toBe('facts');
  });
});

describe('i18n of the new surfaces', () => {
  it('labels every step in both languages and reads core code labels in the UI language', () => {
    for (const k of ['step.plan', 'step.sources', 'step.todo', 'step.check'] as const) {
      expect(MESSAGES.en[k]).not.toBe(MESSAGES.zh[k]);
    }
    expect(MESSAGES.zh['step.plan']).toBe('构思');
    expect(MESSAGES.zh['step.todo']).toBe('待办');
    expect(codeLabel('en', 'submission.unreviewed')).toBe('Unreviewed AI sentences');
    expect(codeLabel('zh', 'submission.unreviewed')).toBe('未审阅的 AI 句子');
    expect(codeLabel('zh', 'consistency.drift_precision')).toBe('精度不一致');
    expect(codeLabel('en', 'gate.unmatched_number')).toBe('Number not in the facts');
    expect(codeLabel('en', 'no.such.code')).toBe('no.such.code');
    expect(translate('en', 'top.submitIssues', { n: 1 })).toBe('1 issue');
    expect(translate('en', 'check.blockers', { n: 1 })).toBe('1 blocker');
  });
});
