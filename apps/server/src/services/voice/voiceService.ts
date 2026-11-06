/**
 * VoiceService: the author's corpus, memo, edit pairs, exemplar retrieval, measured norms and the
 * style-distance meter (docs/design.md, "Skill and voice system").
 *
 * Files (.paper/voice): corpus.jsonl (CorpusEntry rows), memo.md, edit_pairs.jsonl, stats.json (cached
 * author norms keyed by a fingerprint of the unassisted corpus, so any corpus change invalidates them).
 * Only entries marked `unassisted` feed exemplars and norms: text written with AI help would teach the
 * model its own register.
 */
import { Bm25Index, CorpusEntry, EditPair, SKILL_CORPUS_NORMS, furthestSentences, hashString, styleDistance, styleFeatures, ulid, type StyleDistanceResponse, type StyleFeatures } from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx, type VoiceService } from '../../contracts';
import { canonicalSectionType, entrySentences, toPlain, type CorpusSentence, type SectionType } from './corpusText';

/** Restrict exemplars to the requested section type only when it has at least this many sentences. */
export const MIN_SECTION_SENTENCES = 20;

const MAX_MEMO_CHARS = 100_000;

const VoiceStats = z.object({
  fingerprint: z.string(),
  computedAt: z.string(),
  sentences: z.number().int(),
  author: z.record(z.string(), z.number()).nullable(),
  corpusNorms: z.record(z.string(), z.number()),
});
type VoiceStats = z.infer<typeof VoiceStats>;

/** Rows of the author-vs-corpus table (block A) and of the meter. */
const TABLE_ROWS: Array<{ key: Exclude<keyof StyleFeatures, 'words'>; label: string; fmt: (n: number) => string }> = [
  { key: 'medianLen', label: 'median sentence length (words)', fmt: (n) => n.toFixed(0) },
  { key: 'p90Len', label: '90th-percentile length (words)', fmt: (n) => n.toFixed(0) },
  { key: 'verbPos', label: 'main verb position (median word)', fmt: (n) => n.toFixed(0) },
  { key: 'passiveShare', label: 'passive sentences', fmt: (n) => `${Math.round(n * 100)}%` },
  { key: 'weRate', label: 'we/our per 1k words', fmt: (n) => n.toFixed(1) },
  { key: 'hedgeRate', label: 'hedges per 1k words', fmt: (n) => n.toFixed(1) },
  { key: 'intensifierRate', label: 'intensifiers per 1k words', fmt: (n) => n.toFixed(1) },
  { key: 'connectorOpenerRate', label: 'Moreover/Furthermore openers per 1k', fmt: (n) => n.toFixed(1) },
  { key: 'inflatedRate', label: 'inflated words per 1k', fmt: (n) => n.toFixed(1) },
  { key: 'dashRate', label: 'dashes per 1k words', fmt: (n) => n.toFixed(1) },
];

function featuresRecord(f: StyleFeatures): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(f)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

function asFeatures(r: Record<string, number>): StyleFeatures {
  // Defaults only for fields an older stats.json may lack; never the corpus's word count.
  const { words: _corpusWords, ...defaults } = SKILL_CORPUS_NORMS;
  void _corpusWords;
  return { ...defaults, ...r } as StyleFeatures;
}

