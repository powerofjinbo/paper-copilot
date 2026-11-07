/**
 * Review 2 (integrity): the headline result REVERSED by swapping which method each number belongs to.
 * Facts from the REAL fact service (canto-demo): their definitions say who is who, e.g.
 *   f.g1.eff_A: "eff_A (claim=G1; A=Canto-L (ttbar); B=acorn (HNL) + LM; ...)" = 96.94%
 *   f.g1.eff_B: "eff_B (claim=G1; A=Canto-L (ttbar); B=acorn (HNL) + LM; ...)" = 94.62%
 *   f.g1.delta_points: A - B = +2.32 points
 * An AI sentence (instruct / ghost gate) that gives Canto-L the baseline's efficiency and acorn
 * Canto-L's ("Canto-L finds 94.62% ..., compared with 96.94% for acorn") states the opposite of the
 * paper's result. The gate accepts it with no issue, and so does the swapped-subject difference.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gateSentence, type DerivedRelation, type Fact } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../../src/ctx';
import { initProject } from '../../src/project/init';
import { derivedOf } from '../../src/routes/reports';
import { REPO_ROOT, SKILL_DIR } from '../helpers/ctx';

let root = '';
let ctx: AppCtx;
let facts: Fact[] = [];
let derived: DerivedRelation[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'paper-review2-attr-'));
  cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'tex'), join(root, 'tex'), { recursive: true });
  cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'repo'), join(root, 'repo'), { recursive: true });
  await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
  ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false });
  await ctx.start();
  await ctx.facts.rescan();
  facts = ctx.facts.all().filter((f) => !f.excluded);
  derived = derivedOf(ctx, facts);
}, 60_000);

afterAll(async () => {
  await ctx?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const gate = (text: string) => gateSentence(text, { mode: 'draft', facts, allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [], derived });
/** Blocked, or at least an issue that tells the author the attribution/direction is wrong. */
const flagged = (text: string): boolean => {
  const r = gate(text);
  return !r.ok || r.issues.some((i) => i.code === 'direction' || i.code === 'meaning_changed');
};

describe('the result reversed by swapping attribution (real fact definitions name A and B)', () => {
  it('control: the facts say A = Canto-L, B = acorn', () => {
    expect(facts.find((f) => f.id === 'f.g1.eff_A')!.definition).toMatch(/A=Canto-L.*B=acorn/);
    expect(gate('Canto-L finds 96.94\\% of the targets, compared with 94.62\\% for acorn.').ok).toBe(true);
  });

  it.each([
    ['efficiencies swapped', 'Canto-L finds 94.62\\% of the targets, compared with 96.94\\% for acorn.'],
    ['fake-track rates swapped', 'The fake-track rate of Canto-L is 1.38\\% against 0.55\\% for acorn.'],
    ['difference with the subjects swapped', 'Acorn finds 2.3 points more targets than Canto-L.'],
  ])('%s is flagged', (_what, text) => {
    // today: ok, no issue (the numbers are each linked to a fact; nobody checks whose fact)
    expect(flagged(text)).toBe(true);
  });
});
