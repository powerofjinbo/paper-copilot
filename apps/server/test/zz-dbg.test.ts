import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { gateSentence, extractNumeralDetails, resolveLinks } from '@paper-copilot/core';
import { createCtx } from '../src/ctx';
import { initProject } from '../src/project/init';
import { derivedOf } from '../src/routes/reports';
import { REPO_ROOT, SKILL_DIR } from './helpers/ctx';
it('f', async () => {
  const root = mkdtempSync(join(tmpdir(), 'paper-zz-'));
  cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'repo'), join(root, 'repo'), { recursive: true });
  cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'tex'), join(root, 'tex'), { recursive: true });
  await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
  const ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false });
  await ctx.start(); await ctx.facts.rescan();
  const facts = ctx.facts.all().filter((f) => !f.excluded);
  const derived = derivedOf(ctx, facts);
  for (const t of (process.env.T ?? '').split('|')) {
    for (const mode of ['draft', 'rewrite'] as const) {
    const r = gateSentence(t, { mode, facts, allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [], derived });
    process.stderr.write(`### ${mode} ${t}\n` + JSON.stringify({ ok: r.ok, f: r.factIds, iss: r.issues.map((i) => i.code + ':' + i.severity + ':' + i.message.slice(0, 200)) }) + '\n');
    }
    for (const l of resolveLinks(extractNumeralDetails(t), facts, [])) process.stderr.write(`  ${l.tok.raw} st=${l.status} linked=${l.linked} cand=${l.candidates.slice(0,4).join(',')}\n`);
  }
  await ctx.close(); rmSync(root, { recursive: true, force: true });
}, 60000);
