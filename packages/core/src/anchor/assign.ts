/**
 * Implementation of assignUnits (contract and rules: units.ts). Kept separate so units.ts stays the
 * readable contract.
 */
import type { ChangeAnnotation } from '../api';
import type { SegSentence } from '../latex/segment';
import { AI_ORIGINS, type EditPair, type SentenceState, type SentenceUnit, type SentenceVersion, type VersionOrigin } from '../schemas';
import { hashString } from '../text/hash';
import { ulid } from '../text/ulid';
import { defaultAnalyze, editDistance, normText, textSimilarity } from './adapter';
import { LineTable } from './lines';
import { matchUnits } from './match';
import type { AssignInput, AssignResult, TextAnalysis } from './units';

type Range = { from: number; to: number };

/** States holding AI text: local typing turns them into 'ai-edited' and yields an EditPair. */
const AI_TEXT_STATES: ReadonlySet<SentenceState> = new Set(['ai-drafted', 'ai-from-intent', 'proposed', 'unsupported', 'ai-edited']);
const ACCEPTED_AI_STATES: ReadonlySet<SentenceState> = new Set(['ai-drafted', 'ai-from-intent']);
const REVIEW_STATES: ReadonlySet<SentenceState> = new Set(['proposed', 'unsupported']);

/** How an annotation acts on a unit. */
type AnnKind = 'ai' | 'grammar' | 'import' | 'external' | 'human';

function annKind(a: ChangeAnnotation): AnnKind {
  if (a.origin === 'grammar_fix') return 'grammar';
  if (a.origin === 'import') return 'import';
  if (a.origin === 'external_edit') return 'external';
  if (AI_ORIGINS.includes(a.origin)) return 'ai';
  return 'human';
}

/** State for an AI origin when the annotation does not name one. */
function defaultAiState(origin: VersionOrigin): SentenceState {
  switch (origin) {
    case 'ai_intent':
      return 'ai-from-intent';
    case 'ai_draft':
    case 'replan':
      return 'proposed';
    default:
      return 'ai-drafted';
  }
}

/** Section type vocabulary of CorpusEntry/EditPair. */
export function sectionTypeOf(s: SegSentence): string {
  switch (s.part) {
    case 'abstract':
    case 'intro':
    case 'concl':
    case 'caption':
      return s.part;
    case 'body':
      return /result/i.test(s.sectionTitle) ? 'results' : 'body';
    default:
      return 'other';
  }
}

/** True when the whole sentence is one placeholder (optionally followed by terminal punctuation). */
export function isOnlyPlaceholder(text: string, placeholders: string[]): boolean {
  if (placeholders.length !== 1) return false;
  const p = placeholders[0]!.trim();
  const t = text.trim().replace(/[.?!;:,]+$/, '').trim();
  return t === p;
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Field-wise equality of two units (arrays by content). */
export function unitsEqual(a: SentenceUnit, b: SentenceUnit): boolean {
  for (const k of Object.keys(a) as Array<keyof SentenceUnit>) {
    const x = a[k];
    const y = b[k];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (!sameArray(x, y)) return false;
    } else if (x !== y) return false;
  }
  return Object.keys(b).length === Object.keys(a).length;
}

function union(a: readonly string[], b: readonly string[]): string[] {
  if (b.length === 0) return [...a];
  const out = [...a];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out;
}

/** A range touches a span: overlap for non-empty ranges; an empty range (deletion point) inside or on the edge. */
function touches(r: Range, start: number, end: number): boolean {
  if (r.from === r.to) return start <= r.from && r.from <= end;
  return r.from < end && start < r.to;
}

