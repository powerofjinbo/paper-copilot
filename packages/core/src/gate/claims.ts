/**
 * Claim-strength lexicon of the faithfulness gate (skill: Guardrails "Keep the author's claims at their
 * original strength"; references/figures-and-evidence.md EVIDENCE-8 "Match the verb to the evidence":
 * "exclude" or "reject" for a decisive test, by convention 95% CL or more; "project", "expect", "would" for
 * simulated sensitivity; "favor" for a weak preference). Deterministic; reread hints, never errors.
 *
 * OWNER: core-gate agent.
 */
import type { Fact } from '../schemas';

export interface StrengthHit {
  start: number;
  end: number;
  raw: string;
  rule: 'exclude' | 'demonstrate' | 'result_verb';
}

/** Exclusion verbs (a decisive test). `excluded from` (a selection) is not an exclusion claim. */
const EXCLUDE_RE = /\b(?:exclud(?:e|es|ed)|rul(?:e|es|ed|ing)\s+out)\b/gi;
/** `reject` is an exclusion only for a hypothesis or model, not for background rejection. */
const REJECT_RE = /\breject(?:s|ed|ing)?\b(?=(?:\W+\w+){0,4}?\W+(?:hypothes\w*|models?|scenarios?|null)\b)/gi;
const DEMONSTRATE_RE = /\b(?:demonstrat(?:e|es|ed|ing)|establish(?:es|ed|ing)?|prov(?:e|es|ed|en|ing))\b/gi;
const RESULT_RE = /\b(?:improv(?:e|es|ed|ing|ement|ements)|outperform(?:s|ed|ing)?|better|higher|lower|gain(?:s|ed)?|boost(?:s|ed|ing)?|superior|surpass(?:es|ed|ing)?)\b/gi;

/** Phrases where a result word is not a result claim. */
const RESULT_EXEMPT = /\b(?:lower|upper)[\s-]+(?:bound|limit|edge|panel|left|right|half|part|row|end|threshold)s?\b|\bupper and lower\b|\bhigher[\s-]+order\b|\b(?:at|to) (?:higher|lower) (?:energ|mass|momen|pile|lumin|radi|values?)/i;
const NEGATION_BEFORE = /\b(?:not|cannot|can't|never|no|neither|nor|unable to|fail(?:s|ed)? to)\s+(?:\w+\s+){0,2}$/i;

function hits(re: RegExp, text: string): Array<{ start: number; end: number; raw: string }> {
  const out: Array<{ start: number; end: number; raw: string }> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** Confidence level (percent) a fact documents, from tags (`cl:95`, `cl95`), its definition or its id. */
export function confidenceLevelOf(f: Fact): number | null {
  let best: number | null = null;
  const take = (x: number): void => {
    if (Number.isFinite(x) && x > 0 && x < 100 && (best === null || x > best)) best = x;
  };
  for (const t of f.tags ?? []) {
    const m = /^(?:cl|conf(?:idence)?)[:=_-]?(\d+(?:\.\d+)?)%?$/i.exec(t);
    if (m) take(Number(m[1]));
  }
  const textual = `${f.definition ?? ''} ${f.id ?? ''} ${typeof f.value === 'string' ? f.value : ''}`;
  const re = /(\d+(?:\.\d+)?)\s*(?:\\?%|percent)?\s*(?:CL|C\.L\.|confidence(?:\s+level)?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(textual))) take(Number(m[1]));
  const idm = /(?:^|[._-])cl_?(\d{2}(?:\.\d+)?)(?:$|[._-])/i.exec(f.id ?? '');
  if (idm) take(Number(idm[1]));
  return best;
}

export function isReproduced(f: Fact): boolean {
  return f.validationState === 'reproduced' || f.validationState === 'independently_validated';
}

export interface StrengthInput {
  text: string;
  linkedFacts: Fact[];
  hasPlaceholder: boolean;
  hasCitation: boolean;
}

export interface StrengthIssue {
  start: number;
  end: number;
  raw: string;
  message: string;
}

/** Claim-strength warnings for one sentence (at most one per rule). */
export function claimStrengthIssues(inp: StrengthInput): StrengthIssue[] {
  const out: StrengthIssue[] = [];
  const t = inp.text;
  const notNegated = (h: { start: number }): boolean => !NEGATION_BEFORE.test(t.slice(Math.max(0, h.start - 40), h.start));
  // exclude / rule out / reject (a hypothesis): needs a limit fact at >= 95% CL
  const excl = [...hits(EXCLUDE_RE, t), ...hits(REJECT_RE, t)]
    .sort((a, b) => a.start - b.start)
    .filter(notNegated)
    .filter((h) => !/^excluded$/i.test(h.raw) || !/^\s+from\b/i.test(t.slice(h.end)));
  if (excl.length) {
    const cl = Math.max(-1, ...inp.linkedFacts.map((f) => confidenceLevelOf(f) ?? -1));
    if (cl < 95) {
      const h = excl[0]!;
      out.push({
        ...h,
        message:
          cl > 0
            ? `"${h.raw}" claims a decisive test, but the linked limit is at ${cl}% CL (below 95%); consider "disfavor" or "favor", or link a 95% CL limit.`
            : `"${h.raw}" claims a decisive test (95% CL or more by convention), but no linked fact is a limit with its confidence level; link the limit fact, or weaken the verb (expect, project, favor).`,
      });
    }
  }
  // demonstrate / establish / prove: needs a reproduced fact
  const demo = hits(DEMONSTRATE_RE, t)
    .filter(notNegated)
    .filter((h) => !/well[\s-]$/i.test(t.slice(Math.max(0, h.start - 5), h.start)));
  if (demo.length && !inp.linkedFacts.some(isReproduced)) {
    const h = demo[0]!;
    out.push({
      ...h,
      message: `"${h.raw}" needs evidence that was reproduced (validation state reproduced or better); the linked facts are only candidates. Consider "show" or "find", or record a reproduction.`,
    });
  }
  // result verbs without a number or placeholder
  if (!inp.linkedFacts.length && !inp.hasPlaceholder && !inp.hasCitation && !RESULT_EXEMPT.test(t)) {
    const r = hits(RESULT_RE, t).filter(notNegated);
    if (r.length) {
      const h = r[0]!;
      out.push({ ...h, message: `"${h.raw}" states a result without a number or a baseline; link the fact or add a placeholder such as [fact?: size of the gain].` });
    }
  }
  return out;
}
