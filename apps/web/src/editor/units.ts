/**
 * Sentence units in CURRENT editor coordinates.
 *
 * The server owns unit identity and metadata; the editor owns positions between server patches: every
 * transaction maps the spans locally (start with assoc +1, end with assoc -1, exactly like core
 * `mapUnits`), so decorations follow typing instantly. Snapshots and patches (already mapped into current
 * coordinates by the document sync) replace them.
 */
import { StateEffect, StateField, type ChangeDesc, type EditorState, type Text } from '@codemirror/state';
import type { SentenceUnit } from '@paper-copilot/core';

export interface UnitsValue {
  /** Sorted by start (document order); non-overlapping. Collapsed units (start === end) are kept until the server removes them. */
  readonly units: readonly SentenceUnit[];
  readonly byId: ReadonlyMap<string, SentenceUnit>;
  /** Increments whenever the list changes (for cheap change detection). */
  readonly rev: number;
  /** True once the server sent units (snapshot), false before. */
  readonly loaded: boolean;
}

/** Replace all units (positions in the transaction's NEW document). */
export const setUnitsEffect = StateEffect.define<readonly SentenceUnit[]>();
/** Upsert/remove units (upserts already in the transaction's NEW document coordinates). */
export const patchUnitsEffect = StateEffect.define<{ upserts: readonly SentenceUnit[]; removed: readonly string[] }>();
/** Merge metadata of one unit (e.g. the reply of api.accept) without moving it. */
export const updateUnitMetaEffect = StateEffect.define<Partial<SentenceUnit> & { id: string }>();

const EMPTY: UnitsValue = { units: [], byId: new Map(), rev: 0, loaded: false };

function clamp(n: number, max: number): number {
  return n < 0 ? 0 : n > max ? max : n;
}

function normalize(list: readonly SentenceUnit[], doc: Text): SentenceUnit[] {
  const len = doc.length;
  const out: SentenceUnit[] = [];
  for (const u of list) {
    const start = clamp(u.start, len);
    let end = clamp(u.end, len);
    if (end < start) end = start;
    out.push(start !== u.start || end !== u.end ? { ...u, start, end, line: doc.lineAt(start).number } : u);
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

function build(list: SentenceUnit[], rev: number, loaded: boolean): UnitsValue {
  const byId = new Map<string, SentenceUnit>();
  for (const u of list) byId.set(u.id, u);
  return { units: list, byId, rev, loaded };
}

/** Map one unit through a change set (start assoc +1, end assoc -1). Returns the same object if unchanged. */
export function mapUnit(u: SentenceUnit, changes: ChangeDesc, doc: Text): SentenceUnit {
  const len = changes.length;
  const s0 = clamp(u.start, len);
  const e0 = clamp(u.end, len);
  let start = changes.mapPos(s0, 1);
  let end = changes.mapPos(e0, -1);
  if (end < start) end = start;
  if (start === u.start && end === u.end) return u;
  start = clamp(start, doc.length);
  end = clamp(end, doc.length);
  return { ...u, start, end, line: doc.lineAt(start).number };
}

export function mapUnitList(units: readonly SentenceUnit[], changes: ChangeDesc, doc: Text): SentenceUnit[] {
  const out = new Array<SentenceUnit>(units.length);
  for (let i = 0; i < units.length; i++) out[i] = mapUnit(units[i]!, changes, doc);
  return out;
}

export const unitsField = StateField.define<UnitsValue>({
  create: () => EMPTY,
  update(value, tr) {
    let v = value;
    if (tr.docChanged && v.units.length) {
      const mapped = mapUnitList(v.units, tr.changes, tr.state.doc);
      let changed = false;
      for (let i = 0; i < mapped.length; i++) if (mapped[i] !== v.units[i]) { changed = true; break; }
      if (changed) v = build(mapped, v.rev + 1, v.loaded);
    }
    for (const e of tr.effects) {
      if (e.is(setUnitsEffect)) {
        v = build(normalize(e.value, tr.state.doc), v.rev + 1, true);
      } else if (e.is(patchUnitsEffect)) {
        const removed = new Set(e.value.removed);
        const upserts = new Map<string, SentenceUnit>();
        for (const u of e.value.upserts) upserts.set(u.id, u);
        const next: SentenceUnit[] = [];
        for (const u of v.units) if (!removed.has(u.id) && !upserts.has(u.id)) next.push(u);
        for (const u of upserts.values()) if (!removed.has(u.id)) next.push(u);
        v = build(normalize(next, tr.state.doc), v.rev + 1, true);
      } else if (e.is(updateUnitMetaEffect)) {
        const cur = v.byId.get(e.value.id);
        if (cur) {
          // Never take positions from a metadata merge: they may refer to another document version.
          const { start: _s, end: _e, line: _l, ...meta } = e.value;
          const merged = { ...cur, ...meta };
          v = build(v.units.map((u) => (u === cur ? merged : u)), v.rev + 1, v.loaded);
        }
      }
    }
    return v;
  },
});

export function unitsOf(state: EditorState): readonly SentenceUnit[] {
  return state.field(unitsField).units;
}

/** Index of the first unit with end >= pos (units are sorted and non-overlapping, so ends are sorted too). */
export function firstEndingAtOrAfter(units: readonly SentenceUnit[], pos: number): number {
  let lo = 0;
  let hi = units.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (units[mid]!.end < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The unit containing pos (start <= pos <= end); at a shared boundary the unit that starts at pos wins over the one that ends there only if the latter is collapsed. */
export function unitAtPos(units: readonly SentenceUnit[], pos: number): SentenceUnit | null {
  const i = firstEndingAtOrAfter(units, pos);
  for (let k = i; k < units.length; k++) {
    const u = units[k]!;
    if (u.start > pos) break;
    if (u.end > u.start && u.start <= pos && pos <= u.end) return u;
  }
  return null;
}

/** Units intersecting [from, to] (inclusive ends), in document order. */
export function unitsInRange(units: readonly SentenceUnit[], from: number, to: number): SentenceUnit[] {
  const out: SentenceUnit[] = [];
  for (let k = firstEndingAtOrAfter(units, from); k < units.length; k++) {
    const u = units[k]!;
    if (u.start > to) break;
    if (u.end > u.start) out.push(u);
  }
  return out;
}

/** The last non-collapsed unit that ends at or before pos. */
export function unitBefore(units: readonly SentenceUnit[], pos: number): SentenceUnit | null {
  let i = firstEndingAtOrAfter(units, pos + 1) - 1;
  while (i >= 0) {
    const u = units[i]!;
    if (u.end > u.start && u.end <= pos) return u;
    i--;
  }
  return null;
}

/** Text of a unit in the current document. */
export function unitText(state: EditorState, u: SentenceUnit): string {
  return state.doc.sliceString(u.start, u.end);
}
