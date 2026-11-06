/**
 * Review (anchoring lens): seeded property-based fuzzing of sentence identity and provenance.
 *
 * A small PRNG (mulberry32, no new deps) drives hundreds of realistic edit sequences over the fixture
 * paper (LF, CRLF, one-sentence-per-line, with CJK intent lines): typing inside sentences, splitting,
 * merging, deleting paragraphs, pasting, CodeMirror moveLine, undo-like reversals, AI inserts and
 * rewrites (annotated like the server does, including the widening of named units), math with periods,
 * external diffs and semantic-lines normalization. After every segmentation pass the invariants below
 * are checked; violations are collected per invariant so that each one is reported by its own test.
 *
 * Invariants:
 *  I1 spans: every unit span is a valid slice and the units are exactly the fresh segments (1:1).
 *  I2 identity: a previous unit whose mapped span equals a new segment with the same normalized text,
 *     and whose span no change touched, keeps its id.
 *  I3 accounting: every previous id is still live, or reported in `removed` (local) / `orphaned`
 *     (external); removed ids are not live; ids are unique.
 *  I4 everAi monotone: a surviving id never goes everAi true -> false; an orphan keeps everAi.
 *  I5 no laundering by merge: AI text still present inside a new unit (mapped span overlap of a removed
 *     everAi unit) makes that unit everAi.
 *  I6 no laundering by move: within one pass, a new id whose normalized text equals that of a removed
 *     everAi unit is everAi (the AI sentence was moved, not written by the author).
 *  I7 idempotence: assignUnits on unchanged text (dirty [] and whole-document) changes nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import { assignUnits, changedRanges, diffChanges, mapUnits, reanchor, type AssignResult } from '../../src/anchor/units';
import { unitsEqual } from '../../src/anchor/assign';
import { segment, type Segmentation } from '../../src/latex/segment';
import { toSemanticLines } from '../../src/latex/lines';
import type { ChangeAnnotation } from '../../src/api';
import { AI_ORIGINS, type SentenceState, type SentenceUnit, type SentenceVersion, type VersionOrigin } from '../../src/schemas';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../../../fixtures/canto-demo/tex/main.tex', import.meta.url)), 'utf8');
const NOW = '2026-11-06T12:00:00.000Z';

/* ------------------------------------------------------------------------------------ */
/* PRNG                                                                                  */
/* ------------------------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(readonly next: () => number) {}
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/* ------------------------------------------------------------------------------------ */
/* Model of the server's anchoring loop                                                  */
/* ------------------------------------------------------------------------------------ */

function ann(origin: VersionOrigin, state: SentenceState | null, extra: Partial<ChangeAnnotation> = {}): ChangeAnnotation {
  const ai = AI_ORIGINS.includes(origin);
  return { origin, sentenceIds: [], state, model: ai ? 'claude-sonnet-5-5' : null, promptHash: ai ? 'ph' : null, instruction: null, lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null, ...extra };
}

type Range = { from: number; to: number };
type Violation = { seed: number; step: number; op: string; detail: string };
const CATS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7'] as const;
type Cat = (typeof CATS)[number];

const toText = (s: string): Text => Text.of(s.split('\n'));

class Doc {
  text: string;
  units: SentenceUnit[] = [];
  orphans: SentenceUnit[] = [];
  versions: SentenceVersion[] = [];
  seg!: Segmentation;
  /** Pending (debounced) local changes since the last pass. */
  dirty: Range[] = [];
  pendingCs: ChangeSet | null = null;
  pendingAnn: { annotation: ChangeAnnotation; range: Range | null } | null = null;
  /** Units mapped through the pending changes. */
  mapped: SentenceUnit[] = [];

  constructor(text: string, readonly report: (cat: Cat, detail: string) => void) {
    this.text = text;
    const seg = segment(text);
    const r = assignUnits({ ...this.base(), text, seg, prev: [], changeSource: 'external', annotation: ann('import', 'human'), annotatedRange: { from: 0, to: text.length } });
    this.absorb(r, seg);
    this.mapped = this.units;
  }

  base() {
    return {
      file: 'main.tex',
      now: NOW,
      lastVersion: (id: string) => {
        for (let i = this.versions.length - 1; i >= 0; i--) if (this.versions[i]!.sentenceId === id) return this.versions[i];
        return undefined;
      },
      lastAiVersion: (id: string) => {
        for (let i = this.versions.length - 1; i >= 0; i--) {
          const v = this.versions[i]!;
          if (v.sentenceId === id && AI_ORIGINS.includes(v.origin)) return v;
        }
        return undefined;
      },
    };
  }

