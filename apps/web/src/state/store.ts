import { create } from 'zustand';
import type { WorkspaceState } from '../contracts';

let noticeSeq = 0;

export const useWorkspace = create<WorkspaceState>((set) => ({
  project: null,
  connected: false,
  file: null,
  units: [],
  lint: [],
  activeSentenceId: null,
  facts: [],
  unresolved: [],
  outline: null,
  compile: { state: 'idle', pdfVersion: null, errors: [], logTail: '' },
  cost: null,
  jobs: {},
  notices: [],
  questions: [],
  leftTab: 'outline',
  rightPane: 'pdf',
  editor: null,

  setProject: (project) => set({ project }),
  setConnected: (connected) => set({ connected }),
  setFile: (file) => set({ file }),
  setUnits: (units) => set({ units }),
  setLint: (lint) => set({ lint }),
  setActiveSentence: (activeSentenceId) => set({ activeSentenceId }),
  setFacts: (facts, unresolved) => set({ facts, unresolved }),
  setOutline: (outline) => set({ outline }),
  setCompile: (compile) => set({ compile }),
  setCost: (cost) => set({ cost }),
  upsertJob: (id, job) => set((s) => ({ jobs: { ...s.jobs, [id]: job } })),
  pushNotice: (level, message) => set((s) => ({ notices: [...s.notices.slice(-4), { id: ++noticeSeq, level, message }] })),
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  setQuestions: (questions) => set({ questions }),
  setLeftTab: (leftTab) => set({ leftTab }),
  setRightPane: (rightPane) => set({ rightPane }),
  setEditor: (editor) => set({ editor }),
}));
