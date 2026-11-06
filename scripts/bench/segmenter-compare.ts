/**
 * Sentence-boundary agreement between the platform's segmenter and the hep-paper-writing skill's
 * style_check.py (the linter whose flags are reconciled to sentence units).
 *
 *   npx tsx scripts/bench/segmenter-compare.ts [file.tex ...] [--skill DIR] [--min 0.98] [--json] [--all]
 *
 * For each file it runs `python3 <skill>/scripts/style_check.py - --format tex --dump` on the file's
 * compile shadow (intent lines blanked, which is what the sidecar's lint.document pass reads), segments
 * the same file with `segment()`, matches the two sentence lists by normalized text (exact, then
 * near-equal on nearby lines), and prints:
 *   - agreement: matched sentences / max(units, style_check sentences);
 *   - agreement excluding intentional differences (documented design choices, each listed with its
 *     reason: acknowledgments kept as units, a \cite right after the period closing its sentence, ...);
 *   - every difference.
 * Order is not compared: style_check lists prose, then captions, then footnotes; units are in document
 * order (a footnote follows its host sentence, a caption sits where its float is).
 * Exits with status 1 when the agreement excluding intentional differences is below --min (default 0.98).
 *
 * The skill directory defaults to $PAPER_SKILL_DIR, then ./.skill of this repository.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segment } from '../../packages/core/src/latex/segment';
import { shadowForCompile } from '../../packages/core/src/latex/lines';
import { compareWithStyleCheck, parseStyleCheckDump, type CompareReport } from '../../packages/core/src/latex/scan/compare';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

interface Args {
  files: string[];
  skill: string;
  min: number;
  json: boolean;
  all: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    files: [],
    skill: process.env.PAPER_SKILL_DIR || resolve(repoRoot, '.skill'),
    min: 0.98,
    json: false,
    all: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--skill') a.skill = resolve(argv[++i] ?? a.skill);
    else if (v === '--min') a.min = Number(argv[++i] ?? a.min);
    else if (v === '--json') a.json = true;
    else if (v === '--all') a.all = true;
    else if (v === '-h' || v === '--help') {
      console.log('usage: segmenter-compare.ts [file.tex ...] [--skill DIR] [--min 0.98] [--json] [--all]');
      process.exit(0);
    } else a.files.push(resolve(v));
  }
  if (a.files.length === 0) a.files.push(resolve(repoRoot, 'fixtures/canto-demo/tex/main.tex'));
  return a;
}

/** style_check on the compile shadow, fed on stdin so nothing is written to disk. */
function runDump(styleCheck: string, text: string): string {
  return execFileSync('python3', ['-I', styleCheck, '-', '--format', 'tex', '--dump'], {
    input: text,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function show(s: string, n = 110): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

function printReport(file: string, rep: CompareReport, ms: number, all: boolean): void {
  const rel = file.startsWith(repoRoot) ? file.slice(repoRoot.length + 1) : file;
  console.log(`\n${rel}`);
  console.log(
    `  segment(): ${rep.ours} units in ${ms.toFixed(2)} ms | style_check: ${rep.theirs} sentences | exact ${rep.exact}, near ${rep.near}`,
  );
  console.log(
    `  agreement ${pct(rep.agreement)} | excluding ${rep.intentional} intentional difference(s): ${pct(rep.agreementExplained)}`,
  );
  if (all) {
    for (const it of rep.items.filter((x) => x.how === 'near')) {
      console.log(`  ~ near   L${it.ours!.line}: ${show(it.ours!.text)}`);
      console.log(`           style_check L${it.theirs!.line}: ${show(it.theirs!.text)}`);
    }
  }
  if (rep.differences.length === 0) {
    console.log('  no differences');
    return;
  }
  for (const d of rep.differences) {
    if (d.how === 'split') {
      console.log(`  > split  style_check L${d.theirs!.line}: ${show(d.theirs!.text)}`);
      for (const p of d.parts ?? []) console.log(`           unit: ${show(p)}`);
    } else if (d.how === 'merge') {
      console.log(`  < merge  L${d.ours!.line}: ${show(d.ours!.text)}`);
      for (const p of d.parts ?? []) console.log(`           style_check: ${show(p)}`);
    } else if (d.how === 'ours-only') console.log(`  + unit   L${d.ours!.line} [${d.ours!.part}]: ${show(d.ours!.text)}`);
    else console.log(`  - style_check L${d.theirs!.line} [${d.theirs!.part}]: ${show(d.theirs!.text)}`);
    console.log(`           (${d.intentional ? 'intentional: ' : ''}${d.reason})`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const styleCheck = resolve(args.skill, 'scripts', 'style_check.py');
  if (!existsSync(styleCheck)) {
    console.error(`style_check.py not found at ${styleCheck} (set --skill or PAPER_SKILL_DIR)`);
    process.exit(2);
  }
  let worst = 1;
  const out: Array<{ file: string } & CompareReport> = [];
  for (const file of args.files) {
    const source = readFileSync(file, 'utf8');
    segment(source); // warm-up
    const t0 = performance.now();
    const seg = segment(source);
    const ms = performance.now() - t0;
    const rep = compareWithStyleCheck(seg, parseStyleCheckDump(runDump(styleCheck, shadowForCompile(source))), source);
    worst = Math.min(worst, rep.agreementExplained);
    if (args.json) out.push({ file, ...rep });
    else printReport(file, rep, ms, args.all);
  }
  if (args.json) console.log(JSON.stringify(out, null, 1));
  else console.log(`\nworst agreement excluding intentional differences: ${pct(worst)} (target >= ${pct(args.min)})`);
  if (worst < args.min) process.exit(1);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) main();