  absorb(r: AssignResult, seg: Segmentation): void {
    this.units = r.units;
    this.versions.push(...r.versions);
    this.seg = seg;
  }

  /** One client transaction (like DocService.applyClientChange). An annotated change runs its pass at once. */
  local(specs: ChangeSpec | ChangeSpec[], annotation: ChangeAnnotation | null = null): void {
    if (annotation && this.dirty.length) this.pass('typing-before-ai');
    const cs = ChangeSet.of(specs, this.text.length, '\n');
    if (cs.empty) return;
    const next = cs.apply(toText(this.text)).toString();
    this.mapped = mapUnits(this.mapped, cs, next);
    const touched = changedRanges(cs);
    this.dirty = this.dirty.map((r) => ({ from: cs.mapPos(r.from, -1), to: cs.mapPos(r.to, 1) }));
    this.dirty.push(...touched);
    this.pendingCs = this.pendingCs ? this.pendingCs.compose(cs) : cs;
    this.text = next;
    if (annotation) {
      const range = touched.length ? { from: Math.min(...touched.map((r) => r.from)), to: Math.max(...touched.map((r) => r.to)) } : null;
      this.pendingAnn = { annotation, range };
      this.pass('ai');
    }
  }

  /** The debounced segmentation pass (DocService.runSegment), with invariant checks. */
  pass(op: string): void {
    if (this.dirty.length === 0 && !this.pendingAnn) return;
    const text = this.text;
    const seg = segment(text);
    let prev = this.mapped;
    const pend = this.pendingAnn;
    if (pend && pend.range && pend.annotation.sentenceIds.length) {
      const named = new Set(pend.annotation.sentenceIds);
      const r = pend.range;
      prev = prev.map((u) => (named.has(u.id) && u.start <= r.to && r.from <= u.end ? { ...u, start: Math.min(u.start, r.from), end: Math.max(u.end, r.to) } : u));
    }
    const dirty = this.dirty;
    const r = assignUnits({ ...this.base(), text, seg, prev, dirty, changeSource: 'local', annotation: pend?.annotation ?? null, annotatedRange: pend?.range ?? null });
    this.check(op, prev, r, seg, dirty, false);
    this.absorb(r, seg);
    this.mapped = this.units;
    this.dirty = [];
    this.pendingCs = null;
    this.pendingAnn = null;
    this.idempotence(op);
  }

  /** An external change (pull / disk): DocService.reloadFromDisk. */
  external(newText: string, op: string): void {
    this.pass('flush-before-external');
    if (newText === this.text) return;
    const seg = segment(newText);
    const cs = diffChanges(this.text, newText);
    const prevMapped = mapUnits(this.units, cs, newText);
    const r = reanchor(this.text, newText, seg, { ...this.base(), prev: [...this.units, ...this.orphans] });
    this.check(op, prevMapped, r, seg, changedRanges(cs), true, newText);
    this.text = newText;
    this.absorb(r, seg);
    this.orphans = r.orphaned;
    this.mapped = this.units;
    this.idempotence(op);
  }

  idempotence(op: string): void {
    const text = this.text;
    const seg = this.seg;
    for (const dirty of [[], undefined] as Array<Range[] | undefined>) {
      const r = assignUnits({ ...this.base(), text, seg, prev: this.units, ...(dirty ? { dirty } : {}), changeSource: 'local', annotation: null, annotatedRange: null });
      const changed = r.units.length !== this.units.length || r.units.some((u, i) => !unitsEqual(u, this.units[i]!));
      if (changed || r.versions.length || r.upserts.length || r.removed.length) {
        const diff = r.units.find((u, i) => !this.units[i] || !unitsEqual(u, this.units[i]!));
        const before = diff ? this.units.find((u) => u.start === diff.start) : undefined;
        this.report('I7', `${op}: re-assign of unchanged text (dirty=${dirty ? '[]' : 'all'}) changed ${r.upserts.length} unit(s), ${r.versions.length} version(s), ${r.removed.length} removed; e.g. ${JSON.stringify(diffFields(before, diff))}`);
      }
    }
    const rx = reanchor(text, text, seg, { ...this.base(), prev: [...this.units, ...this.orphans] });
    const changedX = rx.units.length !== this.units.length || rx.units.some((u, i) => u.id !== this.units[i]!.id || u.state !== this.units[i]!.state || u.everAi !== this.units[i]!.everAi);
    if (changedX || rx.versions.length) this.report('I7', `${op}: external reanchor(text, text) changed units or wrote ${rx.versions.length} version(s)`);
  }

