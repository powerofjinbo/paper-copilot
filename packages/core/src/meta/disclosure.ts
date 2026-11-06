/**
 * Disclosure generator (docs/design.md, "Faithfulness and provenance"): counts from the sentence log and the
 * venue texts built only from those counts.
 *
 * Principle: every number in a text comes from DisclosureStats, and every statement about review or checking
 * is made only when the log supports it. The log shows (a) which sentences an AI touched and how (version
 * origins), (b) which AI sentences the authors then accepted, edited or rewrote (sentence states), and (c)
 * which AI sentences carry numbers linked to result-file entries and resolved citation keys (unit facts and
 * cites). It does not show that a person re-derived a number, so no text claims that.
 */
import { AI_ORIGINS, type SentenceState, type SentenceUnit, type SentenceVersion, type Venue, type VersionOrigin } from '../schemas';
import { GRAMMAR_MAX_EDIT_DISTANCE, grammarOnlyReasons } from '../gate/meaning';

export interface DisclosureStats {
  totalSentences: number;
  byState: Record<SentenceState, number>;
  /** Sentences ever touched by AI (everAi), whatever their state now. */
  everAi: number;
  /** Drafted by AI from the outline and result files, accepted without edits. */
  aiDrafted: number;
  /** Drafted by AI, then edited by the authors; with the mean word-level edit distance. */
  aiEdited: number;
  meanEditDistance: number | null;
  /** Rendered from the authors' own notes (e.g. Chinese intent notes). */
  aiFromIntent: number;
  /** Grammar/language polish only. */
  grammarFixed: number;
  /** Existed when the document was imported (provenance before the log is unknown). */
  imported: number;
  humanWritten: number;
  external: number;
  /** Distinct model ids seen in versions. */
  models: string[];
  firstTs: string | null;
  lastTs: string | null;
  /*
   * Added fields (optional so hand-built stats stay valid; renderDisclosure claims nothing a missing field
   * would have to support).
   */
  /** AI-touched sentences whose only AI change was a grammar/language fix (Springer: copy editing). */
  grammarOnly?: number;
  /** AI-touched sentences the authors then rewrote themselves (state human). */
  aiRewrittenByAuthors?: number;
  /** AI-touched sentences later changed outside the app by co-authors (state external). */
  aiChangedExternally?: number;
  /** AI-touched sentences not yet reviewed: proposed or unsupported. */
  aiPendingReview?: number;
  /** AI-touched sentences now reduced to a placeholder (rejected or unsupported claim). */
  aiPlaceholders?: number;
  /** Reviewed AI-touched sentences with numbers linked to result-file entries (non-empty `facts`). */
  aiWithFacts?: number;
  /** Reviewed AI-touched sentences with citation keys (non-empty `cites`). */
  aiWithCites?: number;
  /** Reviewed AI-touched sentences that still contain a placeholder. */
  aiOpenPlaceholders?: number;
  /** Sentences that still contain a placeholder ([fact?], [ref], [claim: ...?]). */
  openPlaceholders?: number;
  /** AI-origin versions in the log (including those of sentences since deleted). */
  aiVersions?: number;
  /** Languages of the authors' notes that AI sentences were rendered from (e.g. ["zh"]). */
  intentLanguages?: string[];
  /**
   * The authors' own sentences rewritten by the tool on their instruction and accepted unchanged (state
   * ai-drafted, AI versions only ai_rewrite). Not included in `aiDrafted` (they were not drafted from the
   * outline); undefined in older stats, which then count them in `aiDrafted`.
   */
  aiRewrittenOnRequest?: number;
}

const STATES: readonly SentenceState[] = ['human', 'ai-from-intent', 'ai-drafted', 'ai-edited', 'proposed', 'external', 'placeholder', 'unsupported'];
const AI_ORIGIN_SET = new Set<VersionOrigin>(AI_ORIGINS);
/** States that only AI text can be in. */
const AI_STATES = new Set<SentenceState>(['ai-drafted', 'ai-edited', 'ai-from-intent', 'proposed', 'unsupported']);

