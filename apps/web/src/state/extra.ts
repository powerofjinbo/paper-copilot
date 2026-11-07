/**
 * Shell-only UI state that WorkspaceState (contracts.ts) does not hold: language, theme, column
 * sizes, the PDF handle, the last pull/push results and drafts that arrived before the editor was
 * ready. Per-viewer conveniences are persisted in localStorage (every access wrapped in try/catch).
 */
import { create } from 'zustand';
import type { PushCheck, ReanchorReport, SubmissionReport } from '@paper-copilot/core';
import type { PdfHandle, ProjectFileInfo, ServerMessageOf } from '../contracts';
import { firstRunSeen, markFirstRunSeen, type StepSection } from '../components/steps';

export type Lang = 'en' | 'zh';
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'paper-copilot.shell.v1';

interface Persisted {
  lang: Lang | null;
  theme: ThemePref;
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  /**
   * The author wants the PDF beside the editor (a compile they started produced a PDF, or "Show PDF", the PDF
   * strip, Settings, forward search): when there is no room for both, the step panel yields to it (until the
   * author opens the panel again). It only matters once a PDF exists, so an empty PDF pane never takes the
   * step panel on load. (Stored under a new name: earlier versions pinned it on every compile, including the
   * browser demo's PDF-less ones, and that stale pin opened an empty pane over the panel on every load.)
   */
  pdfPinnedByUser: boolean;
}

const DEFAULTS: Persisted = { lang: null, theme: 'system', leftWidth: 360, rightWidth: 520, leftCollapsed: false, pdfPinnedByUser: false };

export const LEFT_MIN = 280;
export const LEFT_MAX = 640;
export const RIGHT_MIN = 300;
export const RIGHT_MAX = 1100;