export function assignUnitsImpl(input: AssignInput): AssignResult {
  const { text, now, file } = input;
  const external = input.changeSource === 'external';
  const ann = input.annotation ?? null;
  const kind = ann ? annKind(ann) : null;
  const analyze: (t: string) => TextAnalysis = input.analyze ?? defaultAnalyze;
  const lines = new LineTable(text);
  const nowMs = Date.parse(now);
  const newId = (): string => ulid(Number.isFinite(nowMs) ? nowMs : Date.now());

  const segs = [...input.seg.sentences].sort((a, b) => a.start - b.start || a.end - b.end);
  const segText = (s: SegSentence): string => (typeof s.text === 'string' ? s.text : text.slice(s.start, s.end));
  const prev = input.prev.filter((u) => !u.orphaned).sort((a, b) => a.start - b.start || a.end - b.end);
  const orphans = input.prev.filter((u) => u.orphaned);

  // Lazily computed per-segment normalized text and hash (fast-path segments reuse the unit's).
  const norms: Array<string | undefined> = new Array(segs.length);
  const hashes: Array<string | undefined> = new Array(segs.length);
  const segNorm = (si: number): string => (norms[si] ??= normText(segText(segs[si]!)));
  const segHash = (si: number): string => (hashes[si] ??= hashString(segNorm(si)));

  // In-paragraph neighbours, for ctxHash.
  const neighbours = new Array<[number, number]>(segs.length);
  {
    const byPara = new Map<number, number[]>();
    segs.forEach((s, si) => {
      const list = byPara.get(s.paragraphIndex);
      if (list) list.push(si);
      else byPara.set(s.paragraphIndex, [si]);
    });
    for (const list of byPara.values()) {
      list.sort((a, b) => segs[a]!.indexInParagraph - segs[b]!.indexInParagraph || segs[a]!.start - segs[b]!.start);
      list.forEach((si, k) => (neighbours[si] = [k > 0 ? list[k - 1]! : -1, k + 1 < list.length ? list[k + 1]! : -1]));
    }
  }
  /** hashString(prev.hash + '|' + next.hash); a missing side contributes ''; '' when the sentence is alone. */
  const segCtxHash = (si: number): string => {
    const [p, n] = neighbours[si] ?? [-1, -1];
    if (p === -1 && n === -1) return '';
    return hashString((p === -1 ? '' : segHash(p)) + '|' + (n === -1 ? '' : segHash(n)));
  };

  const m = matchUnits({
    segs,
    prev,
    orphans,
    external,
    fuzzyThreshold: input.fuzzyThreshold ?? 0.6,
    fuzzyLineWindow: input.fuzzyLineWindow ?? 8,
    segNorm,
    segHash,
    segCtxHash,
    prevLine: (u) => lines.lineOf(u.start),
    similarity: textSimilarity,
  });

  // Splits: an unmatched segment overlapping a matched unit is split off it (largest overlap wins).
  // Merges: an unmatched unit overlapping a segment owned by another unit is merged into the owner of
  // its largest such overlap.
  const splitOf = new Int32Array(segs.length).fill(-1);
  const mergedInto = new Map<number, number[]>();
  {
    const bestSplit = new Map<number, number>();
    const bestMerge = new Map<number, { ov: number; owner: number }>();
    for (const { si, pi, ov } of m.pairs) {
      const owner = m.segOwner[si]!;
      if (owner === -1 && m.segOrphan[si] === -1 && m.prevMatch[pi] !== -1 && ov > (bestSplit.get(si) ?? 0)) {
        bestSplit.set(si, ov);
        splitOf[si] = pi;
      }
      if (m.prevMatch[pi] === -1 && owner !== -1 && ov > (bestMerge.get(pi)?.ov ?? 0)) bestMerge.set(pi, { ov, owner });
    }
    for (const [pi, { owner }] of [...bestMerge].sort((a, b) => a[0] - b[0])) {
      const list = mergedInto.get(owner);
      if (list) list.push(pi);
      else mergedInto.set(owner, [pi]);
    }
  }

  const dirty = input.dirty;
  // A deletion point ON a span edge counts: mapUnits maps start with assoc +1 and end with assoc -1, so an
  // edge insertion never enters the span, but text deleted at a sentence's first or last characters
  // leaves its deletion point exactly on the new edge (and the text changed).
  // The same holds for a replacement that swallowed a span's first (or last) characters: its new range
  // ends exactly on the span's start (or begins on its end), so a range touching an edge counts too.
  const isDirty = (s: SegSentence): boolean => dirty === undefined || dirty.some((r) => r.from <= s.end && s.start <= r.to);
  const annRange = input.annotatedRange ?? null;
  /** Does the annotation act on this segment (with optional previous unit)? */
  const annApplies = (s: SegSentence, u: SentenceUnit | null, textChanged: boolean): boolean => {
    if (!ann) return false;
    if (u && ann.sentenceIds.includes(u.id)) return true;
    if (annRange) return textChanged && touches(annRange, s.start, s.end);
    if (ann.sentenceIds.length > 0) return false;
    return textChanged && isDirty(s);
  };

  const result: AssignResult = {
    units: [],
    versions: [],
    upserts: [],
    removed: [],
    orphaned: [],
    editPairs: [],
    report: { unchanged: 0, edited: [], created: [], orphaned: [], split: [] },
  };

  const positional = (s: SegSentence, si: number) => ({
    file,
    start: s.start,
    end: s.end,
    line: lines.lineOf(s.start),
    ctxHash: segCtxHash(si),
    sectionId: s.sectionId,
    paragraphId: `${s.sectionId}/p${s.paragraphIndex}`,
    part: s.part,
    kind: s.kind,
    orphaned: false,
  });

  const versionRow = (id: string, s: SegSentence, origin: VersionOrigin, aiMeta: boolean, base: SentenceVersion | undefined): SentenceVersion => {
    const t = segText(s);
    return {
      sentenceId: id,
      version: base ? base.version + 1 : 0,
      ts: now,
      text: t,
      origin,
      model: aiMeta && ann ? ann.model : null,
      promptHash: aiMeta && ann ? ann.promptHash : null,
      instruction: ann && aiMeta ? ann.instruction : null,
      lang: ann && aiMeta ? ann.lang : null,
      parentVersion: base ? base.version : null,
      editDistance: base ? editDistance(base.text, t) : null,
    };
  };

  /** Finalize state from the text: a unit that is only one placeholder is 'placeholder'. */
  const placeholderRule = (u: SentenceUnit, t: string): void => {
    if (isOnlyPlaceholder(t, u.placeholders)) u.state = 'placeholder';
    else if (u.state === 'placeholder') u.state = external ? 'external' : 'human';
  };

  /** Build the unit for a segment that keeps (or splits from) previous unit `u`. */
  const evolve = (si: number, u: SentenceUnit, pi: number, split: boolean): SentenceUnit => {
    const s = segs[si]!;
    const t = segText(s);
    const norm = segNorm(si);
    const textChanged = split || norm !== u.textNorm;
    const id = split ? newId() : u.id;
    const a = analyze(t);
    const next: SentenceUnit = {
      ...u,
      ...positional(s, si),
      id,
      hash: segHash(si),
      textNorm: norm,
      cites: a.cites,
      placeholders: a.placeholders,
      splitFrom: split ? u.id : u.splitFrom,
      createdAt: split ? now : u.createdAt,
      facts: [...u.facts],
      claims: [...u.claims],
    };
    // Merged units: their metadata travels with the surviving unit; AI provenance is never lost.
    const merged = split || pi < 0 ? [] : (mergedInto.get(pi) ?? []).map((k) => prev[k]!);
    for (const mu of merged) {
      next.everAi ||= mu.everAi;
      next.facts = union(next.facts, mu.facts);
      next.claims = union(next.claims, mu.claims);
    }
    const lastV = split ? undefined : input.lastVersion(u.id);
    const lastAi = input.lastAiVersion(u.id) ?? (AI_TEXT_STATES.has(u.state) ? input.lastVersion(u.id) : undefined);
    const applies = annApplies(s, u, textChanged);

    if (!textChanged) {
      // Same normalized text: only an annotation naming this unit may change its state.
      if (applies && ann && ann.state && kind !== 'import' && kind !== 'external' && !external) {
        next.state = ann.state;
        if (kind === 'ai') next.everAi = true;
        if (ACCEPTED_AI_STATES.has(ann.state)) next.acceptedAt = u.acceptedAt ?? now;
      }
      placeholderRule(next, t);
      return next;
    }

    let origin: VersionOrigin;
    let aiMeta = false;
    if (external || (applies && kind === 'external')) {
      next.state = 'external';
      origin = 'external_edit';
    } else if (applies && ann && kind === 'ai') {
      next.state = ann.state ?? defaultAiState(ann.origin);
      next.everAi = true;
      next.model = ann.model ?? u.model;
      next.promptHash = ann.promptHash ?? u.promptHash;
      next.intentNote = ann.intentNote ?? u.intentNote;
      next.facts = [...ann.factIds];
      next.move = ann.move ?? u.move;
      next.editDistance = 0;
      next.acceptedAt = ACCEPTED_AI_STATES.has(next.state) ? now : REVIEW_STATES.has(next.state) ? null : u.acceptedAt;
      origin = ann.origin;
      aiMeta = true;
    } else if (applies && ann && kind === 'grammar') {
      next.grammarFixed = true;
      next.everAi = true;
      next.model = ann.model ?? u.model;
      next.promptHash = ann.promptHash ?? u.promptHash;
      origin = 'grammar_fix';
      aiMeta = true;
    } else {
      // Local typing, or a human-origin annotation such as "rewrite myself" (state given by the action).
      origin = applies && ann && kind === 'human' ? ann.origin : 'human_edit';
      const dist = lastAi ? editDistance(lastAi.text, t) : null;
      if (applies && ann && kind === 'human' && ann.state) {
        next.state = ann.state;
        if (dist !== null && next.everAi) next.editDistance = dist;
      } else if (AI_TEXT_STATES.has(u.state)) {
        next.state = 'ai-edited';
        next.editDistance = dist ?? u.editDistance;
        if (REVIEW_STATES.has(u.state)) next.acceptedAt = u.acceptedAt ?? now;
        if (!split && lastAi && dist !== null && dist > 0) {
          result.editPairs.push({
            sentenceId: id,
            ts: now,
            aiText: lastAi.text,
            humanText: t,
            instruction: lastAi.instruction,
            sectionType: sectionTypeOf(s),
            grammarOnly: false,
            editDistance: dist,
          } satisfies EditPair);
        }
      } else if (u.state === 'external') {
        next.state = next.everAi ? 'ai-edited' : 'human';
        if (next.everAi && dist !== null) next.editDistance = dist;
      } else {
        // human stays human; a placeholder becomes human once written out (placeholderRule re-checks).
        next.state = 'human';
      }
      // AI text merged into a human sentence is AI text the author edited, not the author's own.
      if (next.state === 'human' && !(applies && kind === 'human') && merged.some((mu) => AI_TEXT_STATES.has(mu.state))) {
        const src = merged.find((mu) => AI_TEXT_STATES.has(mu.state))!;
        const srcAi = input.lastAiVersion(src.id) ?? input.lastVersion(src.id);
        next.state = 'ai-edited';
        next.everAi = true;
        next.editDistance = srcAi ? editDistance(srcAi.text, t) : src.editDistance;
      }
    }
    placeholderRule(next, t);
    result.versions.push(versionRow(id, s, origin, aiMeta, lastV));
    return next;
  };

  /** Build a brand-new unit for a segment nothing overlaps. */
  const create = (si: number): SentenceUnit => {
    const s = segs[si]!;
    const t = segText(s);
    const a = analyze(t);
    const applies = annApplies(s, null, true);
    const k: AnnKind | 'external' | 'local' = external
      ? kind === 'import'
        ? 'import'
        : 'external'
      : applies && kind
        ? kind
        : 'local';
    const unit: SentenceUnit = {
      id: newId(),
      ...positional(s, si),
      hash: segHash(si),
      textNorm: segNorm(si),
      move: null,
      state: 'human',
      everAi: false,
      grammarFixed: false,
      imported: false,
      model: null,
      promptHash: null,
      createdAt: now,
      acceptedAt: null,
      editDistance: null,
      intentNote: null,
      facts: [],
      cites: a.cites,
      claims: [],
      placeholders: a.placeholders,
      splitFrom: null,
    };
    let origin: VersionOrigin = 'human_typed';
    let aiMeta = false;
    if (k === 'import') {
      unit.imported = true;
      origin = 'import';
    } else if (k === 'external') {
      unit.state = 'external';
      origin = 'external_edit';
    } else if (k === 'ai' && ann) {
      unit.state = ann.state ?? defaultAiState(ann.origin);
      unit.everAi = true;
      unit.model = ann.model;
      unit.promptHash = ann.promptHash;
      unit.intentNote = ann.intentNote;
      unit.facts = [...ann.factIds];
      unit.move = ann.move;
      unit.editDistance = 0;
      unit.acceptedAt = ACCEPTED_AI_STATES.has(unit.state) ? now : null;
      origin = ann.origin;
      aiMeta = true;
    } else if (k === 'grammar' && ann) {
      unit.everAi = true;
      unit.grammarFixed = true;
      unit.model = ann.model;
      unit.promptHash = ann.promptHash;
      origin = 'grammar_fix';
      aiMeta = true;
    } else if (k === 'human' && ann) {
      unit.state = ann.state ?? 'human';
      origin = ann.origin;
    }
    placeholderRule(unit, t);
    result.versions.push(versionRow(unit.id, s, origin, aiMeta, undefined));
    return unit;
  };

  const prevById = new Map<string, SentenceUnit>();
  for (const u of input.prev) prevById.set(u.id, u);

  for (let si = 0; si < segs.length; si++) {
    const s = segs[si]!;
    const owner = m.segOwner[si]!;
    const orphan = m.segOrphan[si]!;
    let unit: SentenceUnit;
    if (owner !== -1 || orphan !== -1) {
      const u = owner !== -1 ? prev[owner]! : orphans[orphan]!;
      const fast =
        owner !== -1 && !external && dirty !== undefined && u.start === s.start && u.end === s.end && !isDirty(s) &&
        !mergedInto.has(owner) && !(ann && ann.sentenceIds.includes(u.id));
      if (fast) {
        // Untouched text: keep every content field; only positional fields can move.
        norms[si] = u.textNorm;
        hashes[si] = u.hash;
        unit = { ...u, ...positional(s, si) };
        if (unitsEqual(unit, u)) unit = u;
      } else {
        unit = evolve(si, u, owner, false);
      }
      if (unit.textNorm !== u.textNorm) result.report.edited.push(unit.id);
      else result.report.unchanged++;
    } else if (splitOf[si] !== -1) {
      const from = prev[splitOf[si]!]!;
      unit = evolve(si, from, splitOf[si]!, true);
      result.report.created.push(unit.id);
      result.report.split.push({ from: from.id, into: unit.id });
    } else {
      unit = create(si);
      result.report.created.push(unit.id);
    }
    result.units.push(unit);
    const before = prevById.get(unit.id);
    if (!before || before !== unit) {
      if (!before || !unitsEqual(before, unit)) result.upserts.push(unit);
    }
  }

  // Previous units that no segment kept.
  const leftovers: SentenceUnit[] = [];
  prev.forEach((u, pi) => {
    if (m.prevMatch[pi] === -1) leftovers.push(u);
  });
  for (const u of leftovers) {
    if (external) {
      // Never delete in external mode: keep all metadata, list for reattach or discard.
      const o: SentenceUnit = { ...u, orphaned: true };
      result.orphaned.push(o);
      result.report.orphaned.push(o.id);
    } else {
      result.removed.push(u.id);
    }
  }
  orphans.forEach((u, oi) => {
    if (m.orphanMatch[oi] === -1) result.orphaned.push(u);
  });
  return result;
}