/**
 * Counts for the disclosure. Orphaned units (no longer in the text) are not counted as sentences; their
 * versions still count toward `models`, `firstTs`/`lastTs` and `aiVersions`, since the tools were used.
 * `firstTs`/`lastTs` span the AI-origin versions (when AI was used), null if there were none.
 * `everAi` is the union of the unit flag and AI-origin versions, because it can never be cleared.
 * `imported` counts imported sentences no AI touched; `humanWritten` counts sentences in state human that
 * were neither imported nor AI-touched; `external` counts sentences in state external no AI touched.
 */
/**
 * Is a grammar_fix version a minimal language fix of the version it was applied to? Needs that parent
 * version's text (no parent in the log: not provable, so no) and an edit distance within the limit.
 */
function minimalGrammarFix(v: SentenceVersion, all: SentenceVersion[]): boolean {
  if (typeof v.editDistance === 'number' && Number.isFinite(v.editDistance) && v.editDistance > GRAMMAR_MAX_EDIT_DISTANCE) return false;
  const parent =
    (v.parentVersion !== null && v.parentVersion !== undefined ? all.find((p) => p.version === v.parentVersion && p !== v) : undefined) ??
    [...all].filter((p) => p.version < v.version).sort((a, b) => b.version - a.version)[0];
  if (!parent || typeof parent.text !== 'string' || typeof v.text !== 'string') return false;
  try {
    return grammarOnlyReasons(parent.text, v.text).length === 0;
  } catch {
    return false;
  }
}

export function computeDisclosureStats(units: SentenceUnit[], versions: SentenceVersion[]): DisclosureStats {
  const live = (units ?? []).filter((u) => !u.orphaned);
  const bySentence = new Map<string, SentenceVersion[]>();
  for (const v of versions ?? []) {
    let list = bySentence.get(v.sentenceId);
    if (!list) bySentence.set(v.sentenceId, (list = []));
    list.push(v);
  }
  const byState = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<SentenceState, number>;

  const models = new Set<string>();
  const intentLangs = new Set<string>();
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let aiVersions = 0;
  for (const v of versions ?? []) {
    if (!AI_ORIGIN_SET.has(v.origin)) continue;
    aiVersions++;
    if (v.model) models.add(v.model);
    if (v.origin === 'ai_intent' && v.lang) intentLangs.add(v.lang);
    const t = Date.parse(v.ts);
    if (Number.isNaN(t)) continue;
    if (firstTs === null || t < Date.parse(firstTs)) firstTs = v.ts;
    if (lastTs === null || t > Date.parse(lastTs)) lastTs = v.ts;
  }

  let everAi = 0, aiDrafted = 0, aiEdited = 0, aiFromIntent = 0, grammarFixed = 0, imported = 0, humanWritten = 0, external = 0;
  let grammarOnly = 0, rewritten = 0, changedExt = 0, pending = 0, aiPlaceholders = 0, aiWithFacts = 0, aiWithCites = 0, aiOpen = 0, openPlaceholders = 0;
  let editSum = 0, editN = 0, rewrittenOnRequest = 0;
  for (const u of live) {
    byState[u.state] = (byState[u.state] ?? 0) + 1;
    const vs = bySentence.get(u.id) ?? [];
    const aiOrigins = new Set(vs.filter((v) => AI_ORIGIN_SET.has(v.origin)).map((v) => v.origin));
    const ai = u.everAi || aiOrigins.size > 0 || AI_STATES.has(u.state);
    const gfix = u.grammarFixed || aiOrigins.has('grammar_fix');
    if (gfix) grammarFixed++;
    if (u.state === 'placeholder' || u.placeholders.length > 0) openPlaceholders++;
    if (u.model) models.add(u.model);
    if (u.state === 'ai-drafted') {
      const rewriteOnly = aiOrigins.size > 0 && [...aiOrigins].every((o) => o === 'ai_rewrite');
      if (rewriteOnly) rewrittenOnRequest++;
      else aiDrafted++;
    }
    if (u.state === 'ai-from-intent') aiFromIntent++;
    if (u.state === 'ai-edited') {
      aiEdited++;
      if (typeof u.editDistance === 'number' && Number.isFinite(u.editDistance)) {
        editSum += Math.min(1, Math.max(0, u.editDistance));
        editN++;
      }
    }
    if (!ai) {
      if (u.imported && u.state !== 'external') imported++;
      else if (u.state === 'human') humanWritten++;
      if (u.state === 'external') external++;
      continue;
    }
    everAi++;
    // Only a grammar fix, known from the versions (a flag without versions is not proof of "only"), and
    // each grammar_fix version really is one: no negation or direction change, a few content words at
    // most, against the text it was applied to. A "grammar fix" that changed the claim is an AI rewrite.
    const allGrammar = aiOrigins.size > 0 && [...aiOrigins].every((o) => o === 'grammar_fix');
    const onlyGrammar = allGrammar && vs.filter((v) => v.origin === 'grammar_fix').every((v) => minimalGrammarFix(v, vs));
    let reviewed = false;
    switch (u.state) {
      case 'proposed':
      case 'unsupported':
        pending++;
        break;
      case 'placeholder':
        aiPlaceholders++;
        break;
      case 'human':
        reviewed = true;
        if (onlyGrammar) grammarOnly++;
        else if (allGrammar) rewrittenOnRequest++; // the author's sentence, substantively rewritten by the tool on request
        else rewritten++;
        break;
      case 'external':
        reviewed = true;
        if (onlyGrammar) grammarOnly++;
        else changedExt++;
        break;
      default:
        reviewed = true;
    }
    if (reviewed && u.facts.length > 0) aiWithFacts++;
    if (reviewed && u.cites.length > 0) aiWithCites++;
    if (reviewed && u.placeholders.length > 0) aiOpen++;
  }

  return {
    totalSentences: live.length,
    byState,
    everAi,
    aiDrafted,
    aiEdited,
    meanEditDistance: editN > 0 ? editSum / editN : null,
    aiFromIntent,
    grammarFixed,
    imported,
    humanWritten,
    external,
    models: [...models].sort(),
    firstTs,
    lastTs,
    grammarOnly,
    aiRewrittenByAuthors: rewritten,
    aiChangedExternally: changedExt,
    aiPendingReview: pending,
    aiPlaceholders,
    aiWithFacts,
    aiWithCites,
    aiOpenPlaceholders: aiOpen,
    openPlaceholders,
    aiVersions,
    intentLanguages: [...intentLangs].sort(),
    aiRewrittenOnRequest: rewrittenOnRequest,
  };
}