export function createVoiceService(ctx: Ctx): VoiceService {
  const p = ctx.paths;

  let corpusCache: CorpusEntry[] | null = null;
  let sentenceCache: CorpusSentence[] | null = null;
  let index: { bm25: Bm25Index; byId: Map<string, CorpusSentence>; counts: Map<string, number> } | null = null;
  let normsCache: { fingerprint: string; features: StyleFeatures | null } | null = null;
  // Serialize writes to corpus.jsonl (append vs full rewrite must not interleave).
  let writeChain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn);
    writeChain = run.catch(() => undefined);
    return run;
  };

  let fingerprintCache: string | null = null;
  let statsChain: Promise<void> = Promise.resolve();
  const invalidate = () => {
    fingerprintCache = null;
    corpusCache = null;
    sentenceCache = null;
    index = null;
    normsCache = null;
  };

  const corpus = (): CorpusEntry[] => {
    if (!corpusCache) {
      const rows = ctx.files.readJsonl(p.corpus, CorpusEntry);
      // Last row wins for a repeated id (defensive; the file is rewritten whole on updates).
      const byId = new Map<string, CorpusEntry>();
      for (const r of rows) byId.set(r.id, r);
      corpusCache = [...byId.values()];
    }
    return corpusCache.map((e) => ({ ...e }));
  };

  /** Plain sentences of the UNASSISTED corpus, in corpus order. */
  const unassistedSentences = (): CorpusSentence[] => {
    if (!sentenceCache) {
      const out: CorpusSentence[] = [];
      const seen = new Set<string>();
      for (const e of corpus()) {
        if (!e.unassisted) continue;
        for (const s of entrySentences(e)) {
          const key = s.text.toLowerCase();
          if (seen.has(key)) continue; // the same sentence imported twice must not weigh twice
          seen.add(key);
          out.push(s);
        }
      }
      sentenceCache = out;
    }
    return sentenceCache;
  };

  const fingerprint = (): string => {
    if (fingerprintCache) return fingerprintCache;
    const parts = corpus()
      .filter((e) => e.unassisted)
      .map((e) => `${e.id}:${e.sectionType}:${hashString(e.text)}`)
      .sort();
    fingerprintCache = hashString(`v1|${parts.join('|')}`);
    return fingerprintCache;
  };

  const getIndex = () => {
    if (!index) {
      const sents = unassistedSentences();
      const counts = new Map<string, number>();
      for (const s of sents) counts.set(s.sectionType, (counts.get(s.sectionType) ?? 0) + 1);
      index = {
        bm25: new Bm25Index(sents.map((s) => ({ id: s.id, text: s.text, tags: [`st:${s.sectionType}`] }))),
        byId: new Map(sents.map((s) => [s.id, s])),
        counts,
      };
    }
    return index;
  };

  const writeCorpus = async (rows: CorpusEntry[]) => {
    await ctx.files.writeText(p.corpus, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  };

  const addCorpus = (entries: Array<Omit<CorpusEntry, 'id'>>): Promise<CorpusEntry[]> =>
    serial(async () => {
      const added: CorpusEntry[] = [];
      for (const raw of entries) {
        const text = typeof raw?.text === 'string' ? raw.text.replace(/\r\n?/g, '\n').trim() : '';
        if (!text) continue;
        const entry = CorpusEntry.parse({
          id: ulid(),
          text,
          source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim().slice(0, 500) : 'manual',
          sectionType: canonicalSectionType(raw.sectionType),
          unassisted: raw.unassisted === true,
        });
        await ctx.files.appendJsonl(p.corpus, entry);
        added.push(entry);
      }
      if (added.length) invalidate();
      return added;
    });

  const setUnassisted = (id: string, unassisted: boolean): Promise<void> =>
    serial(async () => {
      const rows = corpus();
      const row = rows.find((r) => r.id === id);
      if (!row) throw new HttpError(404, `no corpus entry ${id}`);
      if (row.unassisted === unassisted) return;
      row.unassisted = unassisted;
      await writeCorpus(rows);
      invalidate();
    });

  const memo = (): string => ctx.files.readText(p.memo) ?? '';
  const setMemo = async (text: string): Promise<void> => {
    if (typeof text !== 'string') throw new HttpError(400, 'memo must be a string');
    if (text.length > MAX_MEMO_CHARS) throw new HttpError(413, `memo longer than ${MAX_MEMO_CHARS} characters`);
    await ctx.files.writeText(p.memo, text.replace(/\r\n?/g, '\n'));
  };

  const editPairs = (): EditPair[] => ctx.files.readJsonl(p.editPairs, EditPair);
  const addEditPairs = async (pairs: EditPair[]): Promise<void> => {
    for (const pair of pairs) {
      const r = EditPair.safeParse(pair);
      if (!r.success) {
        ctx.log.warn('voice: dropping invalid edit pair', r.error.message.slice(0, 200));
        continue;
      }
      if (r.data.aiText === r.data.humanText) continue;
      await ctx.files.appendJsonl(p.editPairs, r.data);
    }
  };

  const exemplars = (sectionType: string, query: string, k: number): string[] => {
    const n = Math.max(0, Math.min(50, Math.floor(k)));
    if (n === 0) return [];
    const idx = getIndex();
    if (idx.byId.size === 0) return [];
    const st: SectionType = canonicalSectionType(sectionType);
    const restrict = (idx.counts.get(st) ?? 0) >= MIN_SECTION_SENTENCES;
    const tags = restrict ? [`st:${st}`] : undefined;
    const q = toPlain(query ?? '').trim();
    const out: string[] = [];
    const seen = new Set<string>();
    if (q) {
      // Restricted: only this section type. Not restricted (too few sentences of the type): its own
      // matches first, then matches from the whole unassisted corpus.
      const passes: Array<string[] | undefined> = restrict ? [tags] : (idx.counts.get(st) ?? 0) > 0 ? [[`st:${st}`], undefined] : [undefined];
      for (const t of passes) {
        for (const hit of idx.bm25.search(q, n * 2, t)) {
          const s = idx.byId.get(hit.id);
          if (!s || seen.has(s.text)) continue;
          seen.add(s.text);
          out.push(s.text);
          if (out.length >= n) return out;
        }
      }
    }
    // Too few lexical matches: fill with sentences of the same type (then any type), in corpus order,
    // preferring typical lengths (8..40 words) so a stray heading or a 70-word sentence is not a model.
    const pool = unassistedSentences();
    const typical = (s: CorpusSentence) => {
      const w = s.text.split(/\s+/).length;
      return w >= 8 && w <= 40;
    };
    const tiers: Array<(s: CorpusSentence) => boolean> = [
      (s) => s.sectionType === st && typical(s),
      (s) => s.sectionType === st,
      ...(restrict ? [] : [(s: CorpusSentence) => typical(s), () => true]),
    ];
    for (const ok of tiers) {
      for (const s of pool) {
        if (out.length >= n) return out;
        if (!ok(s) || seen.has(s.text)) continue;
        seen.add(s.text);
        out.push(s.text);
      }
    }
    return out;
  };

  const authorNorms = (): StyleFeatures | null => {
    const fp = fingerprint();
    if (normsCache && normsCache.fingerprint === fp) return normsCache.features;
    const cached = ctx.files.readJson<VoiceStats | null>(p.voiceStats, VoiceStats.nullable(), null);
    if (cached && cached.fingerprint === fp) {
      normsCache = { fingerprint: fp, features: cached.author ? asFeatures(cached.author) : null };
      return normsCache.features;
    }
    const sents = unassistedSentences().map((s) => s.text);
    const features = sents.length > 0 ? styleFeatures(sents) : null;
    normsCache = { fingerprint: fp, features };
    const stats: VoiceStats = {
      fingerprint: fp,
      computedAt: new Date().toISOString(),
      sentences: sents.length,
      author: features ? featuresRecord(features) : null,
      corpusNorms: featuresRecord(SKILL_CORPUS_NORMS),
    };
    // Writes are chained so an older snapshot can never land after a newer one.
    statsChain = statsChain
      .then(() => ctx.files.writeJson(p.voiceStats, stats))
      .catch((e) => ctx.log.warn('voice: cannot write stats.json', String(e)));
    return features;
  };

  const authorNormsTable = (): string => {
    const a = authorNorms();
    const c = SKILL_CORPUS_NORMS;
    const lines: string[] = [];
    if (a) {
      lines.push(`Measured style of the author's unassisted writing (${a.n} sentences) beside the skill's five-paper corpus.`);
      lines.push('', '| feature | author | corpus |', '|---|---|---|');
      for (const r of TABLE_ROWS) lines.push(`| ${r.label} | ${r.fmt(a[r.key])} | ${r.fmt(c[r.key])} |`);
      lines.push('', 'Where the two differ, write like the author.');
    } else {
      lines.push('No unassisted author corpus yet; the targets are the skill corpus norms.');
      lines.push('', '| feature | corpus |', '|---|---|');
      for (const r of TABLE_ROWS) lines.push(`| ${r.label} | ${r.fmt(c[r.key])} |`);
    }
    return lines.join('\n');
  };

  const styleDistanceFor = (scope: 'document' | 'section' | 'paragraph', id?: string): StyleDistanceResponse => {
    if ((scope === 'section' || scope === 'paragraph') && !id) throw new HttpError(400, `scope ${scope} needs an id`);
    const units = ctx.docs
      .allUnits()
      .filter((u) => u.kind === 'prose' && !u.orphaned)
      .filter((u) => (scope === 'section' ? u.sectionId === id : scope === 'paragraph' ? u.paragraphId === id : !id || u.file === id));
    if (units.length === 0 && id) throw new HttpError(404, `no prose sentences in ${scope} ${id}`);
    const sents: Array<{ id: string; text: string }> = [];
    for (const u of units) {
      const src = ctx.docs.unitText(u.id);
      if (!src) continue;
      const text = toPlain(src);
      if (text) sents.push({ id: u.id, text });
    }
    const features = styleFeatures(sents.map((s) => s.text));
    const author = authorNorms();
    const target = author ?? SKILL_CORPUS_NORMS;
    const toCorpus = sents.length ? styleDistance(features, SKILL_CORPUS_NORMS).distance : 0;
    const toAuthor = author ? (sents.length ? styleDistance(features, author).distance : 0) : null;
    const furthest = sents.length >= 2 ? furthestSentences(sents, target, 3).map((f) => ({ sentenceId: f.id, contribution: f.contribution, why: f.why })) : [];
    return {
      scope: scope === 'document' ? (id ? `document:${id}` : 'document') : `${scope}:${id}`,
      toAuthor,
      toCorpus,
      corpusSize: author ? author.n : 0,
      furthest,
      features: featuresRecord(features),
      authorFeatures: author ? featuresRecord(author) : null,
      corpusFeatures: featuresRecord(SKILL_CORPUS_NORMS),
    };
  };

  return {
    corpus,
    addCorpus,
    setUnassisted,
    memo,
    setMemo,
    editPairs,
    addEditPairs,
    exemplars,
    authorNorms,
    authorNormsTable,
    styleDistance: styleDistanceFor,
  };
}