  check(op: string, prev: SentenceUnit[], r: AssignResult, seg: Segmentation, dirty: Range[], external: boolean, text: string = this.text): void {
    const rep = (cat: Cat, d: string) => this.report(cat, `${op}: ${d}`);
    // I1: spans are valid slices, 1:1 with the fresh segmentation.
    const segs = [...seg.sentences].sort((a, b) => a.start - b.start || a.end - b.end);
    if (segs.length !== r.units.length) rep('I1', `${r.units.length} units for ${segs.length} segments`);
    r.units.forEach((u, i) => {
      if (!(u.start >= 0 && u.start <= u.end && u.end <= text.length)) rep('I1', `invalid span [${u.start},${u.end}) of ${u.id} (len ${text.length})`);
      const s = segs[i];
      if (!s || s.start !== u.start || s.end !== u.end) rep('I1', `unit ${i} [${u.start},${u.end}) != segment [${s?.start},${s?.end})`);
      else if (text.slice(u.start, u.end) !== s.text) rep('I1', `unit ${i} slice != segment text`);
    });
    const live = new Map(r.units.map((u) => [u.id, u]));
    if (live.size !== r.units.length) rep('I3', 'duplicate ids among live units');
    const removed = new Set(r.removed);
    const orphaned = new Map(r.orphaned.map((u) => [u.id, u]));
    // I3: accounting.
    for (const p of prev) {
      if (p.orphaned) continue;
      if (!live.has(p.id) && !removed.has(p.id) && !orphaned.has(p.id)) rep('I3', `unit ${p.id} (${JSON.stringify(p.textNorm.slice(0, 40))}) vanished without being reported`);
      if (external && removed.has(p.id)) rep('I3', `external pass removed ${p.id} instead of orphaning it`);
    }
    for (const id of removed) if (live.has(id)) rep('I3', `removed id ${id} is still live`);
    // I2: untouched identity.
    const segAt = new Map(r.units.map((u) => [`${u.start}:${u.end}`, u]));
    for (const p of prev) {
      if (p.orphaned || p.start >= p.end) continue;
      const n = segAt.get(`${p.start}:${p.end}`);
      if (!n || n.textNorm !== p.textNorm || n.kind !== p.kind) continue;
      if (dirty.some((d) => (d.from === d.to ? p.start <= d.from && d.from <= p.end : d.from < p.end && p.start < d.to))) continue;
      if (n.id !== p.id) rep('I2', `untouched sentence ${JSON.stringify(text.slice(p.start, p.end).slice(0, 50))} changed id ${p.id} -> ${n.id}`);
    }
    // I4: everAi monotone.
    for (const p of prev) {
      if (!p.everAi) continue;
      const n = live.get(p.id) ?? orphaned.get(p.id);
      if (n && !n.everAi) rep('I4', `everAi true -> false on ${p.id} (${n.state})`);
    }
    // I5: merged AI text keeps provenance.
    // (local passes only: their spans are mapped through the exact ChangeSet, so an overlap is literally
    // AI text still in the document; an external char diff may reuse letters of deleted text)
    for (const p of external ? [] : prev) {
      if (!p.everAi || p.orphaned || live.has(p.id) || p.start >= p.end) continue;
      for (const n of r.units) {
        const ov = Math.min(n.end, p.end) - Math.max(n.start, p.start);
        if (ov >= 8 && n.kind === p.kind && !n.everAi) rep('I5', `AI unit ${p.id} (${p.state}) removed, its text ${JSON.stringify(text.slice(Math.max(n.start, p.start), Math.min(n.end, p.end)).slice(0, 40))} now in ${n.state} unit ${n.id} with everAi=false`);
      }
    }
    // I6: a moved AI sentence keeps provenance.
    const goneAi = new Map<string, SentenceUnit>();
    for (const p of prev) if (p.everAi && !live.has(p.id)) goneAi.set(p.textNorm, p);
    const prevIds = new Set(prev.map((p) => p.id));
    for (const n of r.units) {
      if (prevIds.has(n.id) || n.everAi) continue;
      const g = goneAi.get(n.textNorm);
      if (g) rep('I6', `AI sentence ${JSON.stringify(n.textNorm.slice(0, 50))} (was ${g.state}, ${g.id}) re-created as ${n.state} ${n.id} with everAi=false`);
    }
  }
}

function diffFields(a: SentenceUnit | undefined, b: SentenceUnit | undefined): Record<string, unknown> {
  if (!a || !b) return { a: a?.id, b: b?.id };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(b) as Array<keyof SentenceUnit>) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = [a[k], b[k]];
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Edit generators                                                                       */
/* ------------------------------------------------------------------------------------ */