export interface DisclosureText {
  /** LaTeX to paste (e.g. an \section*{Declaration ...} for Elsevier, an acknowledgments sentence for APS). */
  latex: string;
  plain: string;
  /** Where it goes, in words ("Acknowledgments or Methods (APS)", "above the references (Elsevier)"...). */
  placement: string;
}

/* ------------------------------------------------------------------------------------ */
/* Text helpers                                                                          */
/* ------------------------------------------------------------------------------------ */

/** Escapes text for LaTeX (also keeps hyphenated ids such as claude-haiku-5-5 from forming en dashes). */
export function texEscapeDisclosure(s: string): string {
  return s
    .replace(/[\\{}$&#^_%~]/g, (c) => {
      switch (c) {
        case '\\': return '\\textbackslash{}';
        case '~': return '\\textasciitilde{}';
        case '^': return '\\textasciicircum{}';
        default: return '\\' + c;
      }
    })
    .replace(/-(?=-)/g, '-{}');
}

/** "Claude Sonnet 5.5" for claude-sonnet-5-5 (and dated snapshots); unknown ids are returned as they are. */
export function modelDisplayName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(?:\[[^\]]*\])?$/i.exec(id.trim());
  if (!m) return id;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  return `Claude ${family} ${m[2]}.${m[3]}`;
}

