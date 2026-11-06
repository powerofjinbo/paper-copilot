/**
 * Terminology report (Terminology panel): acronym first use versus definition, and spelling variants
 * of one term (hyphen / space / closed, capitalization, US versus UK spelling).
 *
 * OWNER: core-features agent.
 *
 * Rules follow the skill's style_check.py checks 7 (acronyms) and 8 (terminology variants), run over
 * the whole project in document order, so the panel agrees with the linter and adds sentence ids:
 * - an acronym is a token with at least two capitals ("GNN", "HL-LHC", "LLPs" -> "LLP"); a definition is
 *   "Long Form (ACR)" whose last words start with the acronym's first letter, "ACR (long form)", or
 *   "called / referred to as / hereafter ACR", "ACR stands for"; standard acronyms (style_check's
 *   KNOWN_ACR plus `opts.known` and the terminology list's acronyms marked known) need no definition.
 * - status per acronym: used_before_definition (a main-text use before the first main-text definition;
 *   captions do not count as first use), undefined, defined_only_in_abstract, abstract_undefined (used
 *   in the abstract without a definition there: the abstract is read alone), redefined (two or more
 *   main-text definitions), defined_unused (defined once and never used again).
 * - variants: every term of the terminology list (and every discovered hyphenated compound) written as
 *   hyphenated, open and closed forms ("pile-up", "pile up", "pileup") and with different capitalization
 *   mid-sentence; US/UK spelling families (-ize/-ise, -or/-our, -yze/-yse, -l/-ll, -er/-re and single
 *   words) counted over the whole text, the minority convention flagged.
 */
import type { AcronymRow, ConsistencyFlag, SentenceRef, TermForm, TermVariantRow, TerminologyReport } from '../api';
import type { TermEntry } from '../schemas';
import { plainText } from '../text/normalize';
import { makeFlag, sentenceRef, type ConsistencyUnit } from './common';

/** style_check.py KNOWN_ACR (standard acronyms that need no definition), upper-cased. */
export const KNOWN_ACRONYMS: ReadonlySet<string> = new Set(
  `LHC HL-LHC LEP LEP2 ILC CLIC FCC FCC-ee FCC-hh FCC-eh CEPC SPPC ATLAS CMS LHCB ALICE FASER
FASER2 FPF SND SND@LHC MATHUSLA CODEX ANUBIS MOEDAL TOTEM SHIP NA62 NA64 KOTO KEK BES BESIII CERN SLAC FNAL
BNL DESY PSI TRIUMF RHIC EIC HERA SPS DUNE NOVA T2K KATRIN LZ XENON XENONNT PANDAX CDMS CRESST DAMA ADMX CAST
IAXO AMS LIGO CMB BBN WMAP SM BSM QCD QED EW CP CPT CKM PMNS NLO NNLO N3LO LO LL NLL NNLL N3LL PDF MC ML NN
CL CLS GEV TEV MEV KEV EV PEV 1D 2D 3D 4D 5D GPU CPU TPU RAM UV IR RMS US USA UK EU DOE NSF ERC NASA STFC DFG
PYTHIA PYTHIA8 HERWIG SHERPA POWHEG GEANT GEANT4 DELPHES MADGRAPH MG5 ROOT HEPDATA RIVET FASTJET MCFM NNPDF
CTEQ MSTW LHAPDF TMVA CUDA API JSON CSV URL HTML PHD ID OK FAQ AI LLM CPU GPUS IEEE APS JHEP PRD PRL EPJC
ARXIV MB GB TB PB HZ MHZ GHZ KHZ PDFS NNS`
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean),
);

