/**
 * PDF pane harness: mounts <PdfPane> against a fake ApiClient whose pdfUrl serves a PDF compiled from
 * the canto-demo fixture into harness/.out/ (git-ignored by its own .gitignore) and whose
 * synctexInverse echoes the coordinates it was given.
 *
 *   node apps/web/harness/e2e-pdf.mjs --build-only     # compile the fixture into harness/.out/
 *   cd apps/web && npx vite --port 5176                # then open
 *   http://127.0.0.1:5176/harness/pdf.html?doc=long    # doc=main (1 page) | long (fixture body x4)
 *
 * Query: theme=dark|light, lang=zh, width=<px of the PDF column>.
 * window.__pdf exposes the handle, the recorded inverse calls and the knobs the e2e script uses.
 */
import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../src/styles/tokens.css';
import type { ApiClient, PdfHandle } from '../src/contracts';
import { PdfPane } from '../src/pdf/PdfPane';
import { useWorkspace } from '../src/state/store';
import { useShell } from '../src/state/extra';

interface InverseCall {
  page: number;
  x: number;
  y: number;
}

interface Box {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Harness {
  handle: PdfHandle | null;
  calls: InverseCall[];
  targets: Array<{ file: string; line: number }>;
  /** Inverse-search log shown on the left (kept here so it survives an HMR re-mount). */
  log: string[];
  version: number | null;
  doc: string;
  broken: boolean;
  inverseResult: 'echo' | 'null' | 'fail';
  setVersion(v: number | null): void;
  bump(): void;
  setBroken(b: boolean): void;
  setCompile(state: 'idle' | 'running' | 'ok' | 'error'): void;
  boxes: Record<string, Box>;
  subscribe(fn: () => void): () => void;
  notify(): void;
}

declare global {
  interface Window {
    __pdf: Harness;
  }
}

const params = new URLSearchParams(location.search);
if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme')!;
if (params.get('lang') === 'zh') useShell.getState().setLang('zh');
if (params.get('width')) document.documentElement.style.setProperty('--pdf-w', `${Number(params.get('width'))}px`);

function makeHarness(): Harness {
  if (window.__pdf) return window.__pdf;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  const h: Harness = {
    handle: null,
    calls: [],
    targets: [],
    log: [],
    version: params.get('version') === 'none' ? null : 1,
    doc: params.get('doc') ?? 'long',
    broken: false,
    inverseResult: 'echo',
    boxes: {},
    setVersion(v) {
      h.version = v;
      useWorkspace.getState().setCompile({ state: v === null ? 'idle' : 'ok', pdfVersion: v, errors: [], logTail: '' });
      notify();
    },
    bump() {
      h.setVersion((h.version ?? 0) + 1);
    },
    setBroken(b) {
      h.broken = b;
      notify();
    },
    setCompile(state) {
      useWorkspace.getState().setCompile({ ...useWorkspace.getState().compile, state, pdfVersion: h.version });
      notify();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    notify,
  };
  useWorkspace.getState().setCompile({ state: h.version === null ? 'idle' : 'ok', pdfVersion: h.version, errors: [], logTail: '' });
  window.__pdf = h;
  void fetch('/harness/.out/boxes.json')
    .then((r) => (r.ok ? r.json() : {}))
    .then((b: Record<string, Box>) => {
      h.boxes = b;
      notify();
    })
    .catch(() => undefined);
  return h;
}

const harness = makeHarness();


/** Only the methods the PDF pane calls; everything else throws. */
const fakeApi = new Proxy(
  {
    pdfUrl(v: number) {
      return harness.broken ? `/harness/.out/missing.pdf?v=${v}` : `/harness/.out/${harness.doc}.pdf?v=${v}`;
    },
    async synctexInverse(page: number, x: number, y: number) {
      harness.calls.push({ page, x, y });
      await new Promise((r) => setTimeout(r, 20));
      if (harness.inverseResult === 'fail') throw new Error('synctex exited with code 1');
      if (harness.inverseResult === 'null') return null;
      const target = { file: 'main.tex', line: Math.max(1, Math.round(y)) };
      harness.targets.push(target);
      return target;
    },
    async compile() {
      harness.setCompile('running');
      await new Promise((r) => setTimeout(r, 900));
      harness.bump();
    },
  },
  {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      return () => Promise.reject(new Error(`fake api: ${prop} is not implemented in the PDF harness`));
    },
  },
) as unknown as ApiClient;

function useHarness() {
  return useSyncExternalStore(harness.subscribe, () => `${harness.version}|${harness.broken}|${Object.keys(harness.boxes).length}|${harness.log.length}`);
}

function App() {
  useHarness();
  const [dark, setDark] = useState(document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const boxes = Object.entries(harness.boxes);
  return (
    <div className="h-app">
      <div className="h-bar">
        <strong>PDF harness</strong>
        <span>v{harness.version ?? '–'}</span>
        <button type="button" onClick={() => harness.bump()}>
          New version
        </button>
        <button type="button" onClick={() => void fakeApi.compile()}>
          Compile (stale → new)
        </button>
        <button type="button" onClick={() => harness.setCompile('error')}>
          Compile fails
        </button>
        <button type="button" onClick={() => harness.setVersion(null)}>
          No PDF
        </button>
        <button
          type="button"
          onClick={() => {
            harness.setBroken(!harness.broken);
            harness.bump();
          }}
        >
          {harness.broken ? 'Fix URL' : 'Broken URL'}
        </button>
        {boxes.map(([name, box]) => (
          <button key={name} type="button" onClick={() => harness.handle?.showBox(box)}>
            showBox {name}
          </button>
        ))}
        <span className="h-spacer" />
        <button type="button" onClick={() => setDark((d) => !d)}>
          {dark ? 'Light' : 'Dark'}
        </button>
      </div>
      <div className="h-main">
        <div className="h-log" aria-label="Inverse search log">
          <h2>Inverse search (click the PDF)</h2>
          <ol>
            {harness.log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        </div>
        <section className="h-pdf" aria-label="PDF">
          <PdfPane
            api={fakeApi}
            pdfVersion={harness.version}
            onInverse={(t) => {
              const c = harness.calls[harness.calls.length - 1];
              harness.log = [...harness.log, `page ${c?.page} x=${c?.x.toFixed(2)} y=${c?.y.toFixed(2)} -> ${t.file}:${t.line}`];
              harness.notify();
            }}
            onReady={(handle) => {
              harness.handle = handle;
            }}
          />
        </section>
      </div>
    </div>
  );
}

const w = window as unknown as { __pdfRoot?: Root };
w.__pdfRoot ??= createRoot(document.getElementById('root')!);
w.__pdfRoot.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
