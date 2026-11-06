/**
 * Imperative actions shared by the top bar, keyboard shortcuts and panels. They read the stores
 * directly (no React), so they can run from event handlers and global shortcuts.
 */
import type { ChangeAnnotation } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';
import { errorText } from '../api/errors';
import { translate, type MsgKey, type Vars } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';

function tr(key: MsgKey, vars?: Vars): string {
  return translate(useShell.getState().lang, key, vars);
}

/** Push a notice unless the same one is already showing (reconnect loops, StrictMode double effects). */
export function notify(level: 'info' | 'warn' | 'error', message: string): void {
  const ws = useWorkspace.getState();
  if (ws.notices.some((n) => n.level === level && n.message === message)) return;
  ws.pushNotice(level, message);
}

/* ------------------------------------------------------------------------------------ */
/* Data refreshes (bus messages and reconnects)                                          */
/* ------------------------------------------------------------------------------------ */

export async function refetchFacts(api: ApiClient): Promise<void> {
  const r = await api.facts();
  useWorkspace.getState().setFacts(r.facts, r.unresolved);
}

export async function refetchOutline(api: ApiClient): Promise<void> {
  useWorkspace.getState().setOutline(await api.outline());
}

export async function refetchQuestions(api: ApiClient): Promise<void> {
  useWorkspace.getState().setQuestions(await api.questions());
}

/** Project info, facts, outline, questions and cost; failures become one notice each. */
export async function loadWorkspace(api: ApiClient): Promise<void> {
  const ws = useWorkspace.getState();
  try {
    const info = await api.project();
    ws.setProject(info);
    useShell.getState().defaultLang(info.config.notesLanguage === 'zh' ? 'zh' : 'en');
    if (useShell.getState().fakeLlm === null) useShell.getState().setFakeLlm(info.fakeLlm);
    if (!useWorkspace.getState().file) ws.setFile(info.config.mainFile || info.files[0] || null);
  } catch (e) {
    notify('error', errorText(e));
    return;
  }
  const results = await Promise.allSettled([
    refetchFacts(api),
    refetchOutline(api),
    refetchQuestions(api),
    api.cost().then((c) => useWorkspace.getState().setCost(c)),
  ]);
  for (const r of results) if (r.status === 'rejected') notify('warn', errorText(r.reason));
}

/* ------------------------------------------------------------------------------------ */
/* Editor and PDF                                                                        */
/* ------------------------------------------------------------------------------------ */

export function revealSentence(id: string, openCard = false): void {
  const ed = useWorkspace.getState().editor;
  if (!ed) {
    notify('warn', tr('common.notReady'));
    return;
  }
  if (!useWorkspace.getState().units.some((u) => u.id === id)) {
    notify('warn', tr('common.sentenceGone'));
    return;
  }
  ed.revealSentence(id, { openCard });
}

export function revealLine(line: number): void {
  const ed = useWorkspace.getState().editor;
  if (!ed) {
    notify('warn', tr('common.notReady'));
    return;
  }
  ed.revealLine(line);
}

export async function compileNow(api: ApiClient): Promise<void> {
  // the author asked for the PDF: show it (on a narrow window the left panel makes room instead)
  useShell.getState().pinPdf(true);
  const ws = useWorkspace.getState();
  if (ws.rightPane === 'none') ws.setRightPane('pdf');
  try {
    await api.compile();
  } catch (e) {
    notify('error', errorText(e));
  }
}

/** Wait until the PDF pane registered its handle (it may have just been shown). */
async function pdfHandle(timeoutMs = 2500) {
  const t0 = Date.now();
  for (;;) {
    const h = useShell.getState().pdf;
    if (h) return h;
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Ctrl/Cmd+Shift+J: the editor's current line -> SyncTeX forward -> highlight the box in the PDF. */
export async function forwardSync(api: ApiClient): Promise<void> {
  const ws = useWorkspace.getState();
  const ed = ws.editor;
  if (!ed || !ws.file) {
    notify('warn', tr('common.notReady'));
    return;
  }
  const line = ed.currentLine();
  // the author asked to see this line in the PDF: show (and pin) the pane even on a narrow window
  useShell.getState().pinPdf(true);
  if (ws.rightPane === 'none') ws.setRightPane('pdf');
  try {
    const box = await api.synctexForward(ws.file, line);
    if (!box) {
      notify('info', tr('pdf.noBox', { n: line }));
      return;
    }
    const h = await pdfHandle();
    h?.showBox(box);
  } catch (e) {
    notify('error', tr('pdf.forwardFailed', { msg: errorText(e) }));
  }
}

export async function pullNow(api: ApiClient): Promise<void> {
  try {
    const reports = await api.pull();
    useShell.getState().setPullReports(reports);
    const sum = reports.reduce(
      (a, r) => ({ unchanged: a.unchanged + r.unchanged, edited: a.edited + r.edited.length, created: a.created + r.created.length, orphaned: a.orphaned + r.orphaned.length }),
      { unchanged: 0, edited: 0, created: 0, orphaned: 0 },
    );
    notify('info', tr('sync.report', sum));
  } catch (e) {
    notify('error', errorText(e));
  }
}

/** Top-bar Push: open the Sync panel and run the push check there (push needs a message and a look at the diff). */
export function openPush(): void {
  const ws = useWorkspace.getState();
  ws.setLeftTab('sync');
  useShell.getState().setLeftCollapsed(false);
  useShell.getState().requestPushCheck();
}

export async function acceptSentence(api: ApiClient, id: string): Promise<boolean> {
  try {
    await api.accept(id);
    return true;
  } catch (e) {
    notify('error', tr('review.failed', { msg: errorText(e) }));
    return false;
  }
}

/**
 * Reject: the server returns `[claim: <text>?]`; the editor writes it over the sentence as one
 * annotated transaction, so the claim is never silently lost (docs/design.md, Draft-then-review).
 */
export async function rejectSentence(api: ApiClient, id: string): Promise<boolean> {
  const ed = useWorkspace.getState().editor;
  if (!ed) {
    notify('warn', tr('common.notReady'));
    return false;
  }
  try {
    const { replacement } = await api.reject(id);
    const annotation: ChangeAnnotation = {
      origin: 'human_edit',
      sentenceIds: [id],
      state: 'placeholder',
      model: null,
      promptHash: null,
      instruction: 'reject',
      lang: null,
      intentNote: null,
      factIds: [],
      citeKeys: [],
      move: null,
      requestId: null,
    };
    if (!ed.replaceUnitText(id, replacement, annotation)) {
      notify('warn', tr('common.sentenceGone'));
      return false;
    }
    return true;
  } catch (e) {
    notify('error', tr('review.failed', { msg: errorText(e) }));
    return false;
  }
}