function load(): Persisted {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      lang: p.lang === 'en' || p.lang === 'zh' ? p.lang : null,
      theme: p.theme === 'light' || p.theme === 'dark' || p.theme === 'system' ? p.theme : 'system',
      leftWidth: clamp(Number(p.leftWidth) || DEFAULTS.leftWidth, LEFT_MIN, LEFT_MAX),
      rightWidth: clamp(Number(p.rightWidth) || DEFAULTS.rightWidth, RIGHT_MIN, RIGHT_MAX),
      leftCollapsed: p.leftCollapsed === true,
      pdfPinnedByUser: p.pdfPinnedByUser === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(p: Persisted): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode or blocked storage: keep the in-memory value */
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface ShellState {
  /** UI language; null until chosen by the user or defaulted from the project's notesLanguage. */
  lang: Lang;
  langChosen: boolean;
  theme: ThemePref;
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  pdf: PdfHandle | null;
  fakeLlm: boolean | null;
  serverVersion: string | null;
  pullReports: ReanchorReport[] | null;
  pushCheck: PushCheck | null;
  /** draft.proposed messages that arrived before the editor handle existed. */
  pendingDrafts: Array<ServerMessageOf<'draft.proposed'>>;
  /** Finish times of jobs (for toasts that linger a few seconds). */
  jobFinishedAt: Record<string, number>;
  /** Increments to ask the Sync panel to run a push check (top-bar Push button). */
  pushCheckRequest: number;
  /**
   * Panes hidden for now because the editor would get too narrow (App.tsx useAutoFit). Not persisted:
   * they come back on their own when the window is wide enough.
   */
  fitHidden: { left: boolean; pdf: boolean };
  /** Panes the user opened explicitly (the left one in this session; the PDF is remembered): never hidden for space. */
  pinned: { left: boolean; pdf: boolean };
  /** The pane pinned last: when both are pinned and the editor would get too narrow, the other one yields. */
  lastPinned: 'left' | 'pdf' | null;
  /** "Show PDF" was chosen in this session: the pane opens even before there is a PDF (with "Compile"). */
  pdfAsked: boolean;
  /** The keyboard-shortcut overlay ("?"). */
  helpOpen: boolean;
  /** The Settings drawer (⚙): voice, language, theme, ownership heatmap, cost. */
  settingsOpen: boolean;
  /** The first-run hint (the 4-step flow) was dismissed (remembered in localStorage). */
  firstRunDone: boolean;
  /** A request to open and scroll to a section of the active step (seq increments per request). */
  focus: { section: StepSection; seq: number } | null;
  /** ② Sources sub-tab. */
  sourcesTab: 'facts' | 'lit';
  /** Last submission check (top-bar pill and ④); null until one ran. */
  submission: SubmissionReport | null;
  /** Project .tex files with per-file counts (top-bar file switcher). */
  files: ProjectFileInfo[];
  /** Reveal this target once its file is open in the editor (cross-file navigation, SyncTeX inverse). */
  pendingReveal: { file: string; sentenceId: string | null; line: number | null; openCard: boolean; seq: number } | null;

  setLang(l: Lang, chosen?: boolean): void;
  defaultLang(l: Lang): void;
  setTheme(t: ThemePref): void;
  setLeftWidth(w: number): void;
  setRightWidth(w: number): void;
  setLeftCollapsed(c: boolean): void;
  setPdf(h: PdfHandle | null): void;
  setFakeLlm(f: boolean): void;
  setServerVersion(v: string | null): void;
  setPullReports(r: ReanchorReport[] | null): void;
  setPushCheck(c: PushCheck | null): void;
  queueDraft(m: ServerMessageOf<'draft.proposed'>): void;
  takeDrafts(): Array<ServerMessageOf<'draft.proposed'>>;
  markJobFinished(id: string, at: number): void;
  requestPushCheck(): void;
  setFitHidden(f: { left: boolean; pdf: boolean }): void;
  /** Pin / unpin the PDF pane; `asked` also records an explicit show / hide (see `pdfAsked`). */
  pinPdf(on: boolean, asked?: boolean): void;
  /** Let the left panel be hidden for space again (it stays open if there is room). */
  unpinLeft(): void;
  /** Show the left panel (an explicit user action: it is pinned). */
  showLeft(): void;
  setHelpOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  dismissFirstRun(): void;
  focusSection(section: StepSection): void;
  setSourcesTab(t: 'facts' | 'lit'): void;
  setSubmission(r: SubmissionReport | null): void;
  setFiles(f: ProjectFileInfo[]): void;
  setPendingReveal(r: { file: string; sentenceId: string | null; line: number | null; openCard: boolean } | null): void;
}

function browserLang(): Lang {
  try {
    return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language) ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

const initial = load();

export const useShell = create<ShellState>((set, get) => {
  const persist = () => {
    const s = get();
    save({ lang: s.langChosen ? s.lang : null, theme: s.theme, leftWidth: s.leftWidth, rightWidth: s.rightWidth, leftCollapsed: s.leftCollapsed, pdfPinnedByUser: s.pinned.pdf });
  };
  return {
    lang: initial.lang ?? browserLang(),
    langChosen: initial.lang !== null,
    theme: initial.theme,
    leftWidth: initial.leftWidth,
    rightWidth: initial.rightWidth,
    leftCollapsed: initial.leftCollapsed,
    pdf: null,
    fakeLlm: null,
    serverVersion: null,
    pullReports: null,
    pushCheck: null,
    pendingDrafts: [],
    jobFinishedAt: {},
    pushCheckRequest: 0,
    fitHidden: { left: false, pdf: false },
    pinned: { left: false, pdf: initial.pdfPinnedByUser },
    lastPinned: initial.pdfPinnedByUser ? 'pdf' : null,
    pdfAsked: false,
    helpOpen: false,
    settingsOpen: false,
    firstRunDone: firstRunSeen(),
    focus: null,
    sourcesTab: 'facts',
    submission: null,
    files: [],
    pendingReveal: null,

    setLang: (lang, chosen = true) => {
      set({ lang, langChosen: chosen || get().langChosen });
      persist();
    },
    defaultLang: (lang) => {
      if (!get().langChosen) set({ lang });
    },
    setTheme: (theme) => {
      set({ theme });
      persist();
    },
    setLeftWidth: (w) => {
      set({ leftWidth: clamp(Math.round(w), LEFT_MIN, LEFT_MAX) });
      persist();
    },
    setRightWidth: (w) => {
      set({ rightWidth: clamp(Math.round(w), RIGHT_MIN, RIGHT_MAX) });
      persist();
    },
    setLeftCollapsed: (leftCollapsed) => {
      // expanding is always the user's explicit choice: the panel is then never hidden for space
      set((s) => ({ leftCollapsed, pinned: { ...s.pinned, left: !leftCollapsed }, lastPinned: leftCollapsed ? s.lastPinned : 'left' }));
      persist();
    },
    setFitHidden: (f) => {
      const cur = get().fitHidden;
      if (cur.left !== f.left || cur.pdf !== f.pdf) set({ fitHidden: f });
    },
    pinPdf: (on, asked) => {
      if (asked !== undefined && get().pdfAsked !== asked) set({ pdfAsked: asked });
      if (get().pinned.pdf === on && !(on && get().lastPinned !== 'pdf')) return;
      set((s) => ({ pinned: { ...s.pinned, pdf: on }, lastPinned: on ? 'pdf' : s.lastPinned }));
      persist();
    },
    unpinLeft: () => {
      if (get().pinned.left) set((s) => ({ pinned: { ...s.pinned, left: false } }));
    },
    showLeft: () => get().setLeftCollapsed(false),
    setHelpOpen: (helpOpen) => set({ helpOpen }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    dismissFirstRun: () => {
      markFirstRunSeen();
      set({ firstRunDone: true });
    },
    focusSection: (section) => set((s) => ({ focus: { section, seq: (s.focus?.seq ?? 0) + 1 }, sourcesTab: section === 'lit' ? 'lit' : section === 'facts' ? 'facts' : s.sourcesTab })),
    setSourcesTab: (sourcesTab) => set({ sourcesTab }),
    setSubmission: (submission) => set({ submission }),
    setFiles: (files) => set({ files }),
    setPendingReveal: (r) => set((s) => ({ pendingReveal: r ? { ...r, seq: (s.pendingReveal?.seq ?? 0) + 1 } : null })),
    setPdf: (pdf) => set({ pdf }),
    setFakeLlm: (fakeLlm) => set({ fakeLlm }),
    setServerVersion: (serverVersion) => set({ serverVersion }),
    setPullReports: (pullReports) => set({ pullReports }),
    setPushCheck: (pushCheck) => set({ pushCheck }),
    queueDraft: (m) => set((s) => ({ pendingDrafts: [...s.pendingDrafts, m] })),
    takeDrafts: () => {
      const d = get().pendingDrafts;
      if (d.length) set({ pendingDrafts: [] });
      return d;
    },
    markJobFinished: (id, at) => set((s) => ({ jobFinishedAt: { ...s.jobFinishedAt, [id]: at } })),
    requestPushCheck: () => set((s) => ({ pushCheckRequest: s.pushCheckRequest + 1 })),
  };
});