const LANG_NAMES: Record<string, string> = { zh: 'Chinese', 'zh-cn': 'Chinese', 'zh-tw': 'Chinese', ja: 'Japanese', ko: 'Korean', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', ru: 'Russian', pt: 'Portuguese' };

function langName(code: string): string | null {
  return LANG_NAMES[code.toLowerCase()] ?? null;
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const sent = (n: number): string => (n === 1 ? 'sentence' : 'sentences');
const was = (n: number): string => (n === 1 ? 'was' : 'were');

/**
 * A run of text in two renderings. `t` is literal text (escaped for LaTeX), `tt` a monospace span, `pct` a
 * percent sign.
 */
type Piece = { t: string } | { tt: string } | { pct: true };
const T = (t: string): Piece => ({ t });

function render(pieces: Piece[], mode: 'latex' | 'plain'): string {
  return pieces
    .map((p) => {
      if ('t' in p) return mode === 'latex' ? texEscapeDisclosure(p.t) : p.t;
      if ('tt' in p) return mode === 'latex' ? `\\texttt{${texEscapeDisclosure(p.tt)}}` : p.tt;
      return mode === 'latex' ? '\\%' : '%';
    })
    .join('');
}

interface Facts {
  s: DisclosureStats;
  tool: string;
  models: string;
  substantive: number;
  pending: number;
  aiPlaceholders: number;
  openPlaceholders: number | null;
  grammarOnly: number;
  rewritten: number;
  changedExt: number;
}

function facts(stats: DisclosureStats, opts: { toolName: string; toolVersion: string }): Facts {
  const grammarOnly = stats.grammarOnly ?? 0;
  const tool = [opts.toolName, opts.toolVersion].filter((x) => x && x.trim().length > 0).join(' ').trim() || 'a writing tool';
  const names = [...new Set(stats.models.map(modelDisplayName))];
  const claude = names.filter((n) => n.startsWith('Claude ')).length;
  const vendor = claude === 0 ? '' : claude === names.length ? ' (Anthropic)' : ' (Claude models by Anthropic, and others)';
  const models = names.length > 0 ? `the large language model${names.length > 1 ? 's' : ''} ${listJoin(names)}${vendor}` : 'a large language model';
  return {
    s: stats,
    tool,
    models,
    substantive: Math.max(0, stats.everAi - grammarOnly),
    pending: stats.aiPendingReview ?? 0,
    aiPlaceholders: stats.aiPlaceholders ?? 0,
    openPlaceholders: stats.openPlaceholders ?? null,
    grammarOnly,
    rewritten: stats.aiRewrittenByAuthors ?? 0,
    changedExt: stats.aiChangedExternally ?? 0,
  };
}

/** "how they assisted", with counts; the parts partition the AI-touched sentences. */
function assistance(f: Facts): Piece[] {
  const s = f.s;
  const parts: Piece[][] = [];
  if (s.aiDrafted > 0) parts.push([T(`${s.aiDrafted} ${sent(s.aiDrafted)} ${was(s.aiDrafted)} drafted by the tool from the authors' outline and result files and accepted without change`)]);
  const onRequest = s.aiRewrittenOnRequest ?? 0;
  if (onRequest > 0) parts.push([T(`${onRequest} of the authors' ${sent(onRequest)} ${was(onRequest)} rewritten by the tool on the authors' instructions and accepted`)]);
  if (s.aiEdited > 0) {
    const p: Piece[] = [T(`${s.aiEdited} ${sent(s.aiEdited)} ${was(s.aiEdited)} drafted by the tool and then edited by the authors`)];
    if (s.meanEditDistance !== null) {
      const pct = s.meanEditDistance * 100;
      p.push(T(` (mean word-level edit distance ${pct > 0 && pct < 0.5 ? 'below 1' : Math.round(pct)}`), { pct: true }, T(')'));
    }
    parts.push(p);
  }
  if (s.aiFromIntent > 0) {
    const langs = (s.intentLanguages ?? []).map(langName).filter((x): x is string => x !== null && x !== 'English');
    const from = langs.length > 0 ? `the authors' own notes in ${listJoin([...new Set(langs)])}` : "the authors' own notes";
    parts.push([T(`${s.aiFromIntent} ${sent(s.aiFromIntent)} ${was(s.aiFromIntent)} rendered into English from ${from}`)]);
  }
  if (f.rewritten > 0) parts.push([T(`${f.rewritten} ${sent(f.rewritten)} drafted with the tool ${was(f.rewritten)} then rewritten by the authors`)]);
  if (f.changedExt > 0) parts.push([T(`${f.changedExt} ${sent(f.changedExt)} drafted with the tool ${was(f.changedExt)} later revised by co-authors outside the tool`)]);
  if (f.grammarOnly > 0) parts.push([T(`${f.grammarOnly} ${sent(f.grammarOnly)} received grammar and language corrections only`)]);
  if (f.aiPlaceholders > 0) parts.push([T(`${f.aiPlaceholders} AI-proposed ${sent(f.aiPlaceholders)} ${was(f.aiPlaceholders)} rejected by the authors and replaced by placeholders`)]);
  if (f.pending > 0) parts.push([T(`${f.pending} AI-proposed ${sent(f.pending)} still await${f.pending === 1 ? 's' : ''} review`)]);
  const out: Piece[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(T(i === parts.length - 1 ? (parts.length > 2 ? ', and ' : ' and ') : ', '));
    out.push(...p);
  });
  return out;
}

/** "how the authors directed and verified", limited to what the log shows. */
function verification(f: Facts): string {
  const s = f.s;
  const out: string[] = [];
  const reviewed = Math.max(0, s.everAi - f.pending - f.aiPlaceholders);
  // Sentences the AI drafted or rendered (not grammar-only) that the authors then accepted, edited or rewrote.
  const reviewedDrafts = Math.max(0, reviewed - f.grammarOnly);
  if (s.aiPendingReview === undefined) {
    // Hand-built stats without the review counts: make no review claim.
  } else if (f.pending === 0) {
    if (reviewedDrafts > 0) out.push('The authors reviewed each AI-drafted sentence individually and accepted, edited or rewrote it.');
  } else {
    out.push(`This statement was generated while ${f.pending} AI-proposed ${sent(f.pending)} ${was(f.pending)} still unreviewed; it must be regenerated after the review.`);
  }
  if (s.aiWithFacts !== undefined && s.aiWithCites !== undefined && reviewed > 0) {
    const bits: string[] = [];
    if (s.aiWithFacts > 0) bits.push(`${s.aiWithFacts} ${s.aiWithFacts === 1 ? 'states' : 'state'} numbers linked to entries in the analysis result files`);
    if (s.aiWithCites > 0) bits.push(`${s.aiWithCites} ${s.aiWithCites === 1 ? 'cites' : 'cite'} references from the bibliography`);
    if (bits.length > 0) {
      let t = `Of the reviewed AI-assisted sentences, ${listJoin(bits)}`;
      const open = s.aiOpenPlaceholders;
      if (open === 0) t += '; none contains an unresolved placeholder for a number or a reference';
      else if (open !== undefined && open > 0) t += `; ${open} still contain${open === 1 ? 's' : ''} a placeholder for a missing number or reference`;
      out.push(t + '.');
    }
  }
  if (f.openPlaceholders !== null && f.openPlaceholders > 0 && (s.aiOpenPlaceholders === undefined || f.openPlaceholders > s.aiOpenPlaceholders)) {
    out.push(`In the whole text, ${f.openPlaceholders} ${sent(f.openPlaceholders)} still contain${f.openPlaceholders === 1 ? 's' : ''} a placeholder.`);
  }
  return out.join(' ');
}

function provenanceTail(f: Facts): string {
  const s = f.s;
  const bits: string[] = [];
  if (s.humanWritten > 0) bits.push(`${s.humanWritten} ${was(s.humanWritten)} written by the authors without AI assistance`);
  if (s.imported > 0) bits.push(`${s.imported} predate${s.imported === 1 ? 's' : ''} the tool's record and ${was(s.imported)} not changed with the tool`);
  if (s.external > 0) bits.push(`${s.external} ${was(s.external)} contributed by co-authors outside the tool`);
  return bits.length > 0 ? `Of the other sentences, ${listJoin(bits)}.` : '';
}

function recordSentence(recordPath: string): Piece[] {
  const p = (recordPath ?? '').trim();
  if (!p) return [];
  return [T('A per-sentence record of every AI-assisted change (model, time, instruction, and the text before and after) is kept at '), { tt: p }, T('.')];
}

function join(...parts: Piece[][]): Piece[] {
  const out: Piece[] = [];
  for (const p of parts) {
    if (p.length === 0) continue;
    if (out.length > 0) out.push(T(' '));
    out.push(...p);
  }
  return out;
}

const plainPieces = (s: string): Piece[] => (s ? [T(s)] : []);
const ended = (p: Piece[]): Piece[] => (p.length > 0 ? [...p, T('.')] : []);

/** The common body: tools, how they assisted, how verified, the rest of the text, the record. */
function body(f: Facts, recordPath: string, opening: string): Piece[] {
  const s = f.s;
  const intro = plainPieces(`${opening} Of the ${s.totalSentences} ${sent(s.totalSentences)} in the text, ${s.everAi} ${was(s.everAi)} produced or changed with the tool:`);
  return join(intro, ended(assistance(f)), plainPieces(verification(f)), plainPieces(provenanceTail(f)), recordSentence(recordPath));
}

function noAiBody(f: Facts, recordPath: string): Piece[] {
  const s = f.s;
  const first =
    s.imported > 0
      ? `The record kept by ${f.tool} shows no AI-generated or AI-edited text in this manuscript (${s.totalSentences} ${sent(s.totalSentences)}); of these, ${s.imported} predate${s.imported === 1 ? 's' : ''} the record, which therefore does not cover how ${s.imported === 1 ? 'it was' : 'they were'} written.`
      : `The record kept by ${f.tool} shows no AI-generated or AI-edited text in this manuscript (${s.totalSentences} ${sent(s.totalSentences)}).`;
  const parts: Piece[][] = [plainPieces(first)];
  const p = (recordPath ?? '').trim();
  if (p) parts.push([T('The record is kept at '), { tt: p }, T('.')]);
  return join(...parts);
}

/** Purpose clause for Elsevier's "in order to [REASON]", from what the log shows. */
function purpose(f: Facts): string {
  const s = f.s;
  const r: string[] = [];
  if (s.aiDrafted + s.aiEdited + f.rewritten + f.changedExt + f.pending + f.aiPlaceholders > 0) r.push("draft sentences from the authors' outline and analysis results");
  if ((s.aiRewrittenOnRequest ?? 0) > 0) r.push("rewrite the authors' sentences on their instructions");
  if (s.aiFromIntent > 0) r.push("render the authors' notes into English");
  if (f.grammarOnly > 0) r.push('correct grammar and language');
  return r.length > 0 ? listJoin(r) : 'assist with the text';
}

/**
 * Venue rules: APS (June 2026 policy): name tools and versions, how they assisted (with counts), how
 * the authors directed and verified the output (every number and citation checked against result files
 * and the bibliography; every sentence reread), and that records are kept (path). Elsevier: a section
 * titled "Declaration of generative AI and AI-assisted technologies in the writing process" above the
 * references. Springer/JHEP: a Methods-section paragraph (copy-editing alone needs no declaration).
 * arXiv: one comment line reporting significant use. Never claim more verification than the log shows.
 */
export function renderDisclosure(venue: Venue, stats: DisclosureStats, opts: { toolName: string; toolVersion: string; recordPath: string }): DisclosureText {
  const f = facts(stats, opts);
  const recordPath = opts.recordPath ?? '';
  const opening = `We used ${f.tool}, a writing tool that calls ${f.models}, to assist with the text of this manuscript.`;
  const both = (pieces: Piece[]): { latex: string; plain: string } => ({ latex: render(pieces, 'latex'), plain: render(pieces, 'plain') });

  switch (venue) {
    case 'aps': {
      const pieces = stats.everAi === 0 ? noAiBody(f, recordPath) : body(f, recordPath, opening);
      return { ...both(pieces), placement: 'Acknowledgments or Methods section (APS policy on AI-assisted writing): paste into the acknowledgments environment or the Methods section.' };
    }
    case 'elsevier': {
      const title = 'Declaration of generative AI and AI-assisted technologies in the writing process';
      let pieces: Piece[];
      if (stats.everAi === 0) {
        pieces = noAiBody(f, recordPath);
      } else {
        const lead = plainPieces(`During the preparation of this work the authors used ${f.tool}, which calls ${f.models}, in order to ${purpose(f)}. Of the ${stats.totalSentences} ${sent(stats.totalSentences)} in the text, ${stats.everAi} ${was(stats.everAi)} produced or changed with the tool:`);
        const responsibility =
          f.pending === 0 && stats.aiPendingReview !== undefined
            ? 'After using this tool, the authors reviewed and edited the content as needed and take full responsibility for the content of the publication.'
            : 'The authors take full responsibility for the content of the publication.';
        pieces = join(lead, ended(assistance(f)), plainPieces(verification(f)), plainPieces(responsibility), recordSentence(recordPath));
      }
      const b = both(pieces);
      return { latex: `\\section*{${title}}\n${b.latex}`, plain: `${title}\n\n${b.plain}`, placement: 'A separate section titled as above, placed directly before the references (Elsevier).' };
    }
    case 'springer': {
      if (stats.everAi === 0) {
        return { ...both(noAiBody(f, recordPath)), placement: 'Not required (Springer Nature / JHEP): the record shows no AI use; keep this text for your own records.' };
      }
      if (f.substantive === 0) {
        const pieces = join(plainPieces(`Language editing of ${f.grammarOnly} ${sent(f.grammarOnly)} was assisted by ${f.tool}, which calls ${f.models}.`), recordSentence(recordPath));
        return { ...both(pieces), placement: 'Optional (Springer Nature / JHEP): AI-assisted copy editing alone needs no declaration. If you include it, put it in the Methods section.' };
      }
      return { ...both(body(f, recordPath, opening)), placement: 'Methods section, or a suitable alternative section if the paper has no Methods section (Springer Nature / JHEP policy on large language models).' };
    }
    case 'arxiv': {
      const names = [...new Set(stats.models.map(modelDisplayName))];
      const llm = names.length > 0 ? listJoin(names) : 'a large language model';
      if (f.substantive === 0) {
        const plain = stats.everAi === 0 ? 'No significant AI use to report: the record shows no AI-generated or AI-edited text.' : `No significant AI use to report: AI was used for grammar and language corrections only (${f.grammarOnly} ${sent(f.grammarOnly)}).`;
        return { latex: `% ${texEscapeDisclosure(plain)}`, plain, placement: 'Nothing to add: arXiv asks authors to report significant use of generative AI; copy editing is not significant use.' };
      }
      const counts: string[] = [];
      if (stats.aiDrafted + stats.aiEdited > 0) counts.push(`${stats.aiDrafted + stats.aiEdited} drafted with AI`);
      if ((stats.aiRewrittenOnRequest ?? 0) > 0) counts.push(`${stats.aiRewrittenOnRequest} rewritten with AI on the authors' instructions`);
      if (stats.aiFromIntent > 0) counts.push(`${stats.aiFromIntent} rendered from the authors' notes`);
      if (f.rewritten > 0) counts.push(`${f.rewritten} drafted with AI and rewritten by the authors`);
      if (f.changedExt > 0) counts.push(`${f.changedExt} drafted with AI and revised by co-authors`);
      if (f.aiPlaceholders > 0) counts.push(`${f.aiPlaceholders} rejected and left as placeholders`);
      if (f.pending > 0) counts.push(`${f.pending} awaiting review`);
      if (f.grammarOnly > 0) counts.push(`${f.grammarOnly} language-polished only`);
      const review = f.pending === 0 && stats.aiPendingReview !== undefined ? ', each reviewed by the authors' : '';
      const plain = `Text written with AI assistance (${f.tool}, ${llm}): of ${stats.totalSentences} sentences, ${counts.join(', ')}${review}.`;
      return { latex: texEscapeDisclosure(plain), plain, placement: "arXiv submission metadata, Comments field (one line); arXiv asks authors to report significant use of generative AI." };
    }
  }
}
