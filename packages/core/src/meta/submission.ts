/**
 * Pre-submission checklist: one ordered list of items, each ok or not, with the sentences behind it.
 * The paper is ready only when no 'block' item fails (docs/design.md non-negotiables: unreviewed AI text,
 * placeholders and intent notes never reach co-authors or a journal; no number or citation without a
 * source; the venue's AI disclosure in the manuscript).
 *
 * OWNER: core-features agent.
 *
 * Items, in display order (ids in api.ts SubmissionItemId; labels in i18n, `t('submission.<id>')`):
 *   block: unreviewed (proposed AI sentences), unsupported (AI sentences that failed the gate),
 *          placeholders ([fact?: ...], [ref], [claim: ...?]), intent_lines (Chinese notes on their own line), cjk (Chinese/Japanese/
 *          Korean text outside comments), merge_conflicts, compile_errors (or not compiled yet),
 *          undefined_cites (\cite keys missing from the .bib), ai_unmatched_numbers (a number in an
 *          AI-touched sentence that matches no fact or derived relation), stale_facts (sentences stating a
 *          fact whose artifact changed), disclosure (AI was used and the main file lacks the venue's
 *          statement; arXiv: info, the statement goes in the Comments field);
 *   warn:  unresolved_cites (in the .bib but not resolved on INSPIRE nor confirmed), unmatched_numbers
 *          (numbers in the authors' own sentences that match no fact), echo_drift (consistency flags:
 *          precision/form/value drift, factor versus percent), uncited_floats, acronyms_before_definition,
 *          lint_warnings (style_check / AI-ese / gate flags of severity 'warn', not dismissed);
 *   info:  ambiguous_numbers (numerals that fit facts with different values).
 */
import { SubmissionItemId as SubmissionItemIdEnum, type CompileError, type EchoReport, type FigurePlanReport, type SubmissionEntry, type SubmissionItem, type SubmissionItemId, type SubmissionReport, type TerminologyReport } from '../api';
import type { Fact, LintFlag, LitRecord, Outline, TermEntry, Venue } from '../schemas';
import { gateSentence, type DerivedRelation } from '../gate/gate';
import { linkSentenceFacts } from '../facts/numbers';
import { factNumber } from '../facts/format';
import { findPlaceholders, scanLatex } from '../latex/tokens';
import { findIntentLines } from '../latex/lines';
import { CJK_RE } from '../gate/text';
import { echoCheck } from '../consistency/echo';
import { figurePlan } from '../consistency/figures';
import { terminologyReport } from '../consistency/terms';
import { extractTitle, maskComments, orderUnits, projectFileOrder, shorten, type ConsistencyUnit, type ProjectFile } from '../consistency/common';
import { derivedRelations } from './derived';

/** At most this many entries per item (`count` keeps the full number). */
export const SUBMISSION_MAX_ENTRIES = 200;

export interface SubmissionInput {
  /** Main file relative to the tex root. */
  mainFile: string;
  /** Every .tex file of the project with its current text. */
  files: readonly ProjectFile[];
  /** Units of all files with their text (unitsWithText); state, everAi, placeholders, facts, intentNote are read. */
  units: readonly ConsistencyUnit[];
  facts: readonly Fact[];
  venue: Venue;
  /** Keys defined in the project's .bib files. */
  bibKeys: readonly string[];
  /** Resolution status of the cited keys (missing records count as unresolved only when `lit` is given). */
  lit?: readonly LitRecord[];
  /** Last compile; null/undefined means "not compiled yet" (a blocker). */
  compile?: { state: 'idle' | 'running' | 'ok' | 'error'; errors: readonly CompileError[] } | null;
  lintFlags?: readonly LintFlag[];
  outline?: Outline | null;
  terms?: readonly TermEntry[];
  /** Derived relations the gate accepts; default derivedRelations(facts). */
  derived?: readonly DerivedRelation[];
  /** Precomputed reports (computed here when absent). */
  echo?: EchoReport;
  figures?: FigurePlanReport;
  terminology?: TerminologyReport;
}

