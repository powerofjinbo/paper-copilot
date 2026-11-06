/**
 * Agreement between the platform's sentence units and the sentences the skill's style_check.py reads
 * (`python3 style_check.py FILE --dump`). Pure string processing: the caller runs the script.
 *
 * Both sides are reduced to a comparison key (lower-case letters and digits of the running text, with
 * math, citations, references, labels and footnotes removed), then matched as multisets: first by equal
 * keys, then by near-equal keys on nearby lines (text conversion differs slightly between the two
 * readers, e.g. macro expansion). Unmatched sentences that are a concatenation of consecutive
 * sentences on the other side are reported as split/merge differences.
 */
import type { Segmentation, SegSentence } from '../segment';
import { CITE_CMDS, MULTICITE_CMDS, REF_CMDS, REF_RANGE_CMDS, envCategory, ENV_MATH_DISPLAY, ENV_MATH_INLINE } from './tables';
import { controlEnd, matchBrace, readArg, skipOpts, stripComments } from './lex';
import { plainText } from '../../text/normalize';

export interface DumpSentence {
  line: number;
  /** style_check part label, truncated to 9 characters (abstract, introduct, body, conclusio, appendix, caption, footnote). */
  part: string;
  kind: string;
  words: number;
  /** The 'show' rendering style_check prints (math as $..$, citations as [cite], displays as [equation]). */
  text: string;
  /** Position in the dump (style_check lists prose blocks, then captions, then footnotes). */
  index: number;
}

const DUMP_LINE = /^L(\d+)\s+(\S+)\s+(\S+)\s+(\d+)w {2}(.*)$/;

export function parseStyleCheckDump(dump: string): DumpSentence[] {
  const out: DumpSentence[] = [];
  for (const raw of dump.split('\n')) {
    const m = DUMP_LINE.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    out.push({ line: Number(m[1]), part: m[2]!, kind: m[3]!, words: Number(m[4]), text: m[5]!, index: out.length });
  }
  return out;
}

/** Comparison key of a style_check 'show' sentence. */
export function dumpKey(show: string): string {
  // style_check prints math as $content$ with the content trimmed, so a `$` pair whose content starts or
  // ends with a space is a pair of literal dollars (\$5 ... \$0), not math
  const t = show
    .replace(/\$(?!\s)[^$]*?(?<!\s)\$/g, ' ')
    .replace(/\[(?:equation|cite|ref)\]/g, ' ')
    .replace(/\\[A-Za-z]+\{[^{}]*\}/g, ' ');
  return keyOf(t);
}

function keyOf(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** User macros without arguments (\newcommand{\x}{body}, \def\x{body}) for textual expansion. */
export function simpleMacros(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\\(?:re)?newcommand\*?\s*\{?\s*\\([A-Za-z]+)\s*\}?\s*(?=\{)|\\def\s*\\([A-Za-z]+)\s*(?=\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1] ?? m[2]!;
    const open = m.index + m[0].length;
    const e = matchBrace(source, open, source.length);
    if (e < 0) continue;
    out.set(name, source.slice(open + 1, e - 1));
  }
  return out;
}

/** Remove a command and its arguments ([..] and {..}) everywhere in `t` when `pred(name)` holds. */
function dropCommands(t: string, pred: (name: string) => boolean, nArgs: (name: string) => number): string {
  let out = '';
  let i = 0;
  while (i < t.length) {
    const b = t.indexOf('\\', i);
    if (b < 0) break;
    const e = controlEnd(t, b, t.length);
    const name = t.slice(b + 1, e);
    if (e - b > 2 && pred(name)) {
      let h = e;
      if (t.charCodeAt(h) === 42) h++;
      for (let q = 0; q < nArgs(name); q++) {
        h = skipOpts(t, h, t.length, 2);
        const a = readArg(t, h, t.length);
        if (!a) break;
        h = a.end;
      }
      out += t.slice(i, b) + ' ';
      i = h;
      continue;
    }
    out += t.slice(i, e);
    i = e;
  }
  return out + t.slice(i);
}

function dropMath(t: string): string {
  // math environments first (their content may hold $), each up to its own \end
  let s = '';
  let pos = 0;
  const head = /\\begin\s*\{([A-Za-z]+\*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(t)) !== null) {
    const cat = envCategory(m[1]!);
    if (cat !== ENV_MATH_DISPLAY && cat !== ENV_MATH_INLINE) continue;
    const close = new RegExp('\\\\end\\s*\\{' + m[1]!.replace('*', '\\*') + '\\}', 'g');
    close.lastIndex = head.lastIndex;
    const c = close.exec(t);
    if (!c) continue;
    s += t.slice(pos, m.index) + ' ';
    pos = c.index + c[0].length;
    head.lastIndex = pos;
  }
  s += t.slice(pos);
  s = s.replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\\\[[\s\S]*?\\\]/g, ' ').replace(/\\\([\s\S]*?\\\)/g, ' ');
  return s.replace(/(?<!\\)\$(?:\\.|[^$\\])*\$/g, ' ');
}