const WORDS = ['clearly', 'new', 'the', 'large', 'GNN', 'prompt', 'tracks', 'about', 'only', 'Fig.~\\ref{fig:eff}', 'e.g.', '$p_T$', 'et al.', '3.5', '\\cite{Ju2022Zenodo}'];
const AI_SENTENCES = [
  'The tracker keeps its lead at large displacement.',
  'We find no dependence on the particle species, see Fig.~\\ref{fig:eff}.',
  'The gain is $\\Delta\\epsilon = 2.3$ points at $p_T > 1.5$~GeV.',
  'This result holds for all three seeds.',
  'Section~\\ref{sec:method} gives the details, e.g. the matching rule.',
];
const HUMAN_SENTENCES = ['We checked this twice.', 'The value is $x = 0.5$ here.', 'Wang et al. disagree.', 'It works.'];
const CJK_LINES = ['这里需要说明为什么效率更高。', '结果：比基线高 2.3 个百分点', '注意：不要夸大结论'];

type Gen = { name: string; weight: number; run: (d: Doc, g: Rng) => void };

/** Live prose units in CURRENT coordinates (mapped through pending, not yet segmented changes). */
const liveProse = (d: Doc): SentenceUnit[] => d.mapped.filter((u) => u.kind === 'prose' && u.end > u.start);
/** Word boundaries strictly inside a span. */
function innerSpaces(text: string, u: { start: number; end: number }): number[] {
  const out: number[] = [];
  for (let i = u.start + 1; i < u.end - 1; i++) if (text[i] === ' ') out.push(i);
  return out;
}

