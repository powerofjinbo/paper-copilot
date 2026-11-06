/**
 * Shell-only UI state that WorkspaceState (contracts.ts) does not hold: language, theme, column
 * sizes, the PDF handle, the last pull/push results and drafts that arrived before the editor was
 * ready. Per-viewer conveniences are persisted in localStorage (every access wrapped in try/catch).
 */
import { create } from 'zustand';
import type { PushCheck, ReanchorReport } from '@paper-copilot/core';
import type { PdfHandle, ServerMessageOf } from '../contracts';

export type Lang = 'en' | 'zh';
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'paper-copilot.shell.v1';

interface Persisted {
  lang: Lang | null;
  theme: ThemePref;
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
}

const DEFAULTS: Persisted = { lang: null, theme: 'system', leftWidth: 360, rightWidth: 520, leftCollapsed: false };

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
    save({ lang: s.langChosen ? s.lang : null, theme: s.theme, leftWidth: s.leftWidth, rightWidth: s.rightWidth, leftCollapsed: s.leftCollapsed });
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
      set({ leftCollapsed });
      persist();
    },
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
