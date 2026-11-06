/**
 * An in-browser emulation of the paper-copilot server for the editor harness. It keeps a mirror of the
 * text, applies `doc.change` messages exactly like the real DocService (version check, mapUnits, dirty
 * ranges, debounced re-segmentation with core `segment` + `assignUnits`, immediate re-segmentation for
 * annotated changes) and answers ghost requests and sentence actions with canned, fixture-grounded text.
 */
import { ChangeSet, Text } from '@codemirror/state';
import {
  assignUnits,
  changedRanges,
  mapUnits,
  nowIso,
  reanchor,
  segment,
  shortId,
  wordDiff,
  type ChangeAnnotation,
  type ClientMessage,
  type Fact,
  type HistoryResponse,
  type LintFlag,
  type Outline,
  type Proposal,
  type Segmentation,
  type SentenceUnit,
  type SentenceVersion,
  type ServerMessage,
} from '@paper-copilot/core';
import { linkSentenceFacts } from '@paper-copilot/core';
import { matchesOf, numeralsOf } from '../../src/editor/safe';
import {
  ACTION_MODEL,
  buildOutline,
  cannedAlternatives,
  cannedGrammar,
  cannedIntent,
  cannedRewrite,
  DEMO_STATES,
  FIXTURE_FACTS,
  GHOST_MODEL,
  ghostContinuation,
  LINT_SEEDS,
  prepareFixtureText,
} from './fixtureData';

const IMPORT: ChangeAnnotation = {
  origin: 'import',
  sentenceIds: [],
  state: null,
  model: null,
  promptHash: null,
  instruction: null,
  lang: null,
  intentNote: null,
  factIds: [],
  citeKeys: [],
  move: null,
  requestId: null,
};

function textOf(s: string): Text {
  return Text.of(s.split('\n'));
}

function linkFacts(text: string, facts: Fact[]): string[] {
  try {
    return linkSentenceFacts(text, facts).linked;
  } catch {
    const ids = new Set<string>();
    for (const tok of numeralsOf(text)) {
      if (tok.structural) continue;
      const m = matchesOf(tok, facts);
      if (m.length === 1) ids.add(m[0]!.factId);
    }
    return [...ids];
  }
}

export interface FakeServerOptions {
  /** Repeat the fixture body this many times (performance checks). */
  repeat?: number;
  ghostDelayMs?: number;
  actionDelayMs?: number;
  debounceMs?: number;
}