const GENS: Gen[] = [
  {
    name: 'type-word',
    weight: 6,
    run: (d, g) => {
      const u = g.pick(liveProse(d));
      if (!u) return;
      const sp = innerSpaces(d.text, u);
      if (!sp.length) return;
      d.local({ from: g.pick(sp), insert: ' ' + g.pick(WORDS) });
    },
  },
  {
    name: 'type-chars',
    weight: 4,
    run: (d, g) => {
      const u = g.pick(liveProse(d));
      if (!u) return;
      const sp = innerSpaces(d.text, u);
      if (!sp.length) return;
      let at = g.pick(sp);
      for (const ch of ' and then') {
        d.local({ from: at, insert: ch });
        at++;
      }
      if (g.chance(0.5)) {
        d.local({ from: at - 4, to: at }); // backspace x4
      }
    },
  },
  {
    name: 'split',
    weight: 4,
    run: (d, g) => {
      const u = g.pick(liveProse(d));
      if (!u) return;
      const sp = innerSpaces(d.text, u);
      if (sp.length < 3) return;
      d.local({ from: sp[1 + g.int(sp.length - 2)]!, insert: '. Then' });
    },
  },
  {
    name: 'merge',
    weight: 4,
    run: (d, g) => {
      const ps = liveProse(d);
      const pairs: Array<[SentenceUnit, SentenceUnit]> = [];
      for (let i = 0; i + 1 < ps.length; i++) if (ps[i]!.paragraphId === ps[i + 1]!.paragraphId) pairs.push([ps[i]!, ps[i + 1]!]);
      if (!pairs.length) return;
      const [a, b] = g.pick(pairs);
      const end = a.end - 1;
      if (d.text[end] !== '.') return;
      d.local({ from: end, to: b.start, insert: ', and ' });
    },
  },
  {
    name: 'delete-paragraph',
    weight: 2,
    run: (d, g) => {
      d.pass('flush');
      const ps = d.seg.paragraphs.filter((p) => p.kind === 'prose');
      if (ps.length < 3) return;
      const p = g.pick(ps);
      d.local({ from: p.start, to: Math.min(d.text.length, p.end + (d.text[p.end] === '\n' ? 1 : 0)) });
    },
  },
  {
    name: 'delete-selection',
    weight: 2,
    run: (d, g) => {
      const ps = liveProse(d);
      if (ps.length < 2) return;
      const a = g.pick(ps);
      const from = a.start + g.int(Math.max(1, a.end - a.start));
      const to = Math.min(d.text.length, from + 1 + g.int(120));
      d.local({ from, to });
    },
  },
  {
    name: 'paste-sentence',
    weight: 3,
    run: (d, g) => {
      const ps = liveProse(d);
      const src = g.pick(ps);
      const dst = g.pick(ps);
      if (!src || !dst) return;
      d.local({ from: dst.end, insert: ' ' + d.text.slice(src.start, src.end) });
    },
  },
  {
    name: 'cut-paste-sentence',
    weight: 2,
    run: (d, g) => {
      const ps = liveProse(d);
      if (ps.length < 3) return;
      const src = g.pick(ps);
      const body = d.text.slice(src.start, src.end);
      const from = src.start;
      const to = Math.min(d.text.length, src.end + (d.text[src.end] === ' ' || d.text[src.end] === '\n' ? 1 : 0));
      d.local({ from, to });
      if (g.chance(0.5)) d.pass('cut');
      const dst = g.pick(liveProse(d));
      if (!dst) return;
      d.local({ from: dst.end, insert: ' ' + body });
    },
  },
  {
    name: 'move-line',
    weight: 4,
    run: (d, g) => {
      // CodeMirror moveLineDown / moveLineUp on one line (one transaction).
      const doc = toText(d.text);
      if (doc.lines < 3) return;
      const n = 2 + g.int(doc.lines - 2);
      const line = doc.line(n);
      if (g.chance(0.5) && n < doc.lines) {
        const next = doc.line(n + 1);
        d.local([{ from: line.to, to: next.to }, { from: line.from, insert: next.text + '\n' }]);
      } else {
        const prevL = doc.line(n - 1);
        d.local([{ from: prevL.from, to: line.from }, { from: line.to, insert: '\n' + prevL.text }]);
      }
    },
  },
  {
    name: 'undo',
    weight: 3,
    run: (d, g) => {
      // An edit and its exact inverse (the undo of CodeMirror history), possibly in a later pass.
      const u = g.pick(liveProse(d));
      if (!u) return;
      const sp = innerSpaces(d.text, u);
      if (!sp.length) return;
      const before = toText(d.text);
      const cs = ChangeSet.of({ from: g.pick(sp), insert: ' really' }, d.text.length, '\n');
      d.local(cs);
      if (g.chance(0.5)) d.pass('undo-mid');
      d.local(cs.invert(before));
    },
  },
  {
    name: 'math-periods',
    weight: 3,
    run: (d, g) => {
      const u = g.pick(liveProse(d));
      if (!u) return;
      const sp = innerSpaces(d.text, u);
      if (!sp.length) return;
      d.local({ from: g.pick(sp), insert: g.pick([' $a.b = 1.5$', ' \\(x. y\\)', ' $\\mathrm{e.g.}$', ' 0.55\\%', ' Eq.~(\\ref{eq:eff})']) });
    },
  },
  {
    name: 'cjk-intent-line',
    weight: 2,
    run: (d, g) => {
      const u = g.pick(liveProse(d));
      if (!u) return;
      d.local({ from: u.end, insert: '\n' + g.pick(CJK_LINES) + '\n' });
    },
  },
  {
    name: 'ai-insert',
    weight: 4,
    run: (d, g) => {
      const u = g.pick(liveProse(d));
      if (!u) return;
      const state = g.pick<SentenceState>(['proposed', 'proposed', 'ai-drafted', 'unsupported']);
      const origin: VersionOrigin = state === 'proposed' || state === 'unsupported' ? 'ai_draft' : 'ai_ghost';
      d.local({ from: u.end, insert: ' ' + g.pick(AI_SENTENCES) }, ann(origin, state));
    },
  },
  {
    name: 'ai-rewrite',
    weight: 4,
    run: (d, g) => {
      const u = g.pick(liveProse(d));
      if (!u) return;
      d.local({ from: u.start, to: u.end, insert: g.pick(AI_SENTENCES) }, ann('ai_rewrite', 'ai-drafted', { sentenceIds: [u.id] }));
    },
  },
  {
    name: 'accept',
    weight: 2,
    run: (d, g) => {
      d.pass('flush');
      const props = d.units.filter((u) => u.state === 'proposed');
      if (!props.length) return;
      const u = g.pick(props);
      d.units = d.units.map((x) => (x.id === u.id ? { ...x, state: 'ai-drafted', acceptedAt: NOW } : x));
      d.mapped = d.mapped.map((x) => (x.id === u.id ? { ...x, state: 'ai-drafted', acceptedAt: NOW } : x));
    },
  },
  {
    name: 'human-type-sentence',
    weight: 2,
    run: (d, g) => {
      const u = g.pick(liveProse(d));
      if (!u) return;
      d.local({ from: u.end, insert: ' ' + g.pick(HUMAN_SENTENCES) });
    },
  },
  {
    name: 'external-diff',
    weight: 4,
    run: (d, g) => {
      // A co-author edits on Overleaf: a few string-level changes, then a pull.
      let t = d.text;
      const k = 1 + g.int(3);
      for (let i = 0; i < k; i++) {
        const ps = segment(t).sentences.filter((s) => s.kind === 'prose');
        const s = g.pick(ps);
        if (!s) break;
        const choice = g.int(5);
        if (choice === 0) t = t.slice(0, s.start) + t.slice(s.start, s.end).replace(' the ', ' our ') + t.slice(s.end);
        else if (choice === 1) t = t.slice(0, s.end) + ' ' + g.pick(HUMAN_SENTENCES) + t.slice(s.end);
        else if (choice === 2) t = t.slice(0, s.start) + t.slice(s.end).replace(/^\s+/, '');
        else if (choice === 3) {
          // move a sentence to the end of another paragraph
          const body = t.slice(s.start, s.end);
          t = t.slice(0, s.start) + t.slice(s.end);
          const ps2 = segment(t).sentences.filter((x) => x.kind === 'prose');
          const dst = g.pick(ps2);
          if (dst) t = t.slice(0, dst.end) + ' ' + body + t.slice(dst.end);
        } else {
          const sp = innerSpaces(t, s);
          if (sp.length) t = t.slice(0, sp[0]!) + ' very' + t.slice(sp[0]!);
        }
      }
      d.external(t, 'external-diff');
    },
  },
  {
    name: 'semantic-lines',
    weight: 1,
    run: (d) => {
      d.pass('flush');
      const { text } = toSemanticLines(d.text, segment(d.text));
      d.external(text, 'semantic-lines');
    },
  },
];

