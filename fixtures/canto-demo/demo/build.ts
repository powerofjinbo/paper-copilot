/**
 * Rebuild the browser demo's example PDF and its SyncTeX map from ../tex/main.tex:
 *
 *   npx tsx fixtures/canto-demo/demo/build.ts
 *
 * Writes main.pdf (latexmk -pdf -synctex=1, reproducible dates) and synctex.json: for every source line
 * that has a box, the box `synctex view` gives for it (PDF points, top-left origin, the server's own
 * boxFromRecords). The `?mock=1` demo has no LaTeX: it shows this PDF and maps forward / inverse search
 * through this table (apps/web/src/api/mockPdf.ts). Needs TeX Live (latexmk, synctex).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxFromRecords, parseSynctexView } from '../../../apps/server/src/services/build/synctex';

const here = dirname(fileURLToPath(import.meta.url));
const texDir = join(here, '..', 'tex');
const work = mkdtempSync(join(process.env.PAPER_DEMO_TMP ?? tmpdir(), 'canto-demo-pdf-'));
try {
  for (const f of ['main.tex', 'refs.bib']) copyFileSync(join(texDir, f), join(work, f));
  const env = { ...process.env, SOURCE_DATE_EPOCH: '1767225600', FORCE_SOURCE_DATE: '1' };
  execFileSync('latexmk', ['-pdf', '-synctex=1', '-interaction=nonstopmode', 'main.tex'], { cwd: work, env, stdio: 'ignore' });
  const lines = readFileSync(join(work, 'main.tex'), 'utf8').split('\n').length;
  const boxes: Record<string, { page: number; x: number; y: number; w: number; h: number }> = {};
  for (let line = 1; line <= lines; line++) {
    const out = execFileSync('synctex', ['view', '-i', `${line}:0:main.tex`, '-o', 'main.pdf'], { cwd: work, encoding: 'utf8' });
    const box = boxFromRecords(parseSynctexView(out));
    if (box) boxes[String(line)] = box;
  }
  copyFileSync(join(work, 'main.pdf'), join(here, 'main.pdf'));
  writeFileSync(join(here, 'synctex.json'), JSON.stringify({ source: 'fixtures/canto-demo/tex/main.tex', lines: boxes }) + '\n');
  console.log(`main.pdf and synctex.json written (${Object.keys(boxes).length} of ${lines} lines have a box)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
