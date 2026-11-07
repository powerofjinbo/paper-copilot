/**
 * The sentence card: state in words, model, time; move and paragraph job; fact chips; cite keys; the
 * author's intent note; lint flags; and the review actions (accept, instruct, grammar, alternatives,
 * rewrite myself, reject, history, re-plan). Rendered with React inside a CodeMirror tooltip that is
 * anchored above the sentence start or below its end, so it never covers the sentence it describes.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { EditorView } from '@codemirror/view';
import type { HistoryResponse, Proposal } from '@paper-copilot/core';
import { useWorkspace } from '../../state/store';
import { clearReplanEffect } from '../context';
import type { EditorEnv } from '../env';
import { isCjk, MOD_KEY } from '../labels';
import { issueLabel, lintExplain, lintLabel, originLabel, relTime, stateLabel, useEdT, type EdT } from '../i18n';
import { factLabel, wordDiffOf } from '../safe';
import { lintTitle } from '../decorations';
import { replanDropSpec, replanInsertBeforeSpec, replanReviseSpec, restoreSpec } from '../actions';
import { codeLabel } from '../../i18n';
import { pinCardEffect } from './cardState';
import type { CardSnapshot } from './cardData';

const MOD_LABEL = MOD_KEY;

type Mode =
  | { kind: 'main' }
  | { kind: 'instruct' }
  | { kind: 'busy'; label: string }
  | { kind: 'proposal'; source: 'instruct' | 'grammar'; proposal: Proposal; instruction: string | null; lang: string | null }
  | { kind: 'alternatives'; items: Proposal[] }
  | { kind: 'history'; data: HistoryResponse }
  | { kind: 'error'; message: string };

const RECENT_KEY = 'paper-copilot.recent-instructions';

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveRecent(instruction: string): void {
  try {
    const list = [instruction, ...loadRecent().filter((x) => x !== instruction)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: chips are a convenience only */
  }
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="pc-kbd">{children}</kbd>;
}