/** Comparison key of one of our sentences (LaTeX source slice). */
export function unitKey(latex: string, macros: ReadonlyMap<string, string> = new Map()): string {
  let t = stripComments(latex);
  for (let pass = 0; pass < 3 && macros.size > 0; pass++) {
    const before = t;
    t = t.replace(/\\([A-Za-z]+)(?![A-Za-z])(\{\})?/g, (m0, name: string) => {
      const body = macros.get(name);
      return body === undefined ? m0 : body;
    });
    if (t === before) break;
  }
  t = dropMath(t);
  t = dropCommands(
    t,
    (n) => CITE_CMDS.has(n) || MULTICITE_CMDS.has(n) || REF_CMDS.has(n) || REF_RANGE_CMDS.has(n) || n === 'label' || n === 'footnote' || n === 'ensuremath',
    (n) => (REF_RANGE_CMDS.has(n) ? 2 : 1),
  );
  // style_check prints an unknown lower-case macro without arguments as nothing, an upper-case one as its name
  t = t.replace(/\\([a-z][A-Za-z]*)(?![A-Za-z])(\{\})?(?!\s*\{)/g, (m0, name: string) => (plainText(m0) === name ? ' ' : m0));
  return keyOf(plainText(t));
}

export interface CompareItem {
  ours: SegSentence | null;
  theirs: DumpSentence | null;
  how: 'exact' | 'near' | 'split' | 'merge' | 'ours-only' | 'theirs-only';
  /** For split/merge: the sentences on the other side that make up this one. */
  parts?: string[];
}

export interface CompareReport {
  ours: number;
  theirs: number;
  exact: number;
  near: number;
  /** (exact + near) / max(ours, theirs) */
  agreement: number;
  /** Differences that are documented, intentional design choices (see classifyDifference). */
  intentional: number;
  /** (exact + near + intentional) / max(ours, theirs): agreement on everything not explained. */
  agreementExplained: number;
  items: CompareItem[];
  /** Every difference, with `reason`. */
  differences: Array<CompareItem & { intentional: boolean; reason: string }>;
}

/** Why a difference is expected, when it is one of the documented, intentional ones. */
export function classifyDifference(d: CompareItem, seg: Segmentation): { intentional: boolean; reason: string } {
  const sec = seg.sections.find((x) => x.id === d.ours?.sectionId);
  if (d.how === 'split' && d.parts) {
    if (d.parts.some((p) => /[.?!]['"”’)\]]*~?\\(?:cite[a-zA-Z]*|footnote)\b/.test(p)))
      return {
        intentional: true,
        reason: 'a \\cite/\\footnote right after the terminal punctuation closes that sentence (contract rule); style_check joins it to the next sentence',
      };
    if (d.parts.some((p) => /(?:\\end\s*\{[A-Za-z*]+\}|\\\]|\$\$)\s*$/.test(p)))
      return { intentional: true, reason: 'display math whose content ends with "." inside a nested environment ends the sentence' };
    return { intentional: false, reason: 'we end a sentence where style_check does not' };
  }
  if (d.how === 'merge') {
    if (d.ours && /\\begin\s*\{(?:widetext|otherlanguage\*?|linenomath\*?|samepage)\}/.test(d.ours.text))
      return {
        intentional: true,
        reason: 'a display wrapped in revtex widetext is part of the running sentence; style_check reads the environment line as a paragraph break',
      };
    return { intentional: false, reason: 'style_check ends a sentence where we do not' };
  }
  if (d.how === 'ours-only' && d.ours) {
    const title = sec?.title ?? '';
    if (d.ours.sectionId.startsWith('acknowledgments') || /acknowledg|funding|data availability|author contribution/i.test(title))
      return { intentional: true, reason: 'style_check drops acknowledgments; the platform keeps them as units (provenance and disclosure)' };
    return { intentional: false, reason: 'only in segment()' };
  }
  return { intentional: false, reason: 'only in style_check' };
}

function charSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  if (Math.abs(n - m) / Math.max(n, m) > 0.3) return 0;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let k = 0; k <= m; k++) prev[k] = k;
  for (let x = 1; x <= n; x++) {
    cur[0] = x;
    for (let y = 1; y <= m; y++) {
      const cost = a.charCodeAt(x - 1) === b.charCodeAt(y - 1) ? 0 : 1;
      cur[y] = Math.min(prev[y]! + 1, cur[y - 1]! + 1, prev[y - 1]! + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return 1 - prev[m]! / Math.max(n, m);
}

/** One key is the other with a few words removed (>= 70% of its length kept, in order). */
function subsequenceMatch(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 12 || short.length < 0.7 * long.length) return false;
  let k = 0;
  for (let q = 0; q < long.length && k < short.length; q++) if (long.charCodeAt(q) === short.charCodeAt(k)) k++;
  return k === short.length;
}

/** Match our units with style_check's sentences. `source` is used for user-macro expansion. */
export function compareWithStyleCheck(seg: Segmentation, dump: DumpSentence[], source = ''): CompareReport {
  const macros = simpleMacros(source);
  const ours = seg.sentences.map((s) => ({ s, key: unitKey(s.text, macros) })).filter((o) => o.key.length > 0);
  const theirs = dump.map((d) => ({ d, key: dumpKey(d.text) })).filter((t) => t.key.length > 0);
  const usedO = new Array<boolean>(ours.length).fill(false);
  const usedT = new Array<boolean>(theirs.length).fill(false);
  const items: CompareItem[] = [];
  const byKey = new Map<string, number[]>();
  theirs.forEach((t, k) => {
    const list = byKey.get(t.key);
    if (list) list.push(k);
    else byKey.set(t.key, [k]);
  });
  let exact = 0;
  let near = 0;
  ours.forEach((o, k) => {
    const list = byKey.get(o.key);
    if (!list) return;
    // prefer the nearest line among equal keys
    let best = -1;
    for (const q of list) if (!usedT[q] && (best < 0 || Math.abs(theirs[q]!.d.line - o.s.line) < Math.abs(theirs[best]!.d.line - o.s.line))) best = q;
    if (best < 0) return;
    usedO[k] = true;
    usedT[best] = true;
    exact++;
    items.push({ ours: o.s, theirs: theirs[best]!.d, how: 'exact' });
  });
  const differences: CompareItem[] = [];
  const finish = (): CompareReport => {
    const denom = Math.max(ours.length, theirs.length);
    const classified = differences.map((d) => ({ ...d, ...classifyDifference(d, seg) }));
    // an intentional split (merge) explains every unit (style_check sentence) it consists of
    let intentional = 0;
    for (const d of classified) if (d.intentional) intentional += d.how === 'split' || d.how === 'merge' ? (d.parts?.length ?? 1) : 1;
    return {
      ours: ours.length,
      theirs: theirs.length,
      exact,
      near,
      agreement: denom === 0 ? 1 : (exact + near) / denom,
      intentional,
      agreementExplained: denom === 0 ? 1 : Math.min(1, (exact + near + intentional) / denom),
      items,
      differences: classified,
    };
  };
  // one style_check sentence = several consecutive units of ours (we split where it does not)
  theirs.forEach((t, q) => {
    if (usedT[q]) return;
    for (let k = 0; k < ours.length; k++) {
      if (usedO[k]) continue;
      let acc = '';
      const parts: number[] = [];
      for (let r = k; r < ours.length && r < k + 4 && !usedO[r] && acc.length < t.key.length; r++) {
        acc += ours[r]!.key;
        parts.push(r);
        if (acc === t.key && parts.length > 1) {
          for (const p of parts) usedO[p] = true;
          usedT[q] = true;
          differences.push({ ours: null, theirs: t.d, how: 'split', parts: parts.map((p) => ours[p]!.s.text) });
          return;
        }
      }
    }
  });
  // one unit of ours = several consecutive style_check sentences (we merge where it splits)
  ours.forEach((o, k) => {
    if (usedO[k]) return;
    for (let q = 0; q < theirs.length; q++) {
      if (usedT[q]) continue;
      let acc = '';
      const parts: number[] = [];
      for (let r = q; r < theirs.length && r < q + 4 && !usedT[r] && acc.length < o.key.length; r++) {
        acc += theirs[r]!.key;
        parts.push(r);
        if (acc === o.key && parts.length > 1) {
          for (const p of parts) usedT[p] = true;
          usedO[k] = true;
          differences.push({ ours: o.s, theirs: null, how: 'merge', parts: parts.map((p) => theirs[p]!.d.text) });
          return;
        }
      }
    }
  });
  ours.forEach((o, k) => {
    if (usedO[k]) return;
    let best = -1;
    let bestSim = 0.85;
    theirs.forEach((t, q) => {
      if (usedT[q] || Math.abs(t.d.line - o.s.line) > 3) return;
      let sim = charSimilarity(o.key, t.key);
      // style_check keeps an \item[label] in the sentence text; the unit starts after it
      if (
        sim < bestSim && o.s.indexInParagraph === 0 && t.d.line === o.s.line && o.key.length >= 12 &&
        t.key.endsWith(o.key) && t.key.length - o.key.length <= 40
      )
        sim = 0.86;
      // the same sentence with a macro rendered differently (expanded by style_check, kept by name here)
      if (sim < bestSim && t.d.line === o.s.line && subsequenceMatch(o.key, t.key)) sim = 0.855;
      if (sim >= bestSim) {
        bestSim = sim;
        best = q;
      }
    });
    if (best < 0) return;
    usedO[k] = true;
    usedT[best] = true;
    near++;
    items.push({ ours: o.s, theirs: theirs[best]!.d, how: 'near' });
  });
  ours.forEach((o, k) => {
    if (!usedO[k]) differences.push({ ours: o.s, theirs: null, how: 'ours-only' });
  });
  theirs.forEach((t, q) => {
    if (!usedT[q]) differences.push({ ours: null, theirs: t.d, how: 'theirs-only' });
  });
  return finish();
}
