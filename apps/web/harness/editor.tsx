/**
 * Editor harness: mounts <Editor> against a fake in-browser server (harness/fake) built from the
 * canto-demo fixture. Emulates the shell's store wiring (facts, outline, lint) and offers buttons for
 * a draft insert, a re-plan proposal, an external edit and a disconnect/reconnect.
 * Open: http://127.0.0.1:5174/harness/editor.html (npx vite --port 5174 in apps/web).
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../src/styles/tokens.css';
import type { EditorHandle } from '../src/contracts';
import { Editor } from '../src/editor/Editor';
import { fallbackLog } from '../src/editor/safe';
import { useEditorUi } from '../src/editor/uiStore';
import { useWorkspace } from '../src/state/store';
import { FakeApi } from './fake/fakeApi';
import raw from '../../../fixtures/canto-demo/tex/main.tex?raw';

declare global {
  interface Window {
    __pc: { api: FakeApi; store: typeof useWorkspace; ui: typeof useEditorUi; editor: EditorHandle | null; fallbacks: string[] };
  }
}

// Other agents edit packages/core while the harness runs; Vite then re-executes this module (HMR).
// Everything stateful is created once per page and kept on window, so a re-execution never builds a
// second fake server or a second React root in the middle of an e2e run.
function harnessApi(): FakeApi {
  if (window.__pc) return window.__pc.api;
  const params = new URLSearchParams(location.search);
  const api = new FakeApi(raw, { ghostDelayMs: Number(params.get('ghostMs') ?? 380), repeat: Number(params.get('big') ?? 1) });
  if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme')!;
  // What the shell does: keep the store in sync with the server.
  api.on('lint.update', (m) => useWorkspace.getState().setLint(m.flags));
  api.on('plan.updated', (m) => useWorkspace.getState().setOutline(m.outline));
  api.on('notice', (m) => useWorkspace.getState().pushNotice(m.level, m.message));
  void api.facts().then((r) => useWorkspace.getState().setFacts(r.facts, r.unresolved));
  void api.outline().then((o) => useWorkspace.getState().setOutline(o));
  useWorkspace.getState().setFile('main.tex');
  useWorkspace.getState().setConnected(true);
  window.__pc = { api, store: useWorkspace, ui: useEditorUi, editor: null, fallbacks: fallbackLog };
  return api;
}

const api = harnessApi();

function draftMessage() {
  const units = useWorkspace.getState().units;
  const anchor = units.find((u) => u.sectionId === 'sec:results' && u.kind === 'prose' && u.state === 'placeholder') ?? units.find((u) => u.sectionId === 'sec:results');
  return {
    type: 'draft.proposed' as const,
    jobId: 'job-draft-1',
    file: 'main.tex',
    afterSentenceId: anchor?.id ?? null,
    insertAt: null,
    version: api.server.version,
    paragraphs: [
      {
        pid: 'sec:results/p-draft',
        job: 'Show where the gain comes from.',
        sentences: [
          {
            text: 'The gain is largest at large transverse displacement, where the signal-trained baseline loses most targets.',
            move: 'result',
            factIds: [],
            citeKeys: [],
            placeholders: [],
            noteZh: '增益主要来自大位移区域，基线在那里丢失的目标最多。',
            refereeQuestion: 'Is the gain significant in every displacement bin?',
            state: 'proposed' as const,
            issues: [],
          },
          {
            text: 'Both trackers use the same track builder, so the difference comes from the graph stage.',
            move: 'cause',
            factIds: [],
            citeKeys: [],
            placeholders: [],
            noteZh: '两者用同一个径迹构建器，所以差别来自图神经网络这一步。',
            refereeQuestion: null,
            state: 'proposed' as const,
            issues: [],
          },
          {
            text: 'For the most displaced particles the gain reaches 3.1 points.',
            move: 'result',
            factIds: [],
            citeKeys: [],
            placeholders: [],
            noteZh: null,
            refereeQuestion: null,
            state: 'unsupported' as const,
            issues: [{ code: 'unmatched_number', severity: 'block' as const, message: '3.1 matches no fact (nearest: f.g1.delta_points = 2.32)' }],
          },
        ],
      },
    ],
  };
}

function Harness() {
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const [connected, setConnected] = useState(true);
  const units = useWorkspace((s) => s.units);
  const active = useWorkspace((s) => s.activeSentenceId);
  const notices = useWorkspace((s) => s.notices);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'system');

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  const review = units.filter((u) => u.state === 'proposed' || u.state === 'unsupported');
  const activeUnit = units.find((u) => u.id === active);

  return (
    <div className="h-app">
      <header className="h-bar">
        <strong>editor harness</strong>
        <button type="button" data-testid="btn-draft" onClick={() => handle?.insertDraft(draftMessage())}>
          Insert draft
        </button>
        <button
          type="button"
          data-testid="btn-replan"
          onClick={() => {
            const text = handle?.getText() ?? '';
            const units = useWorkspace.getState().units;
            const first = units.find((u) => text.slice(u.start, u.end).startsWith('The gain is largest'));
            const second = units.find((u) => text.slice(u.start, u.end).startsWith('Both trackers use'));
            api.inject({
              type: 'replan.proposed',
              file: 'main.tex',
              items: [
                ...(first ? [{ sentenceId: first.id, action: 'revise' as const, text: text.slice(first.start, first.end).replace('most targets', 'the most targets'), reason: 'Keep the comparison with the baseline explicit.' }] : []),
                ...(second ? [{ sentenceId: second.id, action: 'drop' as const, text: null, reason: 'Repeats what the method section already says.' }] : []),
              ],
            });
          }}
        >
          Re-plan
        </button>
        <button type="button" data-testid="btn-external" onClick={() => api.server.externalEdit()}>
          External edit
        </button>
        <button
          type="button"
          data-testid="btn-connection"
          onClick={() => {
            api.setConnected(!connected);
            setConnected(!connected);
          }}
        >
          {connected ? 'Disconnect' : 'Reconnect'}
        </button>
        <span className="h-spacer" />
        <label>
          Theme{' '}
          <select value={theme} onChange={(e) => setTheme(e.target.value)} data-testid="theme">
            <option value="system">system</option>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
        </label>
      </header>
      <main className="h-main">
        <div className="h-editor">
          <Editor
            api={api}
            file="main.tex"
            onReady={(h) => {
              setHandle(h);
              window.__pc.editor = h;
              useWorkspace.getState().setEditor(h);
            }}
          />
        </div>
        <aside className="h-side" aria-label="Harness state">
          <h2>Document</h2>
          <div data-testid="unit-count">{units.length} units</div>
          <div>{connected ? 'connected' : 'offline'} · server v{api.server.version}</div>
          <h2>Active sentence</h2>
          <div data-testid="active-unit">{activeUnit ? `${activeUnit.state} · ${activeUnit.move ?? 'no move'}` : 'none'}</div>
          <h2>Review queue ({review.length})</h2>
          {review.map((u) => (
            <button key={u.id} type="button" onClick={() => handle?.revealSentence(u.id, { openCard: true })}>
              {u.state === 'unsupported' ? '⚠ ' : '· '}
              {handle?.getText().slice(u.start, u.end).slice(0, 48)}…
            </button>
          ))}
          <h2>Notices</h2>
          {notices.map((n) => (
            <div key={n.id}>
              {n.level}: {n.message}
            </div>
          ))}
        </aside>
      </main>
    </div>
  );
}

const rootEl = document.getElementById('root') as (HTMLElement & { __pcRoot?: Root }) | null;
if (rootEl && !rootEl.__pcRoot) {
  rootEl.__pcRoot = createRoot(rootEl);
  rootEl.__pcRoot.render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
}