export function Diff({ diff }: { diff: ReadonlyArray<readonly [number, string]> }) {
  return (
    <span className="pc-diff">
      {diff.map(([op, t], i) =>
        op === 0 ? (
          <span key={i}>{t}</span>
        ) : op < 0 ? (
          <del key={i} className="pc-diff-del">
            {t}
          </del>
        ) : (
          <ins key={i} className="pc-diff-ins">
            {t}
          </ins>
        ),
      )}
    </span>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SentenceCardProps {
  view: EditorView;
  env: EditorEnv;
  snap: CardSnapshot;
}

export function SentenceCard({ view, env, snap }: SentenceCardProps) {
  const { unit, text, card } = snap;
  const id = unit.id;
  const { t, lang } = useEdT();
  const [mode, setMode] = useState<Mode>(card.view === 'instruct' ? { kind: 'instruct' } : { kind: 'main' });
  const [instruction, setInstruction] = useState('');
  const [hasFocus, setHasFocus] = useState(card.focus);
  const [recent] = useState<string[]>(loadRecent);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const canAccept = unit.state === 'proposed' || unit.state === 'unsupported';

  const close = useCallback(() => env.ops.closeCard(view, { focusEditor: true }), [env, view]);

  // Focus: a keyboard-opened card focuses its primary control; afterwards, whenever the card's content
  // changes (the instruction input unmounts while the rewrite loads, the proposal arrives...), focus moves
  // to the new primary control if the card had it, so Ctrl+Enter / Esc / letters keep working.
  const focusInside = useRef(card.focus);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const first = !mounted.current;
    mounted.current = true;
    if (!root || !focusInside.current) return;
    const active = document.activeElement;
    // after the first render, never take focus back from somewhere else: the author moved on
    if (!first && active && active !== document.body && !root.contains(active)) return;
    const target =
      root.querySelector<HTMLElement>('input.pc-input') ??
      root.querySelector<HTMLElement>('[data-autofocus]') ??
      root.querySelector<HTMLElement>('.pc-card-actions button:not([disabled])');
    if (target && target !== active) target.focus({ preventScroll: true });
  }, [mode]);

  const guarded = useCallback(
    async <T,>(label: string, run: () => Promise<T>, done: (v: T) => void) => {
      setMode({ kind: 'busy', label });
      try {
        const v = await run();
        if (alive.current) done(v);
      } catch (err) {
        if (alive.current) setMode({ kind: 'error', message: errMessage(err) });
      }
    },
    [],
  );

  const runGrammar = useCallback(() => {
    void guarded(t('busyGrammar'), () => env.api.grammar(id), (p) => setMode({ kind: 'proposal', source: 'grammar', proposal: p, instruction: null, lang: null }));
  }, [env, id, guarded, t]);
  const runAlternatives = useCallback(() => {
    void guarded(t('busyAlternatives'), () => env.api.alternatives(id, 3), (items) => setMode({ kind: 'alternatives', items }));
  }, [env, id, guarded, t]);
  const runHistory = useCallback(() => {
    void guarded(t('busyHistory'), () => env.api.history(id), (data) => setMode({ kind: 'history', data }));
  }, [env, id, guarded, t]);
  const restoreVersion = useCallback(
    (version: number) => {
      void guarded(
        t('busyRestore'),
        () => env.api.restoreVersion(id, version),
        (r) => {
          if (r.noop) {
            useWorkspace.getState().pushNotice('info', t('restoreNoop', { n: version }));
            setMode({ kind: 'main' });
            return;
          }
          const spec = restoreSpec(view.state, r);
          if (!spec) {
            setMode({ kind: 'error', message: t('restoreChanged') });
            return;
          }
          view.dispatch(spec);
          const notice = r.issues.length
            ? t('restoreIssues', { issues: r.issues.map((x) => codeLabel(lang, `gate.${x.code}`)).join(' · ') })
            : t('restored', { n: version });
          useWorkspace.getState().pushNotice(r.issues.length ? 'warn' : 'info', notice);
          close();
        },
      );
    },
    [env, id, view, guarded, t, lang, close],
  );
  const submitInstruction = useCallback(
    (raw: string) => {
      const ins = raw.trim();
      if (!ins) return;
      saveRecent(ins);
      const lang = isCjk(ins) ? 'zh' : 'en';
      void guarded(`${t('busyRewrite')} ${ins}`, () => env.api.instruct(id, ins, lang), (p) => setMode({ kind: 'proposal', source: 'instruct', proposal: p, instruction: ins, lang }));
    },
    [env, id, guarded, t],
  );
  const accept = useCallback(() => {
    if (!canAccept) return;
    void env.ops.acceptUnit(view, id);
    close();
  }, [canAccept, env, view, id, close]);
  const reject = useCallback(() => {
    void env.ops.rejectUnit(view, id);
    close();
  }, [env, view, id, close]);
  const rewrite = useCallback(() => env.ops.rewriteMyself(view, id), [env, view, id]);
  const applyProposal = useCallback(
    (p: Proposal, source: 'instruct' | 'grammar' | 'alternative', ins: string | null, lang: string | null) => {
      // An identical "rewrite" changes nothing: applying it would stamp AI provenance on the author's own text.
      if (p.text.trim() === text.trim()) {
        useWorkspace.getState().pushNotice('info', t('noChange'));
        close();
        return;
      }
      // Only a real language fix (origin grammar_fix) keeps the sentence's state; a "grammar" result the
      // server re-labelled as a rewrite (it changed the meaning) is applied as AI text, like any rewrite.
      const ok = env.ops.applyProposal(view, p, source === 'grammar' && p.origin === 'grammar_fix' ? { state: unit.state } : { state: 'ai-drafted', instruction: ins, lang });
      if (ok) close();
      else setMode({ kind: 'error', message: t('notApplied') });
    },
    [env, view, unit.state, close, t, text],
  );

  useEffect(() => {
    if (card.view === 'grammar') runGrammar();
    else if (card.view === 'alternatives') runAlternatives();
    else if (card.view === 'history') runHistory();
    // run once per card
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (mode.kind === 'instruct') {
      focusInside.current = true;
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [mode.kind]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const inInput = (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA';
    let handled = true;
    if (key === 'Escape') {
      if (mode.kind !== 'main' && mode.kind !== 'busy') setMode({ kind: 'main' });
      else close();
    } else if (mod && key === 'Enter') {
      if (mode.kind === 'proposal') applyProposal(mode.proposal, mode.source, mode.instruction, mode.lang);
      else if (mode.kind === 'instruct') submitInstruction(instruction);
      else accept();
    } else if (mod && (key === 'i' || key === 'I')) setMode({ kind: 'instruct' });
    else if (mod && (key === 'g' || key === 'G')) runGrammar();
    else if (e.altKey && (key === 'ArrowDown' || key === 'ArrowUp')) env.ops.reviewStep(view, key === 'ArrowDown' ? 1 : -1);
    else if (inInput || mod || e.altKey) handled = false;
    else if (mode.kind === 'alternatives' && /^[1-9]$/.test(key)) {
      const p = mode.items[Number(key) - 1];
      if (p) applyProposal(p, 'alternative', null, null);
    } else {
      switch (key.toLowerCase()) {
        case 'l':
          runAlternatives();
          break;
        case 'r':
          rewrite();
          break;
        case 'x':
          reject();
          break;
        case 'h':
          runHistory();
          break;
        case 'a':
          if (mode.kind === 'proposal') applyProposal(mode.proposal, mode.source, mode.instruction, mode.lang);
          else handled = false;
          break;
        default:
          handled = false;
      }
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const pin = () => {
    if (!card.pinned) view.dispatch({ effects: pinCardEffect.of(null) });
  };

  const time = unit.acceptedAt ?? unit.createdAt;
  const job = snap.paragraph?.job ?? null;
  const move = unit.move ?? snap.draftNote?.move ?? null;

  return (
    <div
      ref={rootRef}
      className="pc-card"
      role="dialog"
      aria-label={t('cardLabel', { state: stateLabel(unit.state, lang) })}
      data-testid="sentence-card"
      data-state={unit.state}
      onKeyDown={onKeyDown}
      onFocus={() => {
        focusInside.current = true;
        setHasFocus(true);
        pin();
      }}
      onBlur={(e) => {
        // relatedTarget is null when the focused element was removed: keep the focus inside then
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) {
          focusInside.current = false;
          setHasFocus(false);
        }
      }}
      onMouseDown={pin}
    >
      <div className="pc-card-head">
        <span className={`pc-state-dot pc-dot-${unit.state}`} aria-hidden="true" />
        <span className="pc-card-state">{stateLabel(unit.state, lang)}</span>
        {unit.everAi && unit.state !== 'ai-drafted' && unit.state !== 'ai-edited' && unit.state !== 'proposed' && unit.state !== 'ai-from-intent' && unit.state !== 'unsupported' ? (
          <span className="pc-card-flag" title={t('aiTouchedTitle')}>
            {t('aiTouched')}
          </span>
        ) : null}
        {unit.grammarFixed ? <span className="pc-card-flag">{t('grammarFixed')}</span> : null}
        {unit.state === 'ai-edited' && unit.editDistance !== null ? <span className="pc-card-meta">{t('changed', { n: Math.round(unit.editDistance * 100) })}</span> : null}
        <span className="pc-card-meta">
          {unit.model && unit.state !== 'human' ? unit.model : unit.imported ? t('imported') : ''}
          {time ? <span title={time}> · {relTime(time, lang)}</span> : null}
        </span>
        <button type="button" className="pc-icon-btn" aria-label={t('close')} title={t('closeTitle')} onClick={close}>
          ×
        </button>
      </div>

      {move || job ? (
        <div className="pc-card-job">
          {move ? <span className="pc-move">{move}</span> : null}
          {job ? <span className="pc-job">{job}</span> : null}
        </div>
      ) : null}

      {mode.kind === 'main' ? (
        <MainBody
          t={t}
          snap={snap}
          view={view}
          onShowFact={() => useWorkspace.getState().setLeftTab('facts')}
          onDismissLint={(flagId) => {
            // optimistic: hide it now; the server's lint.update (full list) confirms
            const ws = useWorkspace.getState();
            ws.setLint(ws.lint.map((f) => (f.id === flagId ? { ...f, dismissed: true } : f)));
            env.api.dismissLint(flagId).catch((err: unknown) => ws.pushNotice('error', errMessage(err)));
          }}
        />
      ) : null}

      {mode.kind === 'instruct' ? (
        <div className="pc-card-section">
          <label className="pc-label" htmlFor={`pc-ins-${id}`}>
            {t('instructionLabel')}
          </label>
          <div className="pc-input-row">
            <input
              id={`pc-ins-${id}`}
              ref={inputRef}
              className="pc-input"
              lang="zh"
              value={instruction}
              placeholder="例如：把基线放在前面 · verb first"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  submitInstruction(instruction);
                }
              }}
            />
            <button type="button" className="pc-btn pc-btn-primary" onClick={() => submitInstruction(instruction)} disabled={!instruction.trim()}>
              {t('rewriteBtn')} <Kbd>Enter</Kbd>
            </button>
          </div>
          {recent.length ? (
            <div className="pc-chips" aria-label={t('recent')}>
              {recent.slice(0, 4).map((r) => (
                <button key={r} type="button" className="pc-chip pc-chip-ins" lang={isCjk(r) ? 'zh' : 'en'} onClick={() => submitInstruction(r)}>
                  {r}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {mode.kind === 'busy' ? (
        <div className="pc-card-section pc-busy" role="status">
          <span className="pc-pulse" aria-hidden="true" /> {mode.label}
        </div>
      ) : null}

      {mode.kind === 'error' ? (
        <div className="pc-card-section pc-error" role="alert">
          {mode.message}
        </div>
      ) : null}

      {mode.kind === 'proposal' ? <ProposalView t={t} mode={mode} /> : null}

      {mode.kind === 'alternatives' ? (
        <div className="pc-card-section" role="listbox" aria-label={t('alternatives')}>
          {mode.items.length === 0 ? <div className="pc-muted">{t('noAlternatives')}</div> : null}
          {mode.items.map((p, i) => (
            <button key={p.proposalId} type="button" role="option" aria-selected="false" className="pc-alt" data-autofocus={i === 0 ? '' : undefined} onClick={() => applyProposal(p, 'alternative', null, null)}>
              <Kbd>{i + 1}</Kbd>
              <span className="pc-alt-text">{p.text}</span>
              {p.issues.length ? <span className="pc-alt-issues">{p.issues.map((x) => `${issueLabel(x.code, lang)}: ${x.message}`).join(' · ')}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {mode.kind === 'history' ? (
        <div className="pc-card-section pc-history" aria-label={t('history')}>
          {mode.data.versions.length === 0 ? <div className="pc-muted">{t('noVersions')}</div> : null}
          {[...mode.data.versions]
            .sort((a, b) => b.version - a.version)
            .map((v) => (
              <div key={v.version} className="pc-hist-row">
                <div className="pc-hist-meta">
                  <span className="pc-hist-v">v{v.version}</span> {originLabel(v.origin, lang)}
                  {v.text === text ? <span className="pc-hist-current"> · {t('current')}</span> : null}
                  {v.model ? ` · ${v.model}` : ''} · <span title={v.ts}>{relTime(v.ts, lang)}</span>
                  {v.editDistance !== null && v.editDistance !== undefined ? ` · ${Math.round(v.editDistance * 100)}%` : ''}
                </div>
                {v.instruction ? (
                  <div className="pc-hist-ins" lang={isCjk(v.instruction) ? 'zh' : 'en'}>
                    “{v.instruction}”
                  </div>
                ) : null}
                <div className="pc-hist-text">{v.text}</div>
                {v.text !== text ? (
                  <button type="button" className="pc-btn pc-btn-sm pc-hist-restore" title={t('restoreTitle')} onClick={() => restoreVersion(v.version)}>
                    {t('restore')}
                  </button>
                ) : null}
              </div>
            ))}
        </div>
      ) : null}

      <div className="pc-card-actions" role="toolbar" aria-label={t('actions')}>
        {mode.kind === 'proposal' ? (
          <>
            <button type="button" className="pc-btn pc-btn-primary" data-autofocus="" aria-keyshortcuts="Control+Enter A" onClick={() => applyProposal(mode.proposal, mode.source, mode.instruction, mode.lang)}>
              {t('accept')} <Kbd>{MOD_LABEL}+Enter</Kbd>
            </button>
            <button type="button" className="pc-btn" aria-keyshortcuts="Escape" onClick={() => setMode({ kind: 'main' })}>
              {t('discard')} <Kbd>Esc</Kbd>
            </button>
          </>
        ) : mode.kind !== 'main' ? (
          <button type="button" className="pc-btn" onClick={() => setMode({ kind: 'main' })} aria-keyshortcuts="Escape">
            {t('back')} <Kbd>Esc</Kbd>
          </button>
        ) : (
          <>
            {canAccept ? (
              <button type="button" className="pc-btn pc-btn-primary" data-autofocus="" aria-keyshortcuts="Control+Enter" onClick={accept}>
                {t('accept')} <Kbd>{MOD_LABEL}+Enter</Kbd>
              </button>
            ) : null}
            <button type="button" className="pc-btn" aria-keyshortcuts="Control+I" onClick={() => setMode({ kind: 'instruct' })}>
              {t('instruct')} <Kbd>{MOD_LABEL}+I</Kbd>
            </button>
            <button type="button" className="pc-btn" aria-keyshortcuts="Control+G" onClick={runGrammar}>
              {t('grammar')} <Kbd>{MOD_LABEL}+G</Kbd>
            </button>
            <button type="button" className="pc-btn" aria-keyshortcuts="L" onClick={runAlternatives}>
              {t('alternatives')} <Kbd>L</Kbd>
            </button>
            <button type="button" className="pc-btn" aria-keyshortcuts="R" onClick={rewrite}>
              {t('rewriteMyself')} <Kbd>R</Kbd>
            </button>
            <button type="button" className="pc-btn pc-btn-danger" aria-keyshortcuts="X" onClick={reject}>
              {t('reject')} <Kbd>X</Kbd>
            </button>
            <button type="button" className="pc-btn" aria-keyshortcuts="H" onClick={runHistory}>
              {t('history')} <Kbd>H</Kbd>
            </button>
          </>
        )}
      </div>
      {mode.kind === 'main' && !hasFocus ? (
        <div className="pc-card-hint">
          <Kbd>{MOD_LABEL}+.</Kbd> {t('hintLetters')} · <Kbd>Alt+↓</Kbd> {t('hintNext')}
        </div>
      ) : null}
      {/* text of the sentence for screen readers (the card never covers it visually) */}
      <span className="pc-sr-only">{text}</span>
    </div>
  );
}

function ProposalView({ t, mode }: { t: EdT; mode: Extract<Mode, { kind: 'proposal' }> }) {
  const p = mode.proposal;
  const drift = p.drift;
  return (
    <div className="pc-card-section pc-proposal" data-testid="proposal">
      <div className="pc-label">{mode.source === 'grammar' && p.origin === 'grammar_fix' ? t('grammarOnly') : mode.instruction ? t('rewriteFor', { instruction: mode.instruction }) : t('rewrite')}</div>
      <div className="pc-proposal-text">
        <Diff diff={p.diff} />
      </div>
      {p.notes ? (
        <div className="pc-notes" lang={isCjk(p.notes) ? 'zh' : 'en'}>
          {p.notes}
        </div>
      ) : null}
      {drift ? (
        <ul className="pc-drift" aria-label={t('driftList')}>
          {(['actor', 'scope', 'direction', 'condition'] as const).map((k) => (
            <li key={k} className={drift[k] ? 'pc-drift-changed' : 'pc-drift-kept'}>
              <span aria-hidden="true">{drift[k] ? '⚠' : '✓'}</span> {t(`drift.${k}`)} {drift[k] ? t('driftChanged') : t('driftKept')}
            </li>
          ))}
        </ul>
      ) : null}
      {p.issues.length ? (
        <ul className="pc-issues" aria-label={t('factGate')}>
          {p.issues.map((x, i) => (
            <li key={i} className={`pc-issue-${x.severity}`}>
              <span aria-hidden="true">{x.severity === 'block' ? '⚠' : '·'}</span> <strong className="pc-issue-label">{issueLabel(x.code, lang)}</strong>{' '}
              <span lang="en">{x.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="pc-muted pc-small">{p.model}</div>
    </div>
  );
}

function MainBody({ t, snap, view, onShowFact, onDismissLint }: { t: EdT; snap: CardSnapshot; view: EditorView; onShowFact: () => void; onDismissLint: (flagId: string) => void }) {
  const { unit } = snap;
  return (
    <>
      {snap.facts.length || snap.missingFactIds.length ? (
        <div className="pc-card-section pc-chips" aria-label={t('facts')}>
          {snap.facts.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`pc-chip pc-chip-fact${f.stale ? ' pc-stale' : ''}`}
              title={`${f.definition}\n${f.artifact} ${f.locator}${f.stale ? `\n${t('staleTitle')}` : ''}`}
              onClick={() => {
                onShowFact();
                window.dispatchEvent(new CustomEvent('paper-copilot:reveal-fact', { detail: { factId: f.id } }));
              }}
            >
              {factLabel(f)}
              {f.stale ? ` (${t('stale')})` : ''}
            </button>
          ))}
          {snap.missingFactIds.map((fid) => (
            <span key={fid} className="pc-chip pc-chip-fact pc-missing">
              {fid}
            </span>
          ))}
        </div>
      ) : null}
      {snap.unresolved.length ? (
        <div className="pc-card-section pc-unresolved">
          <span className="pc-label-inline">{t('noFactFor')}</span>{' '}
          {snap.unresolved.map((u, i) => (
            <span key={i} className="pc-chip pc-chip-unlinked" title={u.candidates.length ? t('candidates', { ids: u.candidates.join(', ') }) : t('noCandidate')}>
              {u.raw}
            </span>
          ))}
        </div>
      ) : null}
      {unit.cites.length ? (
        <div className="pc-card-section pc-cites">
          <span className="pc-label-inline">{t('cites')}</span>{' '}
          {unit.cites.map((c) => (
            <code key={c} className="pc-cite">
              {c}
            </code>
          ))}
        </div>
      ) : null}
      {unit.intentNote ? (
        <div className="pc-card-section pc-intent-note" lang="zh">
          <span className="pc-label-inline">{t('yourNote')}</span> {unit.intentNote}
        </div>
      ) : null}
      {snap.draftNote?.noteZh ? (
        <div className="pc-card-section pc-ai-note" lang="zh">
          <span className="pc-label-inline">{t('aiNote')}</span> {snap.draftNote.noteZh}
        </div>
      ) : null}
      {snap.draftNote?.refereeQuestion ? (
        <div className="pc-card-section pc-referee">
          <span className="pc-label-inline">{t('referee')}</span> {snap.draftNote.refereeQuestion}
        </div>
      ) : null}
      {snap.draftNote && snap.draftNote.issues.length ? (
        <ul className="pc-card-section pc-issues" aria-label={t('factGate')}>
          {snap.draftNote.issues.map((x, i) => (
            <li key={i} className={`pc-issue-${x.severity}`}>
              <span aria-hidden="true">{x.severity === 'block' ? '⚠' : '·'}</span> <strong className="pc-issue-label">{issueLabel(x.code, lang)}</strong>{' '}
              <span lang="en">{x.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {snap.lint.length ? (
        <ul className="pc-card-section pc-lint-list" aria-label={t('lint')}>
          {snap.lint.map((f) => (
            <li key={f.id} className={`pc-lint-row pc-lint-row-${f.severity}`} title={lintTitle(f)}>
              <span className="pc-lint-check" title={lintExplain(f.check, lang) || undefined}>
                {lintLabel(f.check, lang)}
              </span>{' '}
              <span lang="en">{f.msg}</span>
              {f.word ? <span className="pc-muted"> “{f.word}”</span> : null}
              {f.corpusRate !== null ? <span className="pc-muted"> · {t('corpus')} {f.corpusRate.toFixed(1)}/1k</span> : null}
              {f.userRate !== null ? <span className="pc-muted"> · {t('you')} {f.userRate.toFixed(1)}/1k</span> : null}
              <button type="button" className="pc-btn pc-btn-small pc-lint-dismiss" data-testid="lint-dismiss" title={t('dismissLint')} onClick={() => onDismissLint(f.id)}>
                {t('dismiss')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {snap.replan ? <ReplanSection t={t} snap={snap} view={view} /> : null}
    </>
  );
}

function ReplanSection({ t, snap, view }: { t: EdT; snap: CardSnapshot; view: EditorView }) {
  const r = snap.replan!;
  const dismiss = () => view.dispatch({ effects: clearReplanEffect.of(r.sentenceId) });
  const act = () => {
    const spec = r.action === 'revise' ? replanReviseSpec(view.state, r) : r.action === 'drop' ? replanDropSpec(view.state, r) : replanInsertBeforeSpec(view.state, r);
    if (spec) view.dispatch(spec, { effects: clearReplanEffect.of(r.sentenceId) });
  };
  return (
    <div className="pc-card-section pc-replan" aria-label={t('replan')}>
      <div className="pc-label">
        <span aria-hidden="true">↻ </span>
        {t('replanSuggests')} {r.action === 'revise' ? t('replanRevise') : r.action === 'drop' ? t('replanDrop') : t('replanInsert')}
      </div>
      <div className="pc-muted">{r.reason}</div>
      {r.action === 'revise' && r.text ? (
        <div className="pc-proposal-text">
          <Diff diff={wordDiffOf(snap.text, r.text)} />
        </div>
      ) : null}
      {r.action === 'insert_before' && r.text ? <div className="pc-proposal-text pc-diff-ins">{r.text}</div> : null}
      <div className="pc-row">
        <button type="button" className="pc-btn pc-btn-small pc-btn-primary" onClick={act}>
          {r.action === 'revise' ? t('useRevision') : r.action === 'drop' ? t('deleteSentence') : t('insertIt')}
        </button>
        <button type="button" className="pc-btn pc-btn-small" onClick={dismiss}>
          {r.action === 'drop' ? t('keep') : t('dismiss')}
        </button>
      </div>
    </div>
  );
}