export class FakeServer {
  readonly file = 'main.tex';
  text: string;
  version = 1;
  units: SentenceUnit[] = [];
  seg: Segmentation;
  outline: Outline;
  facts: Fact[] = FIXTURE_FACTS;
  lint: LintFlag[] = [];
  versions = new Map<string, SentenceVersion[]>();
  received: ClientMessage[] = [];
  /** Snapshots sent because a change was rejected (version mismatch). */
  rejections = 0;
  ghostDelayMs: number;
  actionDelayMs: number;
  debounceMs: number;
  private dirty: Array<{ from: number; to: number }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ghostTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    raw: string,
    private readonly emit: (m: ServerMessage) => void,
    opts: FakeServerOptions = {},
  ) {
    this.ghostDelayMs = opts.ghostDelayMs ?? 380;
    this.actionDelayMs = opts.actionDelayMs ?? 260;
    this.debounceMs = opts.debounceMs ?? 300;
    this.text = prepareFixtureText(raw, opts.repeat ?? 1);
    this.seg = segment(this.text);
    const res = assignUnits({
      file: this.file,
      text: this.text,
      seg: this.seg,
      prev: [],
      lastVersion: (id) => this.lastVersion(id),
      lastAiVersion: (id) => this.lastAiVersion(id),
      changeSource: 'external',
      annotation: IMPORT,
      now: nowIso(),
    });
    this.recordVersions(res.versions);
    this.units = res.units.map((u) => this.withDemoState({ ...u, facts: linkFacts(this.unitText(u), this.facts) }));
    this.outline = buildOutline(this.seg);
    this.lint = this.buildLint();
  }

  /* ------------------------------------------------------------------ bookkeeping */

  unitText(u: SentenceUnit): string {
    return this.text.slice(u.start, u.end);
  }

  unit(id: string): SentenceUnit | undefined {
    return this.units.find((u) => u.id === id);
  }

  private lastVersion(id: string): SentenceVersion | undefined {
    const v = this.versions.get(id);
    return v ? v[v.length - 1] : undefined;
  }

  private lastAiVersion(id: string): SentenceVersion | undefined {
    const v = this.versions.get(id) ?? [];
    for (let i = v.length - 1; i >= 0; i--) if (['ai_ghost', 'ai_intent', 'ai_draft', 'ai_rewrite', 'grammar_fix', 'replan'].includes(v[i]!.origin)) return v[i];
    return undefined;
  }

  private recordVersions(rows: SentenceVersion[]): void {
    for (const r of rows) {
      const list = this.versions.get(r.sentenceId) ?? [];
      list.push(r);
      this.versions.set(r.sentenceId, list);
    }
  }

  private withDemoState(u: SentenceUnit): SentenceUnit {
    const text = this.unitText(u);
    const d = DEMO_STATES.find((s) => text.startsWith(s.prefix));
    if (!d) return u;
    const ai = d.state !== 'human' && d.state !== 'external' && d.state !== 'placeholder';
    const ts = new Date(Date.now() - 1000 * 60 * (12 + Math.floor(Math.random() * 90))).toISOString();
    const next: SentenceUnit = {
      ...u,
      state: d.state,
      model: d.model ?? null,
      everAi: ai || d.state === 'external' ? ai : u.everAi,
      editDistance: d.editDistance ?? (ai ? 0 : null),
      intentNote: d.intentNote ?? null,
      move: d.move ?? null,
      imported: false,
      createdAt: ts,
      acceptedAt: d.state === 'proposed' || d.state === 'unsupported' ? null : ts,
    };
    if (ai)
      this.recordVersions([
        {
          sentenceId: u.id,
          version: (this.lastVersion(u.id)?.version ?? -1) + 1,
          ts,
          text,
          origin: d.state === 'ai-from-intent' ? 'ai_intent' : 'ai_draft',
          model: d.model ?? null,
          promptHash: 'ph-demo',
          instruction: d.intentNote ?? null,
          lang: d.intentNote ? 'zh' : null,
          parentVersion: this.lastVersion(u.id)?.version ?? null,
          editDistance: d.editDistance ?? 0,
        },
      ]);
    return next;
  }

  private buildLint(): LintFlag[] {
    const out: LintFlag[] = [];
    for (const seed of LINT_SEEDS) {
      const u = this.units.find((x) => this.unitText(x).startsWith(seed.prefix));
      if (!u) continue;
      out.push({ ...seed.flag, id: `lint-${seed.flag.check}-${u.id.slice(-6)}`, sentenceId: u.id, line: u.line, excerpt: this.unitText(u).slice(0, 80), dismissed: false });
    }
    return out;
  }

  snapshot(): Extract<ServerMessage, { type: 'doc.snapshot' }> {
    return { type: 'doc.snapshot', file: this.file, version: this.version, text: this.text, units: this.units, intentLines: segment(this.text).intentLines };
  }

  /* ------------------------------------------------------------------ messages */

  handle(msg: ClientMessage): void {
    this.received.push(msg);
    switch (msg.type) {
      case 'doc.open':
        if (msg.file === this.file) {
          this.flush();
          this.emit(this.snapshot());
          this.emit({ type: 'lint.update', file: this.file, version: this.version, flags: this.lint, scope: 'document', sentenceIds: [] });
        }
        break;
      case 'doc.change':
        this.applyChange(msg);
        break;
      case 'doc.flush':
        this.flush();
        break;
      case 'ghost.request':
        this.ghost(msg);
        break;
      case 'ghost.cancel': {
        const t = this.ghostTimers.get(msg.requestId);
        if (t) clearTimeout(t);
        this.ghostTimers.delete(msg.requestId);
        break;
      }
      default:
        break;
    }
  }

  private applyChange(msg: Extract<ClientMessage, { type: 'doc.change' }>): void {
    if (msg.file !== this.file) return;
    if (msg.baseVersion !== this.version) {
      this.rejections++;
      this.flush();
      this.emit(this.snapshot());
      return;
    }
    let cs: ChangeSet;
    try {
      cs = ChangeSet.fromJSON(msg.changes);
    } catch {
      this.emit(this.snapshot());
      return;
    }
    if (cs.length !== this.text.length) {
      this.rejections++;
      this.emit(this.snapshot());
      return;
    }
    const newText = cs.apply(textOf(this.text)).toString();
    this.dirty = this.dirty.map((r) => ({ from: cs.mapPos(r.from, -1), to: cs.mapPos(r.to, 1) }));
    const ranges = changedRanges(cs);
    this.dirty.push(...ranges);
    this.units = mapUnits(this.units, cs, newText);
    this.text = newText;
    this.version++;
    this.emit({ type: 'doc.ack', file: this.file, version: this.version });
    if (msg.annotation) {
      const from = Math.min(...ranges.map((r) => r.from));
      const to = Math.max(...ranges.map((r) => r.to));
      this.resegment(msg.annotation, ranges.length ? { from, to } : null);
    } else {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.resegment(null, null), this.debounceMs);
    }
  }

  flush(): void {
    if (this.timer) this.resegment(null, null);
  }

  private resegment(annotation: ChangeAnnotation | null, annotatedRange: { from: number; to: number } | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const seg = segment(this.text);
    this.seg = seg;
    const res = assignUnits({
      file: this.file,
      text: this.text,
      seg,
      prev: this.units,
      lastVersion: (id) => this.lastVersion(id),
      lastAiVersion: (id) => this.lastAiVersion(id),
      dirty: this.dirty,
      changeSource: 'local',
      annotation,
      annotatedRange,
      now: nowIso(),
    });
    this.dirty = [];
    this.recordVersions(res.versions);
    const upsertIds = new Set(res.upserts.map((u) => u.id));
    const relinked = new Map<string, SentenceUnit>();
    for (const u of res.units) {
      if (!upsertIds.has(u.id)) continue;
      const facts = annotation && annotation.factIds.length && u.facts.length ? u.facts : linkFacts(this.text.slice(u.start, u.end), this.facts);
      relinked.set(u.id, { ...u, facts });
    }
    this.units = res.units.map((u) => relinked.get(u.id) ?? u);
    this.emit({ type: 'sentences.patch', file: this.file, version: this.version, upserts: [...relinked.values()], removed: res.removed, intentLines: seg.intentLines });
  }

  private ghost(msg: Extract<ClientMessage, { type: 'ghost.request' }>): void {
    const t = setTimeout(() => {
      this.ghostTimers.delete(msg.requestId);
      const r = ghostContinuation(msg.prefix);
      if (!r) {
        this.emit({ type: 'ghost.empty', requestId: msg.requestId, reason: 'no grounded suggestion' });
        return;
      }
      this.emit({
        type: 'ghost.result',
        requestId: msg.requestId,
        version: msg.version,
        cursor: msg.cursor,
        text: r.text,
        factIds: r.factIds,
        citeKeys: [],
        fulfilledMoveIds: [],
        issues: [],
        model: GHOST_MODEL,
        promptHash: `ph-${shortId()}`,
      });
    }, this.ghostDelayMs);
    this.ghostTimers.set(msg.requestId, t);
  }

  /* ------------------------------------------------------------------ REST emulation */

  private proposal(id: string | null, before: string, text: string, origin: Proposal['origin'], extra: Partial<Proposal> = {}): Proposal {
    let diff: Array<[number, string]>;
    try {
      diff = wordDiff(before, text);
    } catch {
      diff = before === text ? [[0, text]] : [[-1, before], [1, text]];
    }
    return {
      proposalId: shortId('p-'),
      sentenceId: id,
      text,
      diff,
      notes: '',
      drift: null,
      issues: [],
      factIds: linkFacts(text, this.facts),
      citeKeys: [],
      origin,
      model: ACTION_MODEL,
      promptHash: `ph-${shortId()}`,
      ...extra,
    };
  }

  private need(id: string): SentenceUnit {
    this.flush();
    const u = this.unit(id);
    if (!u) throw new Error(`unknown sentence ${id}`);
    return u;
  }

  instruct(id: string, instruction: string): Proposal {
    const u = this.need(id);
    const before = this.unitText(u);
    const r = cannedRewrite(before, instruction);
    const issues = before.includes('more than acorn') ? [{ code: 'claim_strength', severity: 'warn' as const, message: '“more” is a result verb: the baseline stays in the sentence' }] : [];
    return this.proposal(id, before, r.text, 'ai_rewrite', { notes: r.notes, drift: r.drift, issues });
  }

  grammar(id: string): Proposal {
    const u = this.need(id);
    const before = this.unitText(u);
    const r = cannedGrammar(before);
    return this.proposal(id, before, r.text, 'grammar_fix', { notes: r.notes });
  }

  alternatives(id: string, n: number): Proposal[] {
    const u = this.need(id);
    const before = this.unitText(u);
    return cannedAlternatives(before)
      .slice(0, n)
      .map((t) => this.proposal(id, before, t, 'ai_rewrite', { notes: '' }));
  }

  renderIntent(note: string, n: number): Proposal[] {
    return cannedIntent(note, n).map((t) => this.proposal(null, '', t, 'ai_intent', { notes: '已按你的笔记写成一句英文，没有引入新的数字。' }));
  }

  accept(id: string): SentenceUnit {
    const u = this.need(id);
    const next: SentenceUnit = { ...u, state: 'ai-drafted', acceptedAt: nowIso(), everAi: true };
    this.units = this.units.map((x) => (x.id === id ? next : x));
    this.emit({ type: 'sentences.patch', file: this.file, version: this.version, upserts: [next], removed: [], intentLines: segment(this.text).intentLines });
    return next;
  }

  reject(id: string): { replacement: string } {
    const u = this.need(id);
    const text = this.unitText(u).replace(/[.?!]\s*$/, '');
    return { replacement: `[claim: ${text}?]` };
  }

  history(id: string): HistoryResponse {
    const u = this.need(id);
    return { unit: u, versions: this.versions.get(id) ?? [] };
  }

  /** A co-author edit arriving from outside (pull / disk): doc.replace with re-anchored units. */
  externalEdit(): void {
    this.flush();
    const old = this.text;
    const next = old.replace('The principal limitation is that all results are within one simulated detector without pileup.', 'The main limitation is that all results come from one simulated detector without pileup.');
    if (next === old) return;
    const seg = segment(next);
    const res = reanchor(old, next, seg, {
      file: this.file,
      prev: this.units,
      lastVersion: (id) => this.lastVersion(id),
      lastAiVersion: (id) => this.lastAiVersion(id),
      now: nowIso(),
    });
    this.recordVersions(res.versions);
    this.text = next;
    this.units = res.units;
    this.version++;
    this.emit({ type: 'doc.replace', file: this.file, version: this.version, text: next, units: res.units, intentLines: seg.intentLines, report: res.report });
  }
}
