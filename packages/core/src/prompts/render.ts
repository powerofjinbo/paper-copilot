/**
 * Deterministic renderings of project state for prompts: the fact table, the frozen outline,
 * terminology, allowed cite keys and the live paragraph plan. Same input -> same bytes.
 */
import { renderFact } from '../facts/numbers';
import type { Fact, Outline, ParagraphPlan, PlanStep, TermEntry } from '../schemas';
import { clean, cmp, oneLine, uniq } from './xml';

/* ------------------------------------------------------------------------------------ */
/* Fact table                                                                            */
/* ------------------------------------------------------------------------------------ */

const cell = (s: string): string => oneLine(s).replace(/\|/g, '/');

/** The value part of renderFact ("f.x = 2.32 ± 0.28 points" -> "2.32 ± 0.28 points"). */
function factRendering(f: Fact): string {
  let r = '';
  try {
    r = renderFact(f);
  } catch {
    r = '';
  }
  const id = String(f.id ?? '');
  if (r.startsWith(`${id} = `)) r = r.slice(id.length + 3);
  else if (r.startsWith(`${id}: `)) r = r.slice(id.length + 2);
  else if (r === id) r = '';
  if (!r) {
    const v = typeof f.value === 'number' ? String(f.value) : String(f.value ?? '');
    r = f.unit ? `${v} ${f.unit}` : v;
  }
  return cell(r);
}

function validationCell(f: Fact): string {
  const parts: string[] = [String(f.validationState ?? 'candidate')];
  if (f.confirmed) parts.push('confirmed by author');
  if (f.proseOnly) parts.push('prose-only (README text, not a result file)');
  if (f.stale) parts.push('STALE: the artifact changed; do not use until re-checked');
  return parts.join('; ');
}

export const FACT_TABLE_HEADER = 'id | rendering | kind | definition | validation';

/** Deterministic fact table (sorted by id; excluded facts omitted). */
export function renderFactTable(facts: Fact[]): string {
  const seen = new Set<string>();
  const rows = (Array.isArray(facts) ? facts : [])
    .filter((f): f is Fact => !!f && typeof f.id === 'string' && f.id !== '' && !f.excluded)
    .slice()
    .sort((a, b) => cmp(a.id, b.id))
    .filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)))
    .map((f) => [cell(f.id), factRendering(f), cell(String(f.kind ?? '')), cell(f.definition ?? '') || '(no definition)', cell(validationCell(f))].join(' | '));
  return [FACT_TABLE_HEADER, ...rows].join('\n');
}

/* ------------------------------------------------------------------------------------ */
/* Frozen outline                                                                        */
/* ------------------------------------------------------------------------------------ */

const PROV_NOTE: Record<string, string> = {
  'ai-proposed': ' [proposed by the AI; not yet approved by the author]',
  'ai-edited': ' [AI text edited by the author]',
};
const prov = (p: unknown): string => (typeof p === 'string' ? (PROV_NOTE[p] ?? '') : '');
const orEmpty = (s: string | null | undefined): string => oneLine(s) || '(not written yet)';

/**
 * The five Step-0 items and the section/paragraph jobs. Live state (plans' said/remaining, intent
 * notes, ghost modes, framings) is left out so the text stays stable while the author writes.
 */