/** Phrases that show the venue's AI statement is in the manuscript. */
export const DISCLOSURE_PATTERNS: Record<Venue, RegExp | null> = {
  aps: /\b(?:writing tool|large language models?|generative AI|AI[- ]assist(?:ed|ance)|language models?|LLMs?|Claude|ChatGPT|GPT-?\d)\b/i,
  springer: /\b(?:writing tool|large language models?|generative AI|AI[- ]assist(?:ed|ance)|language models?|LLMs?|Claude|ChatGPT|GPT-?\d)\b/i,
  elsevier: /Declaration\s+of\s+generative\s+AI\s+and\s+AI[-‐–\s]+assisted\s+technologies\s+in\s+the\s+writing\s+process/i,
  arxiv: null,
};

const NUMBER_CODES = new Set(['unmatched_number', 'unmatched_cut', 'percent_scale', 'fictional_number']);

/**
 * The checklist (see the module comment), items in the order of `SubmissionItemId`. Pure. A report that
 * fails to compute (echo, figure plan, terminology) leaves a note on its item instead of failing the call.
 */
export function submissionCheck(input: SubmissionInput): SubmissionReport {
  const files = (input.files ?? []).filter((f) => f && typeof f.file === 'string' && typeof f.text === 'string');
  const order = projectFileOrder(input.mainFile, files);
  const units = orderUnits((input.units ?? []).filter((u) => u && typeof u.text === 'string'), order);
  const facts = (input.facts ?? []).filter((f) => f && typeof f.id === 'string');
  const items = new Map<SubmissionItemId, SubmissionItem>();
  const item = (id: SubmissionItemId, severity: SubmissionItem['severity'], entries: SubmissionEntry[], note: string | null = null, ok?: boolean): void => {
    items.set(id, { id, ok: ok ?? entries.length === 0, severity, count: entries.length, items: entries.slice(0, SUBMISSION_MAX_ENTRIES), note });
  };
  const entryOf = (u: ConsistencyUnit, prefix = ''): SubmissionEntry => ({ file: u.file, sentenceId: u.id || null, line: u.line, text: shorten(prefix + u.text) });

  // ---------------------------------------------------------------- review state
  item('unreviewed', 'block', units.filter((u) => u.state === 'proposed').map((u) => entryOf(u)));
  item('unsupported', 'block', units.filter((u) => u.state === 'unsupported').map((u) => entryOf(u)));
  item(
    'placeholders',
    'block',
    units.filter((u) => u.state === 'placeholder' || (u.placeholders?.length ?? 0) > 0 || findPlaceholders(u.text).length > 0).map((u) => entryOf(u)),
  );

  // ---------------------------------------------------------------- file scans
  const intents: SubmissionEntry[] = [];
  const cjk: SubmissionEntry[] = [];
  const conflicts: SubmissionEntry[] = [];
  const citeKeys: Array<{ key: string; file: string; line: number }> = [];
  const cjkRe = new RegExp(CJK_RE.source);
  for (const { file } of order) {
    const text = files.find((f) => f.file === file)?.text ?? '';
    let intentLines: number[] = [];
    try {
      const ls = findIntentLines(text);
      intentLines = ls.map((l) => l.line);
      for (const l of ls) intents.push({ file, sentenceId: null, line: l.line, text: shorten(l.text) });
    } catch {
      /* none */
    }
    const masked = maskComments(text).split('\n');
    const raw = text.split('\n');
    const hasOpen = raw.some((l) => /^<{7}(?: |$)/.test(l));
    raw.forEach((l, i) => {
      if (cjkRe.test(masked[i] ?? '') && !intentLines.includes(i + 1)) cjk.push({ file, sentenceId: null, line: i + 1, text: shorten(l) });
      if (/^<{7}(?: |$)/.test(l) || /^>{7}(?: |$)/.test(l) || /^\|{7}(?: |$)/.test(l) || (hasOpen && /^={7}$/.test(l))) conflicts.push({ file, sentenceId: null, line: i + 1, text: shorten(l) });
    });
    try {
      const m = maskComments(text);
      const lineAt = (off: number): number => m.slice(0, off).split('\n').length;
      for (const kc of scanLatex(m).keyCommands) if (kc.kind === 'cite') for (const k of kc.keys) citeKeys.push({ key: k, file, line: lineAt(kc.start) });
    } catch {
      /* no cites */
    }
  }
  item('intent_lines', 'block', intents);
  item('cjk', 'block', cjk);
  item('merge_conflicts', 'block', conflicts);

  // ---------------------------------------------------------------- compile
  {
    const c = input.compile ?? null;
    if (!c || c.state === 'idle') item('compile_errors', 'block', [], 'Not compiled yet: compile the paper before submitting.', false);
    else if (c.state === 'running') item('compile_errors', 'block', [], 'A compile is running; check again when it ends.', false);
    else {
      const errs = (c.errors ?? []).map((e) => ({ file: e.file, sentenceId: null, line: e.line, text: shorten(e.message) }));
      item('compile_errors', 'block', errs, c.state === 'error' && errs.length === 0 ? 'The last compile failed (see the log).' : null, c.state === 'ok' && errs.length === 0);
    }
  }

  // ---------------------------------------------------------------- citations
  {
    const bib = new Set((input.bibKeys ?? []).map((k) => String(k).trim()));
    const lit = input.lit ? new Map(input.lit.map((r) => [r.key, r] as const)) : null;
    const seenU = new Set<string>();
    const seenR = new Set<string>();
    const undef: SubmissionEntry[] = [];
    const unres: SubmissionEntry[] = [];
    for (const c of citeKeys) {
      if (!bib.has(c.key)) {
        if (!seenU.has(c.key)) undef.push({ file: c.file, sentenceId: null, line: c.line, text: c.key });
        seenU.add(c.key);
        continue;
      }
      if (!lit) continue;
      const r = lit.get(c.key);
      if ((!r || r.status === 'unresolved') && !seenR.has(c.key)) unres.push({ file: c.file, sentenceId: null, line: c.line, text: c.key });
      seenR.add(c.key);
    }
    for (const e of [...undef, ...unres]) {
      const u = units.find((x) => x.file === e.file && (x.cites ?? []).includes(e.text)) ?? units.find((x) => x.file === e.file && x.text.includes(e.text));
      if (u) {
        e.sentenceId = u.id || null;
        e.line = u.line;
      }
    }
    item('undefined_cites', 'block', undef);
    item('unresolved_cites', 'warn', unres, lit ? null : 'Literature status unknown (not resolved yet).');
  }

  // ---------------------------------------------------------------- numbers
  const derived = input.derived ? [...input.derived] : derivedRelations([...facts]);
  {
    const labels: string[] = [];
    for (const f of files) {
      try {
        for (const kc of scanLatex(maskComments(f.text)).keyCommands) if (kc.kind === 'label') labels.push(...kc.keys);
      } catch {
        /* none */
      }
    }
    const usable = facts.filter((f) => !f.excluded);
    const aiBad: SubmissionEntry[] = [];
    const humanBad: SubmissionEntry[] = [];
    const ambiguous: SubmissionEntry[] = [];
    for (const u of units) {
      if (u.state === 'proposed' || u.state === 'unsupported') continue;
      let issues: Array<{ code: string; severity: string; raw?: string }> = [];
      try {
        issues = gateSentence(u.text, { mode: 'rewrite', original: u.text, facts: usable, allowedCiteKeys: [], knownLabels: labels, fictionalNumbers: [], derived: [...derived], claimedFactIds: u.facts ?? [], intentText: u.intentNote ?? null }).issues;
      } catch {
        issues = [];
      }
      const bad = issues.filter((i) => NUMBER_CODES.has(i.code) && i.severity === 'block');
      if (bad.length) (u.everAi ? aiBad : humanBad).push(entryOf(u, `${[...new Set(bad.map((b) => `"${b.raw ?? '?'}"`))].join(', ')}: `));
      try {
        const amb = linkSentenceFacts(u.text, usable, u.facts ?? []).ambiguous.filter((a) => {
          const vals = new Set(a.candidates.map((id) => usable.find((f) => f.id === id)).map((f) => (f ? String(factNumber(f)) : '')));
          return vals.size > 1;
        });
        if (amb.length) ambiguous.push(entryOf(u, `${amb.map((a) => `"${a.token.raw}"`).join(', ')}: `));
      } catch {
        /* none */
      }
    }
    item('ai_unmatched_numbers', 'block', aiBad);
    item('unmatched_numbers', 'warn', humanBad);
    item('ambiguous_numbers', 'info', ambiguous);
  }

  // ---------------------------------------------------------------- reports
  let echo: EchoReport | null = input.echo ?? null;
  let figs: FigurePlanReport | null = input.figures ?? null;
  let terms: TerminologyReport | null = input.terminology ?? null;
  const notes: Partial<Record<SubmissionItemId, string>> = {};
  if (!echo) {
    try {
      const main = files.find((f) => f.file === input.mainFile)?.text ?? '';
      echo = echoCheck(units, facts, input.outline ?? null, { derived, title: extractTitle(main) });
    } catch (e) {
      notes.echo_drift = `Consistency check failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (!figs) {
    try {
      figs = figurePlan(files, units, input.outline ?? null, { order });
    } catch (e) {
      notes.uncited_floats = `Figure plan failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (!terms) {
    try {
      terms = terminologyReport(units, input.terms ?? []);
    } catch (e) {
      notes.acronyms_before_definition = `Terminology check failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const byId = new Map(units.map((u) => [u.id, u] as const));
  const flagEntries = (sentenceIds: string[], message: string): SubmissionEntry[] => {
    const u = sentenceIds.map((id) => byId.get(id)).find((x): x is ConsistencyUnit => !!x);
    return [{ file: u?.file ?? input.mainFile, sentenceId: u?.id ?? null, line: u?.line ?? null, text: shorten(message) }];
  };

  // stale facts (from the echo check)
  {
    const entries: SubmissionEntry[] = [];
    for (const s of echo?.stale ?? []) for (const r of s.sentences) entries.push({ file: r.file, sentenceId: r.sentenceId, line: r.line, text: shorten(`${s.factId}: ${r.text}`) });
    const staleUsed = facts.filter((f) => f.stale);
    item('stale_facts', 'block', entries, staleUsed.length && !entries.length ? `${staleUsed.length} stale fact(s), none stated in the text.` : null);
  }

  // disclosure
  {
    const aiUsed = units.some((u) => u.everAi);
    const pat = DISCLOSURE_PATTERNS[input.venue] ?? null;
    const main = maskComments(files.find((f) => f.file === input.mainFile)?.text ?? '');
    if (!aiUsed) item('disclosure', 'block', [], 'No AI-assisted sentence in the record; no statement needed.', true);
    else if (!pat) item('disclosure', 'info', [], 'arXiv: report significant AI use in the Comments field of the submission (GET /api/disclosure?venue=arxiv).', true);
    else {
      const found = pat.test(main.replace(/\s+/g, ' '));
      const where = input.venue === 'elsevier' ? 'a section titled "Declaration of generative AI and AI-assisted technologies in the writing process" before the references' : input.venue === 'aps' ? 'the acknowledgments or Methods' : 'the Methods section';
      item('disclosure', 'block', found ? [] : [{ file: input.mainFile, sentenceId: null, line: null, text: `AI-assisted text without a disclosure statement; add it to ${where}.` }], found ? null : `Expected in ${input.mainFile}: ${where}.`);
    }
  }
  item(
    'echo_drift',
    'warn',
    (echo?.flags ?? []).filter((f) => (f.kind === 'drift_precision' && f.severity === 'warn') || f.kind === 'drift_form' || f.kind === 'drift_value' || f.kind === 'factor_percent').flatMap((f) => flagEntries(f.sentenceIds, f.message)),
    notes.echo_drift ?? null,
  );
  item('uncited_floats', 'warn', (figs?.flags ?? []).filter((f) => f.kind === 'float_uncited').map((f) => {
    const row = figs!.floats.find((r) => r.label === f.label);
    return { file: row?.file ?? input.mainFile, sentenceId: row?.captionSentenceIds[0] ?? null, line: row?.line ?? null, text: shorten(f.message) };
  }), notes.uncited_floats ?? null);
  item('acronyms_before_definition', 'warn', (terms?.flags ?? []).filter((f) => f.kind === 'acronym_before_definition').flatMap((f) => flagEntries(f.sentenceIds, f.message)), notes.acronyms_before_definition ?? null);
  item(
    'lint_warnings',
    'warn',
    (input.lintFlags ?? []).filter((f) => f && f.severity === 'warn' && !f.dismissed).map((f) => {
      const u = f.sentenceId ? byId.get(f.sentenceId) : undefined;
      return { file: u?.file ?? input.mainFile, sentenceId: f.sentenceId, line: u?.line ?? f.line, text: shorten(`${f.check}: ${f.msg}`) };
    }),
  );

  const list = SubmissionItemIdEnum.options.map((id) => items.get(id)).filter((x): x is SubmissionItem => !!x);
  const blockers = list.filter((i) => i.severity === 'block' && !i.ok).length;
  const warnings = list.filter((i) => i.severity === 'warn' && !i.ok).length;
  return { ok: blockers === 0, blockers, warnings, items: list };
}