const ACR_TOKEN_RE = /(?<![A-Za-z0-9Ͱ-Ͽ\\])([A-Z][A-Za-z0-9@&]*(?:-[A-Z0-9][A-Za-z0-9@&]*)*)(?![A-Za-z0-9Ͱ-Ͽ])/g;
const DEF_PAREN_RE = /((?:[A-Za-z][\w'’-]*\s+){0,8}[A-Za-z][\w'’-]*)\s*\(\s*([A-Z][A-Za-z0-9@&-]*[A-Z0-9][a-z0-9]?s?)\s*-?\s*(?:[;,][^)]*)?\)/g;
const DEF_REV_RE = /\b([A-Z][A-Za-z0-9@&-]*[A-Z0-9])s?\s*\(\s*([A-Za-z][^()]{4,80})\)/g;
const DEF_PHRASE_RE = /(?:[Rr]eferred to as|[Hh]ereafter|[Hh]enceforth|called|denoted(?: as| by)?|abbreviated(?: as)?|or simply)\s+(?:the\s+)?[“"]?([A-Z][A-Za-z0-9-]*[A-Z0-9])|\b([A-Z][A-Za-z0-9-]*[A-Z0-9])s?\s+(?:stands for|is short for)\b/g;

function acrNorm(t: string): string {
  return t.length >= 3 && t.endsWith('s') && t.slice(0, -1).toUpperCase() === t.slice(0, -1) ? t.slice(0, -1) : t;
}

export function isAcronym(t: string): boolean {
  if (t.length < 2 || [...t].filter((c) => c >= 'A' && c <= 'Z').length < 2) return false;
  if (/[a-z]/.test(t) && !/^[A-Z0-9@&-]*[0-9][a-z]$/.test(t)) return false;
  if (/^[IVX]+$/.test(t) || /^[WZH]{2,4}$/.test(t) || /^[XYZ]{2,3}$/.test(t)) return false;
  if (/\d[A-Z]/.test(t) || /^[A-Z]{2}\d+$/.test(t)) return false;
  if (/^[A-Z]{7,}$/.test(t)) return false;
  return true;
}

function initialsOk(acr: string, words: string[]): boolean {
  const letters = [...acr].filter((c) => /[A-Za-z]/.test(c));
  if (!letters.length) return false;
  const first = letters[0]!.toLowerCase();
  return words.slice(-(letters.length + 3)).some((w) => w.split(/[-/]/).some((p) => p.slice(0, 1).toLowerCase() === first));
}

/** Long form in front of "(ACR)": the last words whose hyphen-split parts number the acronym's letters. */
function longFormBefore(acr: string, words: string[]): string {
  const n = [...acr].filter((c) => /[A-Za-z]/.test(c)).length;
  const first = acr[0]!.toLowerCase();
  let parts = 0;
  let k = words.length;
  while (k > 0 && parts < n) {
    k--;
    parts += words[k]!.split(/[-/]/).length;
  }
  // start at the first word with the acronym's initial
  while (k < words.length - 1 && words[k]!.slice(0, 1).toLowerCase() !== first) k++;
  return words.slice(k).join(' ');
}

/** Acronyms defined in a plain sentence, with their long forms. */
export function findAcronymDefinitions(plain: string): Array<{ acronym: string; longForm: string | null }> {
  const out: Array<{ acronym: string; longForm: string | null }> = [];
  for (const m of plain.matchAll(DEF_PAREN_RE)) {
    const acr = acrNorm(m[2]!.replace(/-+$/, ''));
    const words = m[1]!.split(/\s+/).filter(Boolean);
    if (isAcronym(acr) && words.length && initialsOk(acr, words) && words[words.length - 1] !== acr) out.push({ acronym: acr, longForm: longFormBefore(acr, words) });
  }
  for (const m of plain.matchAll(DEF_REV_RE)) {
    const acr = acrNorm(m[1]!);
    const inner = m[2]!.split(/\s+/).filter(Boolean);
    if (isAcronym(acr) && inner.length >= 2 && inner.slice(0, 3).some((w) => w.slice(0, 1).toLowerCase() === acr[0]!.toLowerCase())) out.push({ acronym: acr, longForm: m[2]!.trim() });
  }
  for (const m of plain.matchAll(DEF_PHRASE_RE)) {
    const acr = acrNorm(m[1] ?? m[2] ?? '');
    if (isAcronym(acr)) out.push({ acronym: acr, longForm: null });
  }
  return out;
}

/** Acronyms used in a plain sentence (with repeats), as style_check find_acronyms. */
export function findAcronymUses(plain: string, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of plain.matchAll(ACR_TOKEN_RE)) {
    const tok = m[1]!;
    const end = (m.index ?? 0) + m[0].length;
    if (/^\s*\(\s*\d/.test(plain.slice(end, end + 4))) continue; // SU(3), U(1)
    const whole = acrNorm(tok);
    if (known.has(whole.toUpperCase())) {
      out.push(whole);
      continue;
    }
    for (const p0 of tok.includes('-') ? tok.split('-') : [tok]) {
      const p = acrNorm(p0);
      if (isAcronym(p)) out.push(p);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Spelling families (style_check SPELL_FAMILIES)                                        */
/* ------------------------------------------------------------------------------------ */

type Conv = 'US' | 'UK';
const SPELL_FAMILIES: Array<{ name: string; re: RegExp; conv: (m: RegExpMatchArray) => Conv; base: (m: RegExpMatchArray) => string }> = [
  {
    name: '-or/-our',
    re: /\b(flavo|colo|behavio|favo|hono|labo|neighbo|humo|vapo|rigo|vigo|odo|tumo|armo|endeavo|harbo|rumo|savio|valo|splendo|parlo)(u?)r(s|ed|ing|ful|less|al|ally|ite|ites|able|ably|ings)?\b/gi,
    conv: (m) => (m[2] ? 'UK' : 'US'),
    base: (m) => `${m[1]}r${m[3] ?? ''}`.toLowerCase(),
  },
  {
    name: '-ize/-ise',
    re: /\b(real|normal|renormal|optim|minim|maxim|character|util|organ|recogn|emphas|summar|general|local|regular|parametr|parameter|standard|visual|final|initial|special|categor|author|central|neutral|polar|random|symmetr|quant|linear|discret|digit|synchron|stabil|ideal|hypothes|memor|critic|theor|trivial|vector|token|mobil|homogen|harmon|magnet|crystall|marginal|factor|diagonal|orthogonal|unitar|legal|item|priorit|capital|conceptual|formal|individual|modular|sanit|apolog|familiar|immun|material|modern|natural|minimal|maximal|optimal|global|personal|tensor|matrix)i([sz])(e|es|ed|ing|ation|ations|er|ers|able)\b/gi,
    conv: (m) => (m[2]!.toLowerCase() === 's' ? 'UK' : 'US'),
    base: (m) => `${m[1]}iz${m[3]}`.toLowerCase(),
  },
  {
    name: '-yze/-yse',
    re: /\b(?!analyses\b)(anal|paral|catal|hydrol|electrol|dial)y([sz])(e|es|ed|ing|er|ers)\b/gi,
    conv: (m) => (m[2]!.toLowerCase() === 's' ? 'UK' : 'US'),
    base: (m) => `${m[1]}yz${m[3]}`.toLowerCase(),
  },
  {
    name: '-l/-ll',
    re: /\b(model|label|travel|cancel|signal|tunnel|channel|level|fuel|total|equal|dial|counsel|marshal|jewel)(l?)(ed|ing|er|ers)\b/gi,
    conv: (m) => (m[2] ? 'UK' : 'US'),
    base: (m) => `${m[1]}${m[3]}`.toLowerCase(),
  },
  {
    name: '-er/-re',
    re: /\b(cent|fib|lit|theat|calib|sab|somb|spect)(er|re|r)(s|d|ed|ing)?\b(?!-?[a-z])/gi,
    conv: (m) => (['re', 'r'].includes(m[2]!.toLowerCase()) ? 'UK' : 'US'),
    base: (m) => `${m[1]}er`.toLowerCase(),
  },
  {
    name: 'other',
    re: /\b(catalog|analog|artifact|aluminum|defense|offense|skeptic|sulfur|judgment|acknowledgment|aging|fulfill|enroll|focused|focusing|percent)(s|al|ally)?\b|\b(catalogue|analogue|artefact|aluminium|defence|offence|sceptic|sulphur|judgement|acknowledgement|ageing|fulfil|enrol|focussed|focussing|per cent)(s|al|ally)?\b/gi,
    conv: (m) => (m[1] ? 'US' : 'UK'),
    base: (m) => {
      const w = (m[1] ?? m[3] ?? '').toLowerCase();
      const map: Record<string, string> = { catalogue: 'catalog', analogue: 'analog', artefact: 'artifact', aluminium: 'aluminum', defence: 'defense', offence: 'offense', sceptic: 'skeptic', sulphur: 'sulfur', judgement: 'judgment', acknowledgement: 'acknowledgment', ageing: 'aging', fulfil: 'fulfill', enrol: 'enroll', focussed: 'focused', focussing: 'focusing', 'per cent': 'percent' };
      return map[w] ?? w;
    },
  },
];

/* ------------------------------------------------------------------------------------ */
/* Report                                                                                */
/* ------------------------------------------------------------------------------------ */

export interface TerminologyOptions {
  /** Extra standard acronyms that need no definition (style_check --known). */
  known?: readonly string[];
}

const FUNCTION_WORDS = new Set('a an the of to in on for with by from at as and or but nor not no is are was were be been this that these those it its their our we they which than then so such each every all any some only also very more most less into onto over under within without between among per via about after before while where when if can could may might must should will would do does did has have had'.split(' '));
const PARTICLES = new Set(['up', 'off', 'on', 'out', 'down', 'in', 'over', 'back', 'away', 'through', 'about']);

interface Tok {
  w: string;
  lw: string;
  unit: number;
  initial: boolean;
  next: string | null;
  punctAfter: boolean;
}

function tokensOf(plain: string, unit: number): Tok[] {
  const re = /[A-Za-z][A-Za-z'’]*(?:-[A-Za-z][A-Za-z'’]*)*/g;
  const ms = [...plain.matchAll(re)];
  return ms.map((m, k) => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const pre = plain.slice(0, start).trimEnd();
    const nextM = ms[k + 1];
    const between = nextM ? plain.slice(end, nextM.index ?? end) : '';
    return {
      w: m[0],
      lw: m[0].toLowerCase(),
      unit,
      initial: k === 0 || /[:.?!(“"]$/.test(pre),
      next: nextM && !/[.,;:()]/.test(between) ? nextM[0].toLowerCase() : null,
      punctAfter: /^\s*[.,;:)]/.test(plain.slice(end, end + 2)) || end === plain.length,
    };
  });
}

function nounish(w: string | null): boolean {
  return !!w && /^[a-z]+$/.test(w) && w.length >= 3 && !FUNCTION_WORDS.has(w) && !w.endsWith('ly');
}

/** Terminology report over the project's units in document order. Pure; never throws on odd input. */
export function terminologyReport(units: readonly ConsistencyUnit[], terms: readonly TermEntry[] = [], opts: TerminologyOptions = {}): TerminologyReport {
  const us = (Array.isArray(units) ? units : []).filter((u) => u && typeof u.text === 'string' && !u.orphaned);
  const list = (Array.isArray(terms) ? terms : []).filter((t) => t && typeof t.term === 'string' && t.term.trim());
  const plains = us.map((u) => {
    try {
      return plainText(u.text);
    } catch {
      return '';
    }
  });
  const flags: ConsistencyFlag[] = [];
  const known = new Set<string>([...KNOWN_ACRONYMS, ...(opts.known ?? []).map((k) => k.toUpperCase())]);
  const longForms = new Map<string, string>();
  for (const t of list) if (t.acronym) longForms.set(acrNorm(t.acronym), t.term);

  // ---------------------------------------------------------------- acronyms
  interface AcrState {
    uses: number[];
    defsBody: number[];
    defsAbstract: number[];
    longForm: string | null;
  }
  const acr = new Map<string, AcrState>();
  const st = (a: string): AcrState => {
    let s = acr.get(a);
    if (!s) acr.set(a, (s = { uses: [], defsBody: [], defsAbstract: [], longForm: longForms.get(a) ?? null }));
    return s;
  };
  us.forEach((u, i) => {
    const p = plains[i]!;
    const defs = findAcronymDefinitions(p);
    const seenHere = new Set<string>();
    for (const d of defs) {
      if (seenHere.has(d.acronym)) continue;
      seenHere.add(d.acronym);
      const s = st(d.acronym);
      (u.part === 'abstract' ? s.defsAbstract : s.defsBody).push(i);
      if (!s.longForm && d.longForm) s.longForm = d.longForm;
    }
    for (const a of findAcronymUses(p, known)) st(a).uses.push(i);
  });
  const ref = (i: number | undefined): SentenceRef | null => (i === undefined ? null : sentenceRef(us[i]!));
  const acronyms: AcronymRow[] = [];
  for (const [a, s] of acr) {
    if (s.uses.length === 0 && s.defsBody.length === 0 && s.defsAbstract.length === 0) continue;
    const isKnown = known.has(a.toUpperCase());
    const uses = s.uses.length;
    const bodyUses = s.uses.filter((i) => us[i]!.part !== 'abstract');
    const mainUses = bodyUses.filter((i) => us[i]!.kind !== 'caption');
    const absUses = s.uses.filter((i) => us[i]!.part === 'abstract');
    const firstDef = s.defsBody[0];
    let status: AcronymRow['status'] = isKnown ? 'known' : 'ok';
    const id = (i: number): string => us[i]!.id;
    if (isKnown && s.defsBody.length === 0 && s.defsAbstract.length === 0) {
      status = 'known';
    } else if (bodyUses.length || s.defsBody.length) {
      if (firstDef !== undefined) {
        const early = mainUses.filter((i) => i < firstDef);
        if (early.length) {
          status = 'used_before_definition';
          flags.push(makeFlag('acronym_before_definition', { term: a, sentenceIds: [id(early[0]!), id(firstDef)], message: `${a} is used before its definition (first use line ${us[early[0]!]!.line} in ${us[early[0]!]!.file}, definition line ${us[firstDef]!.line} in ${us[firstDef]!.file}); define it at first use.` }));
        } else if (s.defsBody.length > 1) {
          status = 'redefined';
          flags.push(makeFlag('acronym_redefined', { term: a, severity: 'info', sentenceIds: s.defsBody.map(id), message: `${a} is defined ${s.defsBody.length} times; once is enough.` }));
        } else if (bodyUses.filter((i) => !s.defsBody.includes(i)).length === 0 && !isKnown) {
          status = 'defined_unused';
          flags.push(makeFlag('acronym_defined_unused', { term: a, severity: 'info', sentenceIds: [id(firstDef)], message: `${a} is defined but never used again; spell it out instead.` }));
        }
      } else if (!isKnown) {
        const first = (mainUses.length ? mainUses : bodyUses)[0];
        if (first !== undefined) {
          if (s.defsAbstract.length) {
            status = 'defined_only_in_abstract';
            flags.push(makeFlag('acronym_abstract_only', { term: a, sentenceIds: [id(first), id(s.defsAbstract[0]!)], message: `${a} is defined only in the abstract; define it again at its first use in the main text.` }));
          } else {
            status = 'undefined';
            flags.push(makeFlag('acronym_undefined', { term: a, sentenceIds: [id(first)], message: `${a} is never defined (${uses} use${uses === 1 ? '' : 's'}); spell it out at first use as "Long Form (${a})", or add it to the known acronyms if it is standard.` }));
          }
        }
      }
    }
    if (absUses.length && !isKnown && s.defsAbstract.length === 0) {
      if (status === 'ok' || status === 'known' || status === 'defined_unused' || status === 'redefined') status = 'abstract_undefined';
      flags.push(makeFlag('acronym_abstract_undefined', { term: a, sentenceIds: [id(absUses[0]!)], message: `${a} is used in the abstract without a definition there; the abstract is read alone.` }));
    }
    const firstUse = s.uses.length ? Math.min(...s.uses) : undefined;
    acronyms.push({ acronym: a, longForm: s.longForm, known: isKnown, uses, firstUse: ref(firstUse), definition: ref(firstDef), definitions: s.defsBody.length, definedInAbstract: s.defsAbstract.length > 0, status });
  }
  acronyms.sort((x, y) => (x.firstUse?.line ?? 0) - (y.firstUse?.line ?? 0) || us.findIndex((u) => u.id === x.firstUse?.sentenceId) - us.findIndex((u) => u.id === y.firstUse?.sentenceId) || (x.acronym < y.acronym ? -1 : 1));

  // ---------------------------------------------------------------- variants
  const toks = plains.flatMap((p, i) => tokensOf(p, i));
  const variants: TermVariantRow[] = [];
  const byUnit = new Map<number, Tok[]>();
  for (const t of toks) {
    const l = byUnit.get(t.unit);
    if (l) l.push(t);
    else byUnit.set(t.unit, [t]);
  }
  const words = new Map<string, Tok[]>();
  for (const t of toks) {
    const l = words.get(t.lw);
    if (l) l.push(t);
    else words.set(t.lw, [t]);
  }
  /** Occurrences of a word sequence `parts` written open ("pile up"), as separate tokens in one clause. */
  const openRuns = (parts: string[]): Tok[][] => {
    const out: Tok[][] = [];
    for (const ts of byUnit.values()) {
      for (let k = 0; k + parts.length <= ts.length; k++) {
        let ok = true;
        for (let q = 0; q < parts.length && ok; q++) {
          if (ts[k + q]!.lw !== parts[q]) ok = false;
          else if (q < parts.length - 1 && ts[k + q]!.next !== parts[q + 1]) ok = false;
        }
        if (ok) out.push(ts.slice(k, k + parts.length));
      }
    }
    return out;
  };
  /**
   * How a form is written: its most common mid-sentence spelling ("pile-up"), or, when every use opens a
   * sentence ("Pile-up is ..."), the spelling with the sentence capital undone.
   */
  const surface = (runs: Tok[][]): string => {
    const counts = new Map<string, number>();
    for (const r of runs) if (r.length && !r[0]!.initial) { const f = r.map((x) => x.w).join(' '); counts.set(f, (counts.get(f) ?? 0) + 1); }
    if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    const r = runs[0] ?? [];
    return r.map((x, k) => (k === 0 && /^[A-Z][a-z]/.test(x.w) && !/[A-Z]/.test(x.w.slice(1)) ? x.lw : x.w)).join(' ');
  };
  const formRow = (form: string, occ: Tok[]): TermForm => {
    const ids = [...new Set(occ.map((t) => us[t.unit]!.id))];
    return { form, count: occ.length, sentenceIds: ids.slice(0, 50), first: occ.length ? sentenceRef(us[Math.min(...occ.map((t) => t.unit))]!) : null };
  };
  const done = new Set<string>();
  const addHyphenRow = (term: string, parts: string[], fromList: boolean): void => {
    const key = parts.join('-');
    if (done.has(key)) return;
    const hyph = words.get(key) ?? [];
    const closed = parts.join('');
    const cl = closed.length >= 5 ? (words.get(closed) ?? []) : [];
    const opens = openRuns(parts);
    const forms: Array<{ form: string; occ: Tok[] }> = [];
    if (hyph.length) forms.push({ form: surface(hyph.map((t) => [t])), occ: hyph });
    if (cl.length) forms.push({ form: surface(cl.map((t) => [t])), occ: cl });
    if (opens.length) {
      // an open form counts for a discovered compound only if the hyphenated one is used as a noun too
      // ("the pile-up is", "pile-up." vs "pile up"), not only attributively ("fake-track rate" vs "a fake track")
      const nounPos = hyph.some((t) => t.punctAfter || (t.next !== null && FUNCTION_WORDS.has(t.next) && !['and', 'or', 'nor', 'to'].includes(t.next)));
      const bothAttr = hyph.some((t) => !t.punctAfter && nounish(t.next)) && opens.some((o) => !o[o.length - 1]!.punctAfter && nounish(o[o.length - 1]!.next));
      if (fromList || nounPos || bothAttr || hyph.length === 0) forms.push({ form: surface(opens), occ: opens.map((o) => o[0]!) });
    }
    if (forms.length < 2) return;
    done.add(key);
    forms.sort((a, b) => b.occ.length - a.occ.length);
    const listForm = fromList ? forms.find((f) => f.form.toLowerCase() === term.toLowerCase()) : undefined;
    // the list's spelling wins (its case too: the case check reports capitals separately)
    if (listForm) listForm.form = term.trim();
    const preferred = listForm?.form ?? forms[0]!.form;
    const row: TermVariantRow = { term: fromList ? term : forms[0]!.form, kind: 'hyphen', family: null, forms: forms.map((f) => formRow(f.form, f.occ)), preferred, fromList };
    variants.push(row);
    const minor = forms.filter((f) => f.form !== preferred);
    flags.push(
      makeFlag('variant_hyphen', {
        term: row.term,
        sentenceIds: minor.flatMap((f) => f.occ.map((t) => us[t.unit]!.id)),
        message: `One term, ${forms.length} spellings: ${forms.map((f) => `"${f.form}" ${f.occ.length}×`).join(', ')}. Keep "${preferred}".`,
      }),
    );
  };
  // terms of the list (hyphen / open / closed)
  for (const t of list) {
    const parts = t.term.toLowerCase().split(/[\s-]+/).filter(Boolean);
    if (parts.length >= 2) addHyphenRow(t.term, parts, true);
    else {
      // a one-word list term may appear hyphenated or open ("pileup" vs "pile-up"): look for splits
      for (const [lw] of words) {
        if (lw.includes('-') && lw.replace(/-/g, '') === parts[0]) addHyphenRow(t.term, lw.split('-'), true);
      }
    }
  }
  // discovered hyphenated compounds
  for (const lw of words.keys()) {
    if (!/^[a-z]+(?:-[a-z]+)+$/.test(lw) || lw.length < 5) continue;
    const parts = lw.split('-');
    if (parts.slice(1).some((p) => p.length < 2) || (parts[0]!.length < 2 && !['b', 'c', 't', 'x', 'e'].includes(parts[0]!))) continue;
    if (PARTICLES.has(parts[parts.length - 1]!) && !(words.get(parts.join('')) ?? []).length) continue;
    if (FUNCTION_WORDS.has(parts[0]!)) continue;
    addHyphenRow(lw, parts, false);
  }

  // capitalization of list terms (mid-sentence only)
  for (const t of list) {
    const parts = t.term.toLowerCase().split(/\s+/).filter(Boolean);
    const runs = parts.length === 1 ? (words.get(parts[0]!) ?? []).map((x) => [x]) : openRuns(parts);
    const mid = runs.filter((r) => !r[0]!.initial);
    const shapes = new Map<string, Tok[]>();
    for (const r of mid) {
      const form = r.map((x) => x.w).join(' ');
      const l = shapes.get(form);
      if (l) l.push(r[0]!);
      else shapes.set(form, [r[0]!]);
    }
    if (shapes.size < 2) continue;
    const forms = [...shapes.entries()].sort((a, b) => b[1].length - a[1].length);
    const listForm = forms.find(([f]) => f === t.term.trim());
    const preferred = listForm?.[0] ?? forms[0]![0];
    variants.push({ term: t.term, kind: 'case', family: null, forms: forms.map(([f, o]) => formRow(f, o)), preferred, fromList: true });
    flags.push(makeFlag('variant_case', { term: t.term, sentenceIds: forms.filter(([f]) => f !== preferred).flatMap(([, o]) => o.map((x) => us[x.unit]!.id)), message: `"${t.term}" is capitalized in ${forms.length} ways mid-sentence: ${forms.map(([f, o]) => `"${f}" ${o.length}×`).join(', ')}. Keep "${preferred}".` }));
  }
  // capitalization of discovered hyphenated compounds ("Pile-up" mid-sentence vs "pile-up")
  {
    const caps = new Map<string, Map<string, Tok[]>>();
    for (const t of toks) {
      if (t.initial || !t.w.includes('-') || t.w.length < 5) continue;
      const shape = t.w === t.lw ? 'lower' : /^[A-Z][a-z]+(?:-[a-z]+)+$/.test(t.w) ? 'title' : null;
      if (!shape) continue;
      let m = caps.get(t.lw);
      if (!m) caps.set(t.lw, (m = new Map()));
      const l = m.get(t.w);
      if (l) l.push(t);
      else m.set(t.w, [t]);
    }
    for (const [lw, m] of caps) {
      if (m.size < 2 || list.some((t) => t.term.toLowerCase() === lw)) continue;
      const forms = [...m.entries()].sort((a, b) => b[1].length - a[1].length);
      const preferred = forms.find(([f]) => f === lw)?.[0] ?? forms[0]![0];
      variants.push({ term: lw, kind: 'case', family: null, forms: forms.map(([f, o]) => formRow(f, o)), preferred, fromList: false });
      flags.push(makeFlag('variant_case', { term: lw, severity: 'info', sentenceIds: forms.filter(([f]) => f !== preferred).flatMap(([, o]) => o.map((x) => us[x.unit]!.id)), message: `"${lw}" is capitalized mid-sentence: ${forms.map(([f, o]) => `"${f}" ${o.length}×`).join(', ')}.` }));
    }
  }

  // ---------------------------------------------------------------- US / UK spelling
  const conv = { US: 0, UK: 0 };
  const hits: Array<{ family: string; base: string; word: string; conv: Conv; unit: number }> = [];
  plains.forEach((p, i) => {
    for (const fam of SPELL_FAMILIES) {
      for (const m of p.matchAll(fam.re)) {
        const c = fam.conv(m);
        conv[c]++;
        hits.push({ family: fam.name, base: fam.base(m), word: m[0], conv: c, unit: i });
      }
    }
  });
  const majority: Conv | null = conv.US === 0 && conv.UK === 0 ? null : conv.US >= conv.UK ? 'US' : 'UK';
  if (majority && conv.US > 0 && conv.UK > 0) {
    const minorConv: Conv = majority === 'US' ? 'UK' : 'US';
    const byFamily = new Map<string, typeof hits>();
    for (const h of hits) {
      const l = byFamily.get(h.family);
      if (l) l.push(h);
      else byFamily.set(h.family, [h]);
    }
    for (const [family, hs] of byFamily) {
      const minor = hs.filter((h) => h.conv === minorConv);
      if (!minor.length) continue;
      const forms = new Map<string, Array<{ unit: number }>>();
      for (const h of hs) {
        const k = h.word.toLowerCase();
        const l = forms.get(k);
        if (l) l.push(h);
        else forms.set(k, [h]);
      }
      const rows: TermForm[] = [...forms.entries()].map(([f, o]) => ({ form: f, count: o.length, sentenceIds: [...new Set(o.map((x) => us[x.unit]!.id))].slice(0, 50), first: sentenceRef(us[Math.min(...o.map((x) => x.unit))]!) }));
      rows.sort((a, b) => b.count - a.count);
      const majorWord = hs.find((h) => h.conv === majority)?.word.toLowerCase() ?? rows[0]!.form;
      variants.push({ term: family, kind: 'spelling', family, forms: rows, preferred: majorWord, fromList: false });
      flags.push(
        makeFlag('variant_spelling', {
          term: family,
          severity: 'info',
          sentenceIds: [...new Set(minor.map((h) => us[h.unit]!.id))],
          message: `Mixed ${family} spelling: the text is mostly ${majority} (${conv[majority]} words) but writes ${[...new Set(minor.map((h) => `"${h.word}"`))].slice(0, 5).join(', ')} (${minorConv}).`,
        }),
      );
    }
  }
  return { acronyms, variants, spelling: { us: conv.US, uk: conv.UK, majority }, flags };
}