export function renderFrozenOutline(outline: Outline | null | undefined): string {
  const o = outline;
  if (!o || typeof o !== 'object') return '(no outline yet)';
  const lines: string[] = [];
  lines.push(`1. One-sentence story: ${orEmpty(o.story?.text)}${prov(o.story?.provenance)}`);
  lines.push(`   Key phrase (repeat it exactly in title, abstract, contribution and conclusions): ${orEmpty(o.story?.keyPhrase)}`);
  lines.push(`2. Gap: ${orEmpty(o.gap?.text)}${prov(o.gap?.provenance)}`);
  lines.push(`   Enabler (why it can be done now): ${orEmpty(o.enabler?.text)}${prov(o.enabler?.provenance)}`);
  lines.push(`   Contrast (the one assumption of the standard approach this paper changes): ${orEmpty(o.contrast?.text)}${prov(o.contrast?.provenance)}`);
  const ladder = Array.isArray(o.ladder) ? o.ladder : [];
  lines.push(`3. Ladder of cases, easy to hard:${ladder.length ? '' : ' (not written yet)'}`);
  ladder.forEach((c, i) => {
    const facts = uniq(c?.factIds);
    lines.push(`   ${i + 1}. [${oneLine(c?.id) || '?'}] ${orEmpty(c?.text)}${facts.length ? ` (facts: ${facts.join(', ')})` : ''}${prov(c?.provenance)}`);
  });
  const cf = Array.isArray(o.claimFigures) ? o.claimFigures : [];
  lines.push(`4. Figure that carries each claim:${cf.length ? '' : ' (not written yet)'}`);
  for (const x of cf) lines.push(`   - claim ${oneLine(x?.claimId) || '?'} -> figure ${oneLine(x?.figureId) || '?'}`);
  const h = o.headline;
  lines.push(`5. Headline result: ${orEmpty(h?.text)}${prov(h?.provenance)}`);
  lines.push(`   Number: ${oneLine(h?.factId) || '[headline fact?]'}; baseline: ${oneLine(h?.baselineFactId) || '[baseline?]'}; condition: ${oneLine(h?.condition) || '[condition?]'}`);
  const sections = Array.isArray(o.sections) ? o.sections : [];
  lines.push('');
  lines.push(`Sections, in paper order:${sections.length ? '' : ' (none yet)'}`);
  for (const s of sections) {
    const tpl = oneLine(s?.template);
    lines.push(`- [${oneLine(s?.id) || '?'}] ${orEmpty(s?.title)}${tpl ? ` (template: ${tpl})` : ''}${prov(s?.provenance)}`);
    lines.push(`  Question it answers: ${orEmpty(s?.question)}`);
    for (const p of Array.isArray(s?.paragraphs) ? s.paragraphs : []) {
      const moves = uniq(p?.moves);
      const claims = uniq(p?.claimIds);
      const extra = [moves.length ? `moves: ${moves.join(', ')}` : '', claims.length ? `claims: ${claims.join(', ')}` : ''].filter(Boolean).join('; ');
      lines.push(`  - paragraph ${oneLine(p?.pid) || '?'}: ${orEmpty(p?.job)}${extra ? ` (${extra})` : ''}${prov(p?.provenance)}`);
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------------------------ */
/* Terminology and cite keys                                                             */
/* ------------------------------------------------------------------------------------ */

export function renderTerminology(terms: TermEntry[]): string {
  const rows = (Array.isArray(terms) ? terms : [])
    .filter((t): t is TermEntry => !!t && typeof t.term === 'string' && t.term.trim() !== '')
    .slice()
    .sort((a, b) => cmp(oneLine(a.term), oneLine(b.term)) || cmp(oneLine(a.definition), oneLine(b.definition)))
    .map((t) => {
      const tags = [t.acronym ? `acronym ${oneLine(t.acronym)}` : '', t.symbol ? `symbol ${oneLine(t.symbol)}` : ''].filter(Boolean).join(', ');
      const variants = uniq(t.variants).filter((v) => v !== t.term.trim());
      return `- ${oneLine(t.term)}${tags ? ` (${tags})` : ''}: ${oneLine(t.definition) || '(no definition yet)'}${variants.length ? `. Variants to replace with this name: ${variants.join('; ')}` : ''}`;
    });
  return rows.length ? rows.join('\n') : '(no terms registered yet)';
}

export function renderCiteKeys(keys: Array<{ key: string; title: string }>): string {
  const seen = new Set<string>();
  const rows = (Array.isArray(keys) ? keys : [])
    .filter((k) => !!k && typeof k.key === 'string' && k.key.trim() !== '')
    .map((k) => ({ key: k.key.trim(), title: oneLine(k.title) }))
    .sort((a, b) => cmp(a.key, b.key))
    .filter((k) => (seen.has(k.key) ? false : (seen.add(k.key), true)))
    .map((k) => `- ${k.key}: ${k.title || '(no title)'}`);
  return rows.length ? rows.join('\n') : '(no resolved keys yet: write [ref] wherever a citation is needed)';
}

/* ------------------------------------------------------------------------------------ */
/* Live plan (tails only)                                                                */
/* ------------------------------------------------------------------------------------ */

export function renderPlanStep(s: PlanStep): string {
  const facts = uniq(s?.factIds);
  const cites = uniq(s?.citeKeys);
  const extra = [s?.move ? `move: ${oneLine(s.move)}` : '', facts.length ? `facts: ${facts.join(', ')}` : '', cites.length ? `cite: ${cites.join(', ')}` : '']
    .filter(Boolean)
    .join('; ');
  return `- [${oneLine(s?.id) || '?'}] ${oneLine(s?.intent) || '(no intent)'}${extra ? ` (${extra})` : ''}`;
}

export function renderPlan(plan: ParagraphPlan | null | undefined): string {
  if (!plan) return '(no plan for this paragraph)';
  const lines: string[] = [`Job: ${oneLine(plan.job) || '(not stated)'}`];
  const claims = uniq(plan.claimIds);
  if (claims.length) lines.push(`Claims this paragraph carries: ${claims.join(', ')}`);
  const said = Object.keys(plan.said ?? {})
    .sort(cmp)
    .map((k) => `${k} (sentence ${oneLine(plan.said[k]) || '?'})`);
  lines.push(`Already said: ${said.length ? said.join(', ') : 'nothing yet'}`);
  const rem = Array.isArray(plan.remaining) ? plan.remaining : [];
  lines.push(rem.length ? 'Still to say, in order:' : 'Still to say: nothing listed');
  for (const s of rem) lines.push(renderPlanStep(s));
  return lines.join('\n');
}

/** Exemplar sentences, trimmed, empties dropped, duplicates removed, order kept. */
export function exemplarList(xs: ReadonlyArray<string> | null | undefined, max: number): string[] {
  return uniq((xs ?? []).map((x) => clean(x))).slice(0, max);
}