const TOTAL_WEIGHT = GENS.reduce((n, x) => n + x.weight, 0);
function pickGen(g: Rng): Gen {
  let r = g.next() * TOTAL_WEIGHT;
  for (const x of GENS) {
    r -= x.weight;
    if (r < 0) return x;
  }
  return GENS[GENS.length - 1]!;
}

const BASES: Record<string, () => string> = {
  lf: () => FIXTURE,
  crlf: () => FIXTURE.replace(/\n/g, '\r\n'),
  semantic: () => toSemanticLines(FIXTURE, segment(FIXTURE)).text,
  cjk: () => FIXTURE.replace('The test set holds 8,710 targets.', 'The test set holds 8,710 targets.\n这里补充样本数的来源。'),
};

/* ------------------------------------------------------------------------------------ */
/* Run                                                                                   */
/* ------------------------------------------------------------------------------------ */

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 240);
const STEPS = Number(process.env.FUZZ_STEPS ?? 25);

const violations: Record<Cat, Violation[]> = { I1: [], I2: [], I3: [], I4: [], I5: [], I6: [], I7: [] };
const opsRun = new Map<string, number>();
let crashes: Violation[] = [];

function summarize(vs: Violation[]): string[] {
  // one example per (op, detail-shape), so the failure output stays readable
  const seen = new Map<string, Violation>();
  for (const v of vs) {
    const key = v.op + '|' + v.detail.replace(/[0-9A-Z]{26}/g, 'ID').replace(/"[^"]*"/g, '"…"').slice(0, 80);
    if (!seen.has(key)) seen.set(key, v);
  }
  return [...seen.values()].slice(0, 12).map((v) => `seed ${v.seed} step ${v.step} [${v.op}] ${v.detail}`);
}

beforeAll(() => {
  const baseNames = Object.keys(BASES);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const g = new Rng(mulberry32(seed * 7919));
    const baseName = baseNames[seed % baseNames.length]!;
    let step = 0;
    let op = 'import';
    const d = new Doc(BASES[baseName]!(), (cat, detail) => violations[cat].push({ seed, step, op: `${baseName}/${op}`, detail }));
    try {
      for (step = 1; step <= STEPS; step++) {
        const gen = pickGen(g);
        op = gen.name;
        opsRun.set(op, (opsRun.get(op) ?? 0) + 1);
        const dbg = process.env.FUZZ_DEBUG === `${seed}:${step}`;
        if (dbg) console.log('BEFORE', JSON.stringify(d.text), JSON.stringify(d.mapped.map((u) => [u.start, u.end, u.id.slice(-4), u.textNorm.slice(-12)])));
        gen.run(d, g);
        if (dbg) console.log('AFTER', JSON.stringify(d.text), JSON.stringify(d.mapped.map((u) => [u.start, u.end, u.id.slice(-4)])), JSON.stringify(d.dirty));
        if (g.chance(0.6)) d.pass(op);
        if (dbg) console.log('UNITS', JSON.stringify(d.units.map((u) => [u.start, u.end, u.id.slice(-4), JSON.stringify(d.text.slice(u.start, u.end).slice(-12)), u.textNorm.slice(-12)])));
      }
      op = 'final';
      d.pass('final');
    } catch (e) {
      crashes.push({ seed, step, op, detail: e instanceof Error ? (e.stack ?? e.message).split('\n').slice(0, 3).join(' | ') : String(e) });
    }
  }
  crashes = crashes.slice(0, 10);
}, 600_000);

describe(`anchoring fuzz (${SEEDS} seeds x ${STEPS} steps; LF, CRLF, semantic lines, CJK intent lines)`, () => {
  it('covers every edit generator', () => {
    for (const x of GENS) expect(opsRun.get(x.name) ?? 0, x.name).toBeGreaterThan(5);
  });
  it('never throws', () => {
    expect(crashes).toEqual([]);
  });
  it('I1: every unit span is a valid slice equal to a fresh segment', () => {
    expect(summarize(violations.I1)).toEqual([]);
  });
  it('I2: ids of untouched sentences never change', () => {
    expect(summarize(violations.I2)).toEqual([]);
  });
  it('I3: no unit is lost without being reported (removed / orphaned)', () => {
    expect(summarize(violations.I3)).toEqual([]);
  });
  it('I4: everAi never goes true -> false on a surviving or orphaned unit', () => {
    expect(summarize(violations.I4)).toEqual([]);
  });
  it('I5: AI text merged into another sentence keeps everAi', () => {
    expect(summarize(violations.I5)).toEqual([]);
  });
  it('I6: an AI sentence moved within one change keeps its provenance', () => {
    expect(summarize(violations.I6)).toEqual([]);
  });
  it('I7: assignUnits / reanchor are idempotent on unchanged text', () => {
    expect(summarize(violations.I7)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Deterministic reproductions of what the fuzzer found                                  */
/* ------------------------------------------------------------------------------------ */

describe('anchoring review: minimal reproductions', () => {
  const quiet = (cat: Cat, detail: string): void => void [cat, detail];

  it('CodeMirror moveLine over an AI "proposed" sentence keeps it proposed and everAi (one-sentence-per-line layout)', () => {
    const base = toSemanticLines(FIXTURE, segment(FIXTURE)).text;
    const d = new Doc(base, quiet);
    const anchor = 'The test set holds 8,710 targets.';
    const at = d.text.indexOf(anchor) + anchor.length;
    const ai = 'This result holds for all three seeds.';
    // a drafted sentence inserted on its own line (mode B draft), not yet reviewed
    d.local({ from: at, insert: '\n' + ai }, ann('ai_draft', 'proposed'));
    const drafted = d.units.find((u) => d.text.slice(u.start, u.end) === ai)!;
    expect(drafted).toMatchObject({ state: 'proposed', everAi: true });
    // Alt+ArrowDown on the line above it (CodeMirror moveLineDown): ONE transaction that deletes the AI
    // line and re-inserts its text above.
    const doc = toText(d.text);
    const line = doc.lineAt(d.text.indexOf(anchor));
    const next = doc.line(line.number + 1);
    expect(next.text).toBe(ai);
    d.local([{ from: line.to, to: next.to }, { from: line.from, insert: next.text + '\n' }]);
    d.pass('move-line');
    const moved = d.units.filter((u) => d.text.slice(u.start, u.end) === ai);
    expect(moved).toHaveLength(1);
    // The author only moved a line; the sentence is still unreviewed AI text. It must not become the
    // author's own 'human' sentence (that also lets `paper push` send it to the co-authors).
    expect(moved[0]).toMatchObject({ everAi: true, state: 'proposed' });
  });

  it('Alt+Up on an AI line keeps the human neighbour it jumps over (same id, history)', () => {
    const base = toSemanticLines(FIXTURE, segment(FIXTURE)).text;
    const d = new Doc(base, quiet);
    const anchor = 'The test set holds 8,710 targets.';
    const at = d.text.indexOf(anchor) + anchor.length;
    const ai = 'This result holds for all three seeds.';
    d.local({ from: at, insert: '\n' + ai }, ann('ai_draft', 'proposed'));
    const human = d.units.find((u) => d.text.slice(u.start, u.end) === anchor)!;
    const doc = toText(d.text);
    const line = doc.lineAt(d.text.indexOf(ai));
    const prevL = doc.line(line.number - 1);
    expect(prevL.text).toBe(anchor);
    d.local([{ from: prevL.from, to: line.from }, { from: line.to, insert: '\n' + prevL.text }]);
    d.pass('move-line-up');
    expect(d.units.find((u) => d.text.slice(u.start, u.end) === anchor)).toMatchObject({ id: human.id, state: human.state });
    expect(d.units.find((u) => d.text.slice(u.start, u.end) === ai)).toMatchObject({ everAi: true, state: 'proposed' });
  });

  it('cut in one pass and paste in a later one: a recently removed AI unit passed back as an orphan re-attaches by exact hash', () => {
    const d = new Doc(FIXTURE, quiet);
    const anchor = 'This lead holds for every particle species.';
    const at = d.text.indexOf(anchor) + anchor.length;
    const ai = 'The gain is largest at large displacement.';
    d.local({ from: at, insert: ' ' + ai }, ann('ai_draft', 'proposed'));
    const u0 = d.units.find((u) => d.text.slice(u.start, u.end) === ai)!;
    // cut (pass 1)
    d.local({ from: u0.start - 1, to: u0.end });
    const cut = assignUnits({ ...d.base(), text: d.text, seg: segment(d.text), prev: d.mapped, dirty: d.dirty, changeSource: 'local', annotation: null, annotatedRange: null });
    expect(cut.removed).toContain(u0.id);
    const recentlyRemoved = d.units.filter((u) => cut.removed.includes(u.id)).map((u) => ({ ...u, orphaned: true }));
    d.absorb(cut, segment(d.text));
    d.mapped = d.units;
    d.dirty = [];
    // paste at the end of the first prose sentence (pass 2), with the removed unit offered for re-attachment
    const dst = d.units.find((u) => u.kind === 'prose')!;
    d.local({ from: dst.end, insert: ' ' + ai });
    const paste = assignUnits({ ...d.base(), text: d.text, seg: segment(d.text), prev: [...d.mapped, ...recentlyRemoved], dirty: d.dirty, changeSource: 'local', annotation: null, annotatedRange: null });
    const back = paste.units.find((u) => d.text.slice(u.start, u.end) === ai)!;
    expect(back).toMatchObject({ id: u0.id, everAi: true, state: 'proposed', orphaned: false });
    expect(paste.upserts.map((u) => u.id)).toContain(u0.id);
    expect(paste.orphaned).toEqual([]);
    expect(paste.versions.filter((v) => v.sentenceId === u0.id)).toEqual([]);
  });

  it('deleting the last word of a paragraph-final sentence records the edit (no stale hash/textNorm, a version row)', () => {
    const d = new Doc(FIXTURE, quiet);
    const sentence = 'This lead holds for every particle species.';
    const u0 = d.units.find((u) => d.text.slice(u.start, u.end) === sentence)!;
    expect(u0).toBeTruthy();
    const versionsBefore = d.versions.length;
    // Ctrl+Backspace twice: " species." deleted at the very end of the sentence
    d.local({ from: u0.end - ' species.'.length, to: u0.end });
    d.pass('delete-end');
    const u1 = d.units.find((u) => u.id === u0.id)!;
    const now = d.text.slice(u1.start, u1.end);
    expect(now).toBe('This lead holds for every particle');
    expect(u1.textNorm).not.toContain('species');
    expect(d.versions.length).toBe(versionsBefore + 1);
  });

  it('deleting the first word of a paragraph-first sentence records the edit', () => {
    const d = new Doc(FIXTURE, quiet);
    const sentence = 'On validation, the same comparison gave a smaller difference (see Table~\\ref{tab:eff}).';
    const u0 = d.units.find((u) => d.text.slice(u.start, u.end) === sentence)!;
    expect(u0).toBeTruthy();
    d.local({ from: u0.start, to: u0.start + 'On validation, '.length });
    d.pass('delete-start');
    const u1 = d.units.find((u) => u.id === u0.id)!;
    expect(d.text.slice(u1.start, u1.end).startsWith('the same comparison')).toBe(true);
    expect(u1.textNorm.startsWith('the same comparison')).toBe(true);
  });

  it('an accepted AI sentence whose last words the author deletes becomes ai-edited with an edit pair', () => {
    const d = new Doc(FIXTURE, quiet);
    const anchor = 'This lead holds for every particle species.';
    const at = d.text.indexOf(anchor) + anchor.length;
    const ai = 'The gain is largest at large displacement.';
    d.local({ from: at, insert: ' ' + ai }, ann('ai_ghost', 'ai-drafted'));
    const u0 = d.units.find((u) => d.text.slice(u.start, u.end) === ai)!;
    expect(u0).toMatchObject({ state: 'ai-drafted', everAi: true });
    d.local({ from: u0.end - ' at large displacement.'.length, to: u0.end });
    const ids: string[] = [];
    const res = assignUnits({ ...d.base(), text: d.text, seg: segment(d.text), prev: d.mapped, dirty: d.dirty, changeSource: 'local', annotation: null, annotatedRange: null });
    for (const p of res.editPairs) ids.push(p.sentenceId);
    const u1 = res.units.find((u) => u.id === u0.id)!;
    expect(d.text.slice(u1.start, u1.end)).toBe('The gain is largest');
    expect(u1.state).toBe('ai-edited');
    expect(ids).toContain(u0.id);
  });
});
