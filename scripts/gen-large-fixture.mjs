#!/usr/bin/env node
/**
 * Generate fixtures/large-multifile/: a real-size, multi-file HEP paper and the analysis repository its
 * numbers come from. Deterministic: the same --seed always writes byte-identical files.
 *
 *   node scripts/gen-large-fixture.mjs [--seed 20261106] [--out fixtures/large-multifile] [--check]
 *
 * Layout written (the generated files are committed; re-run after changing this script):
 *
 *   tex/main.tex              revtex4-2 (aps, prd, preprint): title, abstract, \input of the four section
 *                             files, a summary section, acknowledgments, \appendix, \bibliography{refs}
 *   tex/sections/intro.tex    introduction: one sentence per line, \cite heavy
 *   tex/sections/method.tex   detector, samples, graph, network, training, tracks, metrics: one paragraph
 *                             per line, display math, Table I, two figures
 *   tex/sections/results.tex  results: hard-wrapped at about 100 columns, eight figures, two tables
 *   tex/sections/appendix.tex appendix: one sentence per line, two figures, one table
 *   tex/refs.bib              40 entries (every key is cited)
 *   repo/results/*.json|csv   the numbers the prose states (every prose numeral that is not structural
 *                             matches a fact extracted from these files or from docs/definitions.md)
 *   repo/docs/definitions.md  the selection cuts the prose states
 *
 * About 400 prose sentences (plus captions and footnotes), 12 figures (placeholder \fbox artwork, no
 * image files needed), 4 tables, display math, footnotes, \cite to every bib entry and \ref across files.
 * The paper is synthetic: physics-flavoured, internally consistent, and not a real analysis.
 *
 * --check  regenerate in memory and exit 1 if any committed file differs (CI guard).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const SEED = Number(arg('--seed', '20261106'));
const OUT = resolve(arg('--out', join(ROOT, 'fixtures', 'large-multifile')));
const CHECK = args.includes('--check');

/* ------------------------------------------------------------------------------------ */
/* Seeded randomness                                                                     */
/* ------------------------------------------------------------------------------------ */

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const uni = (a, b) => a + (b - a) * rnd();
const int = (a, b) => Math.floor(uni(a, b + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
/** A value with many digits, like a real artifact (never a round number). */
const real = (a, b, digits = 12) => Number(uni(a, b).toPrecision(digits));
function shuffle(xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------------------------ */
/* The analysis repository (facts)                                                       */
/* ------------------------------------------------------------------------------------ */

const effA = real(0.955, 0.972);
const deltaPts = real(1.6, 2.6);
const sBoot = real(0.12, 0.2);
const sSeeds = real(0.15, 0.25);
const headline = {
  claim: 'H1',
  A: 'generic-trained GNN tracker',
  B: 'signal-trained GNN tracker',
  population: 'displaced test set',
  split: 'held-out test events',
  n_targets: int(11200, 13900),
  eff_A: effA,
  eff_B: Number((effA - deltaPts / 100).toPrecision(12)),
  delta_points: deltaPts,
  sigma_points: Number(Math.hypot(sBoot, sSeeds).toPrecision(12)),
  sigma_boot_points: sBoot,
  sigma_seeds_points: sSeeds,
  fake_rate_A: real(0.0041, 0.0062),
  fake_rate_B: real(0.011, 0.016),
  duplicate_rate_A: real(0.012, 0.019),
  duplicate_rate_B: real(0.021, 0.029),
  outcome: 'holds',
};
headline.fake_rate_diff_points = Number(((headline.fake_rate_A - headline.fake_rate_B) * 100).toPrecision(12));

const SPECIES = [
  { species: 'muon', label: 'muons', n: int(2100, 2600) },
  { species: 'electron', label: 'electrons', n: int(1700, 2200) },
  { species: 'pion', label: 'charged pions', n: int(4100, 4900) },
  { species: 'kaon', label: 'charged kaons', n: int(1200, 1600) },
  { species: 'proton', label: 'protons', n: int(800, 1100) },
];
for (const s of SPECIES) {
  s.eff_A = real(0.93, 0.985);
  s.eff_A_sigma = real(0.0018, 0.0042);
  s.eff_B = Number((s.eff_A - real(0.008, 0.035)).toPrecision(12));
  s.eff_B_sigma = real(0.002, 0.0048);
}

const EDGES = [0, 2, 5, 20, 50, 100, 200, 300, 600];
const DISP = [];
for (let i = 0; i + 1 < EDGES.length; i++) {
  const t = i / (EDGES.length - 2);
  const a = 0.985 - 0.09 * t * t + uni(-0.004, 0.004);
  DISP.push({ bin: i, r_lo_mm: EDGES[i], r_hi_mm: EDGES[i + 1], n: int(900, 2400), eff_A: Number(a.toPrecision(12)), eff_B: Number((a - 0.004 - 0.05 * t + uni(-0.003, 0.003)).toPrecision(12)) });
}

const PILEUP = [0, 50, 140, 200].map((mu, i) => ({
  mu,
  eff_A: Number((effA - 0.006 * i - uni(0, 0.002)).toPrecision(12)),
  eff_B: Number((effA - deltaPts / 100 - 0.011 * i - uni(0, 0.002)).toPrecision(12)),
  fake_rate_A: Number((headline.fake_rate_A * (1 + 0.45 * i)).toPrecision(12)),
}));

const timing = {
  graph_build_time_ms: real(38, 61),
  inference_time_ms: real(140, 190),
  track_build_time_ms: real(22, 35),
  baseline_total_time_ms: real(260, 330),
};
timing.total_time_ms = Number((timing.graph_build_time_ms + timing.inference_time_ms + timing.track_build_time_ms).toPrecision(12));

const resolution = {
  d0_resolution_mm: real(0.017, 0.026),
  z0_resolution_mm: real(0.045, 0.072),
  pt_resolution_frac: real(0.014, 0.022),
  phi0_resolution_mrad: real(0.31, 0.52),
};

const graph = {
  edge_eff: real(0.982, 0.993),
  edge_purity: real(0.36, 0.47),
  n_edges_per_event: int(141000, 168000),
  n_nodes_per_event: int(38000, 46000),
  ceiling_eff: real(0.986, 0.995),
};

const training = {
  n_train_events: 8000,
  n_val_events: 1000,
  n_test_events: 1000,
  n_epochs: 60,
  batch_size: 16,
  learning_rate: 0.0003,
  n_seeds: 3,
  hidden_dim: 128,
  n_message_passing: 8,
  n_parameters: int(1_210_000, 1_380_000),
};

const setup = { sqrt_s_tev: 14, n_layers: 22, n_ttbar_events: 10000, n_signal_events: 10000 };

const ABLATION = [
  { variant: 'full', label: 'full model', eff_A: Number(effA.toPrecision(12)) },
  { variant: 'no_edge_features', label: 'without edge features', eff_A: Number((effA - real(0.006, 0.011)).toPrecision(12)) },
  { variant: 'four_iterations', label: 'four message-passing steps', eff_A: Number((effA - real(0.012, 0.02)).toPrecision(12)) },
  { variant: 'no_curvature_loss', label: 'without the curvature term', eff_A: Number((effA - real(0.003, 0.006)).toPrecision(12)) },
];

const SEED_EFFS = [0, 1, 2].map(() => Number((effA + uni(-0.0025, 0.0025)).toPrecision(12)));

const PT_EDGES = [1, 2, 5, 10, 20, 50];
const PT_BINS = PT_EDGES.slice(0, -1).map((lo, i) => {
  const a = Number((effA - 0.02 + 0.006 * i + uni(-0.002, 0.002)).toPrecision(12));
  return { pt_lo_gev: lo, pt_hi_gev: PT_EDGES[i + 1], n: int(1200, 3600), eff_A: a, eff_B: Number((a - deltaPts / 100 + uni(-0.004, 0.004)).toPrecision(12)) };
});
const SIGNAL_POINTS = [
  { point: 'm10_ct100', mass_gev: 10, ctau_mm: 100 },
  { point: 'm15_ct100', mass_gev: 15, ctau_mm: 100 },
  { point: 'm15_ct200', mass_gev: 15, ctau_mm: 200 },
  { point: 'm20_ct300', mass_gev: 20, ctau_mm: 300 },
].map((p, i) => ({ ...p, eff_A: Number((effA - 0.004 * i + uni(-0.002, 0.002)).toPrecision(12)), eff_B: Number((effA - deltaPts / 100 - 0.007 * (i - 1) + uni(-0.002, 0.002)).toPrecision(12)) }));
const lrt = { eff_lrt: real(0.78, 0.84), fake_rate_lrt: real(0.031, 0.044), time_lrt_ms: real(410, 520), pair_eff_A: real(0.89, 0.92), pair_eff_B: real(0.84, 0.87) };

const fmtCsv = (v) => (typeof v === 'number' ? String(v) : v);
function csv(rows, cols) {
  return [cols.join(','), ...rows.map((r) => cols.map((c) => fmtCsv(r[c])).join(','))].join('\n') + '\n';
}
const json = (o) => JSON.stringify(o, null, 1) + '\n';

const REPO = {
  'README.md':
    '# Synthetic analysis repository (paper-copilot scale fixture)\n\nGenerated by scripts/gen-large-fixture.mjs. Every number the paper in ../tex states comes from\n`results/` or `docs/definitions.md`. Not a real analysis.\n',
  'results/headline_claim.json': json(headline),
  'results/species.csv': csv(SPECIES, ['species', 'label', 'n', 'eff_A', 'eff_A_sigma', 'eff_B', 'eff_B_sigma']),
  'results/displacement.csv': csv(DISP, ['bin', 'r_lo_mm', 'r_hi_mm', 'n', 'eff_A', 'eff_B']),
  'results/pileup.json': json({ scan: PILEUP }),
  'results/timing.json': json(timing),
  'results/resolution.json': json(resolution),
  'results/graph.json': json(graph),
  'results/training.json': json(training),
  'results/setup.json': json(setup),
  'results/ablation.csv': csv(ABLATION, ['variant', 'label', 'eff_A']),
  'results/seeds.json': json({ eff_A_seeds: SEED_EFFS }),
  'results/pt_bins.csv': csv(PT_BINS, ['pt_lo_gev', 'pt_hi_gev', 'n', 'eff_A', 'eff_B']),
  'results/signal_points.csv': csv(SIGNAL_POINTS, ['point', 'mass_gev', 'ctau_mm', 'eff_A', 'eff_B']),
  'results/lrt_comparison.json': json(lrt),
  'docs/definitions.md': [
    '# Definitions',
    '',
    'Fixed before any performance number is produced. Units: mm, GeV, rad.',
    '',
    '## Targets',
    '',
    '- Target particle: pT > 1 GeV, |eta| < 4 and >= 5 space points.',
    '- Displaced particle: a target with |d0| > 2 mm.',
    '- Track quality: tracks with |T| >= 5 hits enter the fake rate.',
    '',
    '## Graph',
    '',
    '- Edge selection: edges with score > 0.5 are kept.',
    '- Module map: hit pairs with |dz| < 300 mm on adjacent layers.',
    '',
  ].join('\n'),
};

/* ------------------------------------------------------------------------------------ */
/* Number formatting (exactly the precision the gate accepts)                            */
/* ------------------------------------------------------------------------------------ */

const pct = (v, d = 2) => `${(v * 100).toFixed(d)}\\%`;
const pts = (v, d = 2) => `${v.toFixed(d)} points`;
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const mm = (v, d) => `${v.toFixed(d)}~mm`;
const ms = (v, d = 0) => `${v.toFixed(d)}~ms`;

/* ------------------------------------------------------------------------------------ */
/* Bibliography                                                                          */
/* ------------------------------------------------------------------------------------ */

const SURNAMES = ['Abe', 'Bauer', 'Chen', 'Dubois', 'Esposito', 'Fischer', 'Garcia', 'Hansen', 'Ito', 'Jensen', 'Kowalski', 'Lindqvist', 'Moreau', 'Novak', 'Okafor', 'Petrov', 'Quinn', 'Rossi', 'Sato', 'Tanaka', 'Usman', 'Vargas', 'Weber', 'Xu', 'Yilmaz', 'Zhang'];
const INITIALS = ['A.', 'B.', 'C.', 'D.', 'E.', 'F.', 'G.', 'H.', 'J.', 'K.', 'L.', 'M.', 'N.', 'P.', 'R.', 'S.', 'T.', 'W.'];
const TOPICS = [
  ['LLP', 'Searches for long-lived particles at the LHC'],
  ['Displaced', 'Search for displaced vertices in proton-proton collisions'],
  ['LRT', 'Large-radius tracking for displaced charged particles'],
  ['ExaTrkX', 'Graph neural networks for particle track reconstruction'],
  ['Interaction', 'Interaction networks for learning about objects and relations'],
  ['GNNReview', 'Graph neural networks in particle physics'],
  ['TrackML', 'The tracking machine learning challenge'],
  ['ACTS', 'A common tracking software project'],
  ['Kalman', 'Application of Kalman filtering to track and vertex fitting'],
  ['Combinatorial', 'Combinatorial track finding in dense environments'],
  ['HNL', 'Heavy neutral leptons and their collider signatures'],
  ['DarkPhoton', 'Dark photons decaying to displaced lepton pairs'],
  ['Pileup', 'Track reconstruction at high pile-up'],
  ['Trigger', 'A track trigger for displaced signatures'],
  ['Hough', 'Hough transforms for fast track finding'],
  ['Cellular', 'Cellular automata for track seeding'],
  ['MessagePassing', 'Neural message passing for quantum chemistry'],
  ['EdgeClass', 'Edge classification for graph-based tracking'],
  ['Metric', 'Metric learning for graph construction'],
  ['Filtering', 'Learned filtering of candidate graph edges'],
  ['Bootstrap', 'Bootstrap methods for confidence intervals'],
  ['Seeds', 'On the variance of neural network training across random seeds'],
  ['Adam', 'Adam: a method for stochastic optimization'],
  ['GPU', 'Accelerated track reconstruction on graphics processors'],
  ['Inference', 'Fast inference of graph networks on accelerators'],
  ['Geant', 'Geant4: a simulation toolkit'],
  ['Pythia', 'An introduction to PYTHIA 8'],
  ['Delphes', 'A modular framework for fast detector simulation'],
  ['Resolution', 'Impact parameter resolution of silicon trackers'],
  ['Material', 'Material effects in charged-particle tracking'],
  ['Vertexing', 'Adaptive vertex fitting'],
  ['Anomaly', 'Model-independent searches with machine learning'],
  ['Generalization', 'Out-of-distribution generalization of learned trackers'],
  ['Domain', 'Domain adaptation in high-energy physics'],
  ['Robustness', 'Robustness of machine-learned reconstruction to detector conditions'],
  ['Upgrade', 'Technical design of an all-silicon tracker upgrade'],
  ['Software', 'Software and computing for the high-luminosity LHC'],
  ['FCC', 'Physics opportunities at a future circular collider'],
  ['Calibration', 'Calibration of track reconstruction efficiency with data'],
  ['Statistics', 'Asymptotic formulae for likelihood-based tests of new physics'],
];
const BIB = TOPICS.map(([tag, title], i) => {
  const first = SURNAMES[(i * 7 + 3) % SURNAMES.length];
  const year = 2008 + ((i * 5) % 17);
  const nAuth = 1 + (i % 4);
  const authors = Array.from({ length: nAuth }, (_, k) => `${SURNAMES[(i * 7 + 3 + k * 5) % SURNAMES.length]}, ${INITIALS[(i + k * 3) % INITIALS.length]}`).join(' and ');
  const key = `${first}${year}${tag}`;
  const kind = i % 9 === 4 ? 'misc' : i % 11 === 7 ? 'inproceedings' : 'article';
  const journal = pick(['Phys. Rev. D', 'Phys. Rev. Lett.', 'Eur. Phys. J. C', 'JHEP', 'Comput. Softw. Big Sci.', 'Nucl. Instrum. Meth. A', 'JINST']);
  const eprint = `${String(10 + ((i * 3) % 15)).padStart(2, '0')}${String(1 + (i % 12)).padStart(2, '0')}.${String(int(1000, 9999))}`;
  const lines = [`@${kind}{${key},`, `  author = {${authors}},`, `  title = {{${title}}},`];
  if (kind === 'article') lines.push(`  journal = {${journal}},`, `  volume = {${int(10, 120)}},`, `  pages = {${int(100, 999)}${int(10, 99)}},`);
  if (kind === 'inproceedings') lines.push('  booktitle = {Proceedings of the Connecting the Dots Workshop},');
  if (kind === 'misc') lines.push('  howpublished = {Technical report},');
  lines.push(`  year = {${year}},`, `  eprint = {${eprint}},`, '  archivePrefix = {arXiv},', '}');
  return { key, tag, title, lines };
});
const KEY = Object.fromEntries(BIB.map((b) => [b.tag, b.key]));
const cite = (...tags) => `~\\cite{${tags.map((t) => KEY[t]).join(',')}}`;

/* ------------------------------------------------------------------------------------ */
/* Prose                                                                                 */
/* ------------------------------------------------------------------------------------ */

const seen = new Set();
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** Register a sentence; the fixture never repeats one (anchoring relies on mostly unique text). */
function S(s) {
  const n = norm(s);
  if (seen.has(n)) throw new Error(`duplicate sentence in the generator: ${s}`);
  seen.add(n);
  return s;
}
/** Combinatorial sentence: fill {a|b|c} alternatives at random until the sentence is new. */
function V(template) {
  for (let tries = 0; tries < 200; tries++) {
    const s = template.replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, alts) => pick(alts.split('|')));
    if (!seen.has(norm(s))) return S(s);
  }
  throw new Error(`no unused variant left for: ${template}`);
}

const fig = (k) => `Fig.~\\ref{fig:${k}}`;
const Fig = (k) => `Figure~\\ref{fig:${k}}`;
const tab = (k) => `Table~\\ref{tab:${k}}`;
const sec = (k) => `Sec.~\\ref{sec:${k}}`;
const eq = (k) => `Eq.~(\\ref{eq:${k}})`;
const app = (k) => `Appendix~\\ref{app:${k}}`;

const H = headline;
const T = training;

/* ---- abstract (main.tex) ---- */
const ABSTRACT = [
  S('Charged particles from the decay of a long-lived particle start far from the collision point, and trackers tuned on prompt particles lose many of them.'),
  S('Graph-neural-network trackers recover such particles, but so far they have been trained on the signal they are meant to find.'),
  S(`We train a tracker only on generic top-quark pair events and test it on displaced particles that neither model saw in training.`),
  S(`It finds ${pct(H.eff_A)} of the displaced targets, compared with ${pct(H.eff_B)} for a tracker trained on the signal itself, at a fake-track rate of ${pct(H.fake_rate_A)} against ${pct(H.fake_rate_B)}.`),
  S('The lead holds for every particle species, at every displacement and up to the highest pile-up we simulate.'),
  S('A tracker that never sees the signal can therefore serve a search without biasing it toward one model.'),
];

/* ---- introduction ---- */
const INTRO = [
  [
    S(`Many extensions of the Standard Model predict particles that live long enough to travel a measurable distance before they decay${cite('LLP', 'HNL')}.`),
    S(`Their charged decay products start far from the beam line, so their tracks do not point back to the collision point${cite('Displaced')}.`),
    S('Searches for such signatures have become a central part of the physics programme of the LHC experiments.'),
    S(`Heavy neutral leptons and dark photons are two well-motivated examples${cite('HNL', 'DarkPhoton')}.`),
    S('In both cases the signal is a few tracks that appear in the middle of the detector.'),
    S('Finding these tracks is the first step of every such search, and every later step inherits its losses.'),
  ],
  [
    S(`Standard track reconstruction starts from seeds near the beam line and extends them outward with a Kalman filter${cite('Kalman', 'Combinatorial')}.`),
    S('This strategy is efficient for prompt particles and fast enough for the trigger.'),
    S('It loses particles whose first hit lies beyond the innermost layers, because no seed can be formed for them.'),
    S(`Dedicated large-radius tracking recovers part of these particles at a large cost in time and fake tracks${cite('LRT')}.`),
    S(`The cost grows with pile-up, which will increase several-fold at the high-luminosity LHC${cite('Pileup', 'Upgrade')}.`),
    S('A reconstruction that treats prompt and displaced particles alike would remove this trade-off.'),
  ],
  [
    S(`Graph neural networks offer such a reconstruction${cite('GNNReview')}.`),
    S('They represent the hits of an event as the nodes of a graph and the possible track segments as its edges.'),
    S(`A network then learns which edges belong to the same particle${cite('Interaction', 'MessagePassing')}.`),
    S(`The Exa.TrkX pipeline showed that this approach reaches high efficiency on the TrackML detector${cite('ExaTrkX', 'TrackML')}.`),
    S('Because the graph does not assume that a particle comes from the beam line, displaced particles are not excluded by construction.'),
    S(`Recent studies extended these pipelines to large-radius tracks and found efficiencies close to those of prompt tracks${cite('EdgeClass', 'Metric')}.`),
  ],
  [
    S('However, these studies trained the network on the signal they later evaluate.'),
    S('A tracker trained on one model of new physics may favour that model and miss others.'),
    S('In a search this is a bias: the selection would depend on the hypothesis being tested.'),
    S(`The machine-learning literature calls the question out-of-distribution generalization${cite('Generalization', 'Domain')}.`),
    S('For tracking it has not been answered, because the training and test samples were always drawn from the same process.'),
    S('We ask whether a tracker trained only on Standard Model events can find displaced particles as well as one trained on the signal.'),
  ],
  [
    S('To answer it, we train two copies of the same pipeline.'),
    S('One copy sees only top-quark pair events, which contain almost no displaced particles.'),
    S('The other copy sees the displaced signal it will be tested on.'),
    S('Both copies share the graph construction, the network, the track builder and every hyperparameter.'),
    S('We then compare them on displaced particles generated after the design of the study was frozen.'),
    S('A tracker that wins this comparison does not need the signal to be trained.'),
  ],
  [
    S(`The answer is yes: the generic-trained tracker finds ${pts(H.delta_points)} more displaced targets than the signal-trained one.`),
    S(`It also produces fewer fake tracks and fewer duplicates${cite('Calibration')}.`),
    S('The result holds across particle species, displacement and pile-up.'),
    S(`It does not depend on the choice of training seed or on the bootstrap of the test events${cite('Bootstrap', 'Seeds')}.`),
    S('The rest of this paper explains how we reached it.'),
  ],
  [
    S(`Section~\\ref{sec:method} describes the detector, the samples, the graph and the network.`),
    S(`Section~\\ref{sec:results} compares the two trackers and shows where the difference comes from.`),
    S(`Section~\\ref{sec:summary} summarizes the result, and ${app('stat')} gives the details of the uncertainty.`),
    S(`The figures that carry the evidence are ${fig('eff_disp')} for the displacement and ${fig('pileup')} for pile-up.`),
  ],
  [
    S(`Our study builds on a long line of work on fast tracking${cite('Hough', 'Cellular', 'Trigger')}.`),
    S(`Graph-based pipelines have been ported to accelerators and now run within the time budget of a software trigger${cite('GPU', 'Inference')}.`),
    S(`Their robustness to detector conditions has been studied for prompt particles${cite('Robustness')}.`),
    S('Displaced particles have received less attention, because they are rare in the samples used for training.'),
    S('This scarcity is exactly what makes generic training attractive: the network cannot learn the signal it never sees.'),
  ],
  [
    S(`We simulate collisions at a centre-of-mass energy of ${setup.sqrt_s_tev}~TeV with a generic all-silicon detector${cite('ACTS', 'Pythia')}.`),
    S(`The detector response is simulated with a fast model that keeps the material and the magnetic field of the full geometry${cite('Geant', 'Delphes')}.`),
    S(`The study therefore measures the tracker, not the detector, and its numbers hold within this simulation only${cite('Material', 'Resolution')}.`),
    S('We expect the comparison between the two trackers to carry over to a real detector, because both suffer the same effects.'),
  ],
  [
    S(`The question matters beyond the LHC, where future colliders will face higher rates and new long-lived signatures${cite('FCC', 'Software')}.`),
    S(`It also matters for model-independent searches, which need a reconstruction that does not encode a signal hypothesis${cite('Anomaly')}.`),
    S(`Statistical tools for such searches assume that the selection does not depend on the model being tested${cite('Statistics')}.`),
    S('A generic-trained tracker satisfies this assumption by construction.'),
  ],
  [
    S('We keep the comparison fair in three ways.'),
    S('First, both trackers use the same architecture and the same number of training events.'),
    S('Second, every choice of the pipeline was fixed on validation events before the test events were examined.'),
    S('Third, the test particles come from a signal sample that neither tracker was trained on.'),
    S('With these precautions, a difference between the trackers can only come from what they were trained on.'),
  ],
];

/* ---- method ---- */
const METHOD_DET = [
  [
    S(`The detector has ${setup.n_layers} silicon layers arranged in a barrel and two endcaps, inside a solenoidal magnetic field.`),
    S('The innermost layers are pixel sensors, and the outer layers are strip sensors with a coarser resolution along the beam axis.'),
    S(`Figure~\\ref{fig:detector} shows the layout in the transverse and longitudinal views.`),
    S('Each charged particle leaves one hit per layer it crosses, plus occasional extra hits where modules overlap.'),
    S('Hits are recorded as three-dimensional space points in cylindrical coordinates.'),
  ],
  [
    S('We use three samples of simulated events.'),
    S(`The generic sample contains ${thousands(setup.n_ttbar_events)} top-quark pair events without pile-up.`),
    S(`The signal sample contains ${thousands(setup.n_signal_events)} events in which a heavy neutral lepton decays to a muon and two other charged particles.`),
    S('The external test sample was generated with a different lepton mass and lifetime after the design of the study was fixed.'),
    S(`Each sample is split into ${thousands(T.n_train_events)} training, ${thousands(T.n_val_events)} validation and ${thousands(T.n_test_events)} test events; ${tab('samples')} lists them.`),
    S('Selection of anything (models, thresholds, working points, bins) uses validation events only.'),
  ],
  [
    S('A target particle has $p_T > 1$~GeV, $|\\eta| < 4$ and at least five space points.'),
    S('A displaced particle is a target with a transverse impact parameter $|d_0| > 2$~mm.'),
    S('The impact parameter is defined from the particle\'s own hits by a circle fit in the transverse plane,'),
  ],
];
// the last sentence of METHOD_DET continues with display math (see the method text below)

const METHOD_GRAPH = [
  [
    S('The pipeline has four stages: graph construction, edge classification, edge selection and track building.'),
    S(`${Fig('pipeline')} shows the stages and the information that flows between them.`),
    S('Graph construction connects each hit to the hits on adjacent layers that a particle could plausibly reach.'),
    S('A module map, learned from the training events, lists the pairs of modules that particles actually connect.'),
    S('Only hit pairs with $|\\Delta z| < 300$~mm on adjacent layers enter the graph.'),
    S(`On average a graph holds ${thousands(graph.n_nodes_per_event)} nodes and ${thousands(graph.n_edges_per_event)} edges per event.`),
    S(`It keeps ${pct(graph.edge_eff)} of the true edges at an edge purity of ${graph.edge_purity.toFixed(2)}.`),
  ],
  [
    S('The edge classifier is an interaction network that updates node and edge features in alternating steps.'),
    S(`Each of the ${T.n_message_passing} message-passing steps lets information travel one edge further along a candidate track.`),
    S(`The node and edge networks are multilayer perceptrons with ${T.hidden_dim} hidden units each.`),
    S(`The full model has ${thousands(T.n_parameters)} trainable parameters.`),
    S('After the last step, a final perceptron assigns each edge a score between zero and one.'),
  ],
  [
    S('The network is trained with a weighted binary cross-entropy,'),
  ],
];

const METHOD_TRAIN = [
  [
    S(`We train for ${T.n_epochs} epochs with the Adam optimizer${cite('Adam')}, a batch of ${T.batch_size} events and a learning rate of $3\\times10^{-4}$.`),
    S(`Every configuration is trained with ${T.n_seeds} random seeds, and the reported numbers are averages over the seeds.`),
    S('The two trackers differ only in their training events: generic events for one, signal events for the other.'),
    S('Training stops at the epoch with the best validation efficiency, judged on validation events of the training process itself.'),
    S('No test event influences any choice of the pipeline.'),
  ],
  [
    S('Edges with a score above one half are kept.'),
    S('The threshold was fixed on validation events of the generic sample and is the same for both trackers.'),
    S('Track building then follows the kept edges from each hit with no incoming edge to the hit with no outgoing edge.'),
    S('Where a path branches, the builder follows the edge with the higher score and starts a new candidate at the other.'),
    S('A candidate becomes a track when it holds at least five hits.'),
  ],
  [
    S('A reconstructed track matches a particle if more than half of its hits come from that particle and more than half of the particle\'s hits are on the track.'),
    S('This criterion is called double majority.'),
    S('The efficiency is the fraction of target particles matched by a track,'),
  ],
];

const METHOD_METRIC = [
  [
    S('A fake track is a track with at least five hits that matches no particle.'),
    S('The fake-track rate is the fraction of such tracks among all tracks with at least five hits.'),
    S('A duplicate is a second track matched to a particle that already has one.'),
    S('The three numbers together describe what a search would see: the particles it finds, the noise it must reject and the double counting it must undo.'),
  ],
  [
    S('The headline number is the efficiency difference between the trackers on displaced targets,'),
  ],
  [
    S(`Its uncertainty combines two sources in quadrature: the bootstrap of the test events and the spread over training seeds${cite('Bootstrap')}.`),
    S(`The bootstrap draws the same resampled event lists for both trackers, so their difference is not affected by which events happen to be in the test set${cite('Statistics')}.`),
    S(`${app('stat')} gives the details of both components.`),
    S(`Both trackers are evaluated on exactly the same test events and the same target particles.`),
  ],
];

/* ---- results ---- */
const RES = [];
RES.push([
  S(`On the displaced test particles, the generic-trained tracker finds ${pct(H.eff_A)} of the targets.`),
  S(`The signal-trained tracker finds ${pct(H.eff_B)} of the same targets.`),
  S(`The difference is ${H.delta_points.toFixed(2)}~$\\pm$~${H.sigma_points.toFixed(2)} points, in favour of the tracker that never saw the signal.`),
  S(`The test set holds ${thousands(H.n_targets)} target particles, so the difference corresponds to about two hundred particles.`),
  S(`${tab('headline')} lists the efficiencies together with the fake-track and duplicate rates.`),
]);
RES.push([
  S(`The generic-trained tracker also produces fewer fake tracks: ${pct(H.fake_rate_A)} against ${pct(H.fake_rate_B)}.`),
  S(`Its duplicate rate is ${pct(H.duplicate_rate_A, 1)}, compared with ${pct(H.duplicate_rate_B, 1)} for the signal-trained tracker.`),
  S('A tracker that finds more particles usually pays with more fake tracks, so the lead on both metrics is not a trade-off.'),
  S(`${Fig('fake')} shows the fake-track rate as a function of the track length.`),
  S('The difference in fake tracks comes mostly from short tracks of five or six hits.'),
]);
for (let i = 0; i < DISP.length; i++) {
  const d = DISP[i];
  if (i === 0) {
    RES.push([
      S(`${Fig('eff_disp')} shows the efficiency as a function of the transverse displacement of the production vertex.`),
      S(`Close to the beam line, between zero and ${d.r_hi_mm}~mm, both trackers find more than ${pct(Math.min(d.eff_A, d.eff_B) - 0.0005, 1)} of the targets.`),
    ]);
  } else {
    const p = RES[RES.length - 1];
    const which = i % 3;
    if (which === 0) p.push(S(`Between ${d.r_lo_mm} and ${d.r_hi_mm}~mm, the generic-trained tracker finds ${pct(d.eff_A)} of the targets and the signal-trained one ${pct(d.eff_B)}.`));
    else if (which === 1) p.push(S(`In the bin from ${d.r_lo_mm} to ${d.r_hi_mm}~mm, the efficiencies are ${pct(d.eff_A)} and ${pct(d.eff_B)}.`));
    else p.push(S(`For production radii from ${d.r_lo_mm} to ${d.r_hi_mm}~mm, the efficiencies are ${pct(d.eff_A)} for the generic-trained tracker and ${pct(d.eff_B)} for the baseline.`));
    if (i === 3) {
      p.push(S('The gap between the trackers widens with displacement.'));
      RES.push([]);
    }
  }
}
RES[RES.length - 1].push(
  S('Beyond the outermost pixel layer, both trackers lose particles that leave fewer than five hits.'),
  S('This loss is a property of the detector, not of the trackers, and it is the same for both.'),
  S(`The widening gap shows that the generic-trained tracker generalizes better precisely where the signal-trained one should have its advantage.`),
);
RES.push([
  S(`${Fig('eff_species')} breaks the efficiency down by particle species.`),
  ...SPECIES.map((s, i) =>
    S(
      i % 2 === 0
        ? `For ${s.label}, the efficiencies are ${pct(s.eff_A)} and ${pct(s.eff_B)}, from ${thousands(s.n)} targets.`
        : `The ${thousands(s.n)} ${s.label} are found with efficiencies of ${pct(s.eff_A)} and ${pct(s.eff_B)}.`,
    ),
  ),
  S(`${tab('species')} lists the numbers with their bootstrap uncertainties.`),
  S('The lead holds for every species.'),
  S('Electrons are the hardest case for both trackers, because they lose energy in the material and their tracks bend more than the network expects.'),
]);
RES.push([
  S(`${Fig('pileup')} shows how the efficiency changes when pile-up is added to the test events.`),
  ...PILEUP.slice(1).map((p, i) =>
    S(
      [
        `At an average of ${p.mu} pile-up interactions, the generic-trained tracker finds ${pct(p.eff_A)} of the targets and the baseline ${pct(p.eff_B)}.`,
        `With ${p.mu} pile-up interactions, the efficiencies fall to ${pct(p.eff_A)} and ${pct(p.eff_B)}.`,
        `At ${p.mu} interactions per crossing, the efficiencies are ${pct(p.eff_A)} and ${pct(p.eff_B)}, and the fake-track rate of the generic-trained tracker rises to ${pct(p.fake_rate_A)}.`,
      ][i],
    ),
  ),
  S('Neither tracker was trained with pile-up, so both see it here for the first time.'),
  S('The generic-trained tracker degrades more slowly, which suggests that it has learned the geometry of tracks rather than the topology of the signal.'),
]);
RES.push([
  S(`${Fig('resolution')} compares the track parameters with the true values.`),
  S(`The transverse impact parameter is measured with a resolution of ${mm(resolution.d0_resolution_mm, 3)}, and the longitudinal one with ${mm(resolution.z0_resolution_mm, 3)}.`),
  S(`The relative transverse-momentum resolution is ${pct(resolution.pt_resolution_frac)}.`),
  S(`The azimuthal angle is measured to ${resolution.phi0_resolution_mrad.toFixed(2)}~mrad.`),
  S('These resolutions are the same for both trackers within their uncertainties, because they come from the hits, not from the network.'),
]);
RES.push([
  S(`${Fig('graph')} shows the edge efficiency of the graph as a function of the layer pair.`),
  S(`A perfect edge classifier on the same graph would reach an efficiency of ${pct(graph.ceiling_eff)}; this is the ceiling of the pipeline.`),
  S('The generic-trained tracker closes most of the distance between the baseline and this ceiling.'),
  S('The remaining loss comes from edges that the module map never proposes.'),
  S('Improving the graph would raise both trackers by the same amount, so it would not change the comparison.'),
]);
RES.push([
  S(`${Fig('timing')} shows the time spent in each stage of the pipeline on one graphics processor.`),
  S(`Graph construction takes ${ms(timing.graph_build_time_ms)} per event, the edge classifier ${ms(timing.inference_time_ms)} and track building ${ms(timing.track_build_time_ms)}.`),
  S(`The total of ${ms(timing.total_time_ms)} compares with ${ms(timing.baseline_total_time_ms)} for the standard reconstruction with large-radius tracking enabled.`),
  S('The two trackers take the same time, because they share the architecture.'),
  S('The timing would allow the pipeline to run in a software trigger, but we have not optimized it for that purpose.'),
]);
RES.push([
  S(`${Fig('ablation')} shows which parts of the network carry the result.`),
  ...ABLATION.slice(1).map((a, i) =>
    S(
      [
        `Removing the edge features lowers the efficiency of the generic-trained tracker to ${pct(a.eff_A)}.`,
        `With four message-passing steps instead of eight, the efficiency drops to ${pct(a.eff_A)}.`,
        `Without the curvature term in the loss, the efficiency is ${pct(a.eff_A)}.`,
      ][i],
    ),
  ),
  S('The number of message-passing steps matters most, because a displaced track needs more steps to connect its first hit to the rest.'),
  S('None of the variants reverses the comparison with the signal-trained tracker.'),
]);
RES.push([
  S('We checked that the result does not depend on details of the analysis.'),
  S('Changing the edge threshold within the range allowed by the validation events moves both efficiencies by the same amount.'),
  S('Using single instead of double majority raises both efficiencies and leaves the difference unchanged within its uncertainty.'),
  S('Evaluating on the training process of each tracker shows that both reach a similar efficiency on their own kind of events.'),
  S('The advantage of the generic-trained tracker therefore appears only on events that neither tracker was trained on.'),
  S(`Each check is repeated for every training seed, and ${app('seeds')} shows the spread.`),
]);
RES.push([
  S('Why does the tracker that never saw the signal do better on it?'),
  S('The top-quark pair events contain many more particles per event than the signal events.'),
  S('The generic-trained network therefore sees many more examples of tracks, including the few displaced tracks from heavy-flavour decays.'),
  S('The signal-trained network sees fewer tracks, and most of them share the kinematics of one decay.'),
  S('It learns that decay well and generalizes less to the different lifetime and mass of the test sample.'),
  S(`This interpretation is consistent with the pile-up study in ${fig('pileup')}, where the generic-trained tracker degrades more slowly.`),
]);
RES.push([
  S('Our study has three limitations.'),
  S('The detector is a generic model, and a real detector has dead modules, misalignment and a more complex material map.'),
  S('The signal is one family of models, and other long-lived signatures may behave differently.'),
  S('The test events have no pile-up in the headline comparison, and the pile-up study uses a simplified overlay.'),
  S('None of these limitations favours one of the trackers, so we expect the comparison to survive them.'),
  S(`The numbers in ${tab('headline')} and ${tab('species')} are therefore statements about this simulation only.`),
]);

/* ---- summary (main.tex) ---- */
const SUMMARY = [
  [
    S('We asked whether a graph-neural-network tracker needs to see the signal it is meant to find.'),
    S(`Trained only on generic events, the tracker finds ${pts(H.delta_points)} more displaced targets than the same tracker trained on the signal.`),
    S('It also makes fewer fake tracks and fewer duplicates, and its lead holds for every species, displacement and pile-up we tested.'),
    S(`The comparison in ${sec('results')} is controlled: both trackers share every part of the pipeline except their training events.`),
  ],
  [
    S('The result removes one obstacle to using learned trackers in searches.'),
    S('A tracker trained on generic events does not encode a signal hypothesis, so it can serve many searches at once.'),
    S('The next step is to repeat the comparison on a detector with realistic conditions and on more signal models.'),
    S('We expect the generic-trained tracker to keep its advantage, because its training events are the ones every experiment has in abundance.'),
  ],
];

/* ---- appendix ---- */
const APPX = [
  [
    S(`The uncertainty of the headline difference has two components.`),
    S(`The bootstrap component is ${pts(H.sigma_boot_points)}, from resampling the test events with replacement.`),
    S(`The seed component is ${pts(H.sigma_seeds_points)}, from the spread of the difference over the training seeds.`),
    S(`Added in quadrature they give the total of ${pts(H.sigma_points)} quoted in ${sec('results')}.`),
    S(`${Fig('bootstrap')} shows the distribution of the difference over the bootstrap replicas.`),
    S('The distribution is close to Gaussian, so the quadrature sum is a fair summary.'),
  ],
  [
    S('The bootstrap resamples events, not particles, because particles of one event share its hits and are not independent.'),
    S('The same resampled event lists are used for both trackers, which removes the common fluctuation from the difference.'),
    S('Without this pairing, the uncertainty of the difference would be dominated by which events happen to be in the test set.'),
    S('We generated the event lists once, with a fixed seed, before any test result was examined.'),
  ],
];
const APPX_SEEDS = [
  [
    S(`${Fig('seeds')} shows the efficiency of the generic-trained tracker for each training seed.`),
    S(`The three seeds give ${pct(SEED_EFFS[0])}, ${pct(SEED_EFFS[1])} and ${pct(SEED_EFFS[2])}.`),
    S('The spread is small compared with the difference between the trackers.'),
    S('The signal-trained tracker shows a similar spread, so neither tracker is unusually sensitive to its initialization.'),
  ],
  [
    S(`${tab('hyper')} lists the hyperparameters of the network and of the training.`),
    S('They were chosen on validation events of the generic sample and then frozen.'),
    S('The signal-trained tracker uses the same values, although a dedicated tuning might have helped it.'),
    S('We did not tune it separately, because a tuning on signal events would have required looking at the test topology.'),
    S('A fair tuning of both trackers on their own validation events is left for future work.'),
  ],
  [
    S('The training events of both trackers have the same number of events but not the same number of particles.'),
    S('The generic events hold several times more target particles per event than the signal events.'),
    S('To test whether this explains the result, we trained the generic tracker on a subset with the same number of particles as the signal sample.'),
    S('The subset-trained tracker still finds more displaced targets than the signal-trained one, although its lead is smaller.'),
    S('The number of training particles is therefore part of the explanation but not all of it.'),
  ],
];

const FOOTNOTES = [
  S('The module map is built from training events only, so it contains no information about the test sample.'),
  S('We use the true hit-to-particle assignment only for training and for the evaluation, never inside the pipeline.'),
  S('The quadrature sum assumes that the two components are independent, which holds because they come from different sources of randomness.'),
  S('A track may match at most one particle and a particle at most one track under double majority.'),
  S('The pile-up events are drawn from the same generic sample as the training events but from disjoint event numbers.'),
  S('The timing excludes reading the events from disk and writing the tracks.'),
  S('Heavy-flavour hadrons travel a few millimetres before they decay, so the generic sample does contain some displaced tracks.'),
  S('Fixing the seed of the bootstrap makes the uncertainty itself reproducible.'),
];

/* ---- more prose (each block is placed below) ---- */
const INTRO_MORE = [
  [
    S('Early searches for long-lived particles relied on hand-written selections of displaced vertices.'),
    S('Their reach was limited by the tracking, because a vertex can only be built from tracks that were found.'),
    S('Later searches added dedicated passes of track finding with relaxed requirements on the impact parameter.'),
    S('These passes raised the efficiency for displaced particles but also the number of fake tracks, which then had to be removed by tighter vertex selections.'),
    S('The net gain depended strongly on the signal model, because the relaxed passes were tuned for particular lifetimes.'),
  ],
  [
    S('Learned trackers change this picture in two ways.'),
    S('They can be trained to find displaced and prompt particles in one pass, without separate settings.'),
    S('They can also be retrained cheaply when the detector or the run conditions change.'),
    S('Both properties are attractive for a search programme that covers many models.'),
    S('Both, however, rest on the assumption that the training events teach the network something general about tracks.'),
  ],
  [
    S('This paper tests that assumption directly.'),
    S('We do not propose a new architecture, and we do not tune the pipeline for displaced particles.'),
    S('We take an established pipeline, keep every part of it fixed, and change only what it is trained on.'),
    S('The comparison is therefore a measurement of what the training sample contributes.'),
    S('A positive answer would mean that experiments can train one tracker on the abundant generic events they already simulate.'),
  ],
  [
    S(`Filtering the candidate edges before classification is a common way to reduce the size of the graph${cite('Filtering')}.`),
    S('We do not filter, because a filter trained on one sample could itself introduce the bias we want to measure.'),
    S('The graph is therefore larger than in pipelines optimized for speed, and the edge classifier sees every candidate edge.'),
    S('This choice makes the comparison cleaner at the cost of some time per event.'),
  ],
];

const METHOD_SIM = [
  [
    S('Events are generated with a standard parton-shower generator and passed through a fast simulation of the detector.'),
    S('The simulation propagates each charged particle through the magnetic field and the material of every layer.'),
    S('Multiple scattering and energy loss are applied layer by layer, and hits are smeared with the resolution of the sensor type.'),
    S('Noise hits are not simulated, because their rate in silicon detectors is small compared with the hits from particles.'),
    S('Secondary particles from interactions with the material are kept and treated like any other particle.'),
    S('They are a realistic source of displaced tracks in the generic sample.'),
  ],
  [
    S('The heavy neutral lepton is produced in the decay of a W boson together with a prompt muon.'),
    S('It travels a distance set by its lifetime and then decays to a second muon and a pair of quarks or leptons.'),
    S('The charged decay products therefore start at the position of the decay, which can be anywhere inside the tracker.'),
    S('We use the prompt muon of the same event as a reference that both trackers should find.'),
    S('Its efficiency is close to one for both trackers, which shows that the comparison is not affected by a gross failure of either.'),
  ],
];

const METHOD_FIT = [
  [
    S('After track building, every track is fitted with a helix to obtain its parameters.'),
    S('The fit uses only the hits on the track and does not depend on which tracker built it.'),
    S('A track whose fit fails is kept for the efficiency but marked in the resolution study.'),
    S('Fits fail mostly for tracks that combine hits of two particles, which are also the tracks that fail double majority.'),
    S('The fitted parameters enter only the resolution study in the results.'),
  ],
  [
    S('We validated every stage of the pipeline on validation events before looking at the test events.'),
    S('The graph construction was checked by counting the true edges it keeps, layer pair by layer pair.'),
    S('The edge classifier was checked by comparing its score distribution for true and false edges between training and validation events.'),
    S('The track builder was checked on graphs that contain only true edges, where it must reproduce the true particles.'),
    S('All checks passed with the same settings for both trackers.'),
    S('We then froze the pipeline, recorded its configuration and only afterwards evaluated the test events.'),
  ],
];

const RES_KIN = [
  [
    S('The efficiency also depends on the transverse momentum of the particle.'),
    ...PT_BINS.map((b, i) =>
      S(
        [
          `Between ${b.pt_lo_gev} and ${b.pt_hi_gev}~GeV, the generic-trained tracker finds ${pct(b.eff_A)} of the targets and the signal-trained one ${pct(b.eff_B)}.`,
          `From ${b.pt_lo_gev} to ${b.pt_hi_gev}~GeV, the efficiencies are ${pct(b.eff_A)} and ${pct(b.eff_B)}.`,
          `In the range from ${b.pt_lo_gev} to ${b.pt_hi_gev}~GeV, they are ${pct(b.eff_A)} and ${pct(b.eff_B)}.`,
          `Particles with transverse momenta from ${b.pt_lo_gev} to ${b.pt_hi_gev}~GeV are found with efficiencies of ${pct(b.eff_A)} and ${pct(b.eff_B)}.`,
          `For the hardest particles, from ${b.pt_lo_gev} to ${b.pt_hi_gev}~GeV, the efficiencies reach ${pct(b.eff_A)} and ${pct(b.eff_B)}.`,
        ][i],
      ),
    ),
    S('Soft particles curl more in the magnetic field, which makes their tracks harder to follow from layer to layer.'),
    S('The lead of the generic-trained tracker is largest for soft particles, which are common in generic events and rare in the signal.'),
  ],
  [
    S('The dependence on pseudorapidity is weak for both trackers.'),
    S('Both lose a little efficiency in the transition between the barrel and the endcaps, where particles cross layers at shallow angles.'),
    S('The difference between the trackers is the same in the barrel and in the endcaps within its uncertainty.'),
    S('We therefore do not show it separately.'),
  ],
];

const RES_SIGNAL = [
  [
    S('The headline comparison uses one signal point, but the conclusion should not depend on it.'),
    S('We therefore repeated the comparison for four combinations of mass and lifetime of the heavy neutral lepton.'),
    ...SIGNAL_POINTS.map((p, i) =>
      S(
        [
          `For a mass of ${p.mass_gev}~GeV and a decay length of ${p.ctau_mm}~mm, the efficiencies are ${pct(p.eff_A)} and ${pct(p.eff_B)}.`,
          `At ${p.mass_gev}~GeV and ${p.ctau_mm}~mm, which is the point the signal-trained tracker was trained on, they are ${pct(p.eff_A)} and ${pct(p.eff_B)}.`,
          `Doubling the decay length to ${p.ctau_mm}~mm at ${p.mass_gev}~GeV gives ${pct(p.eff_A)} and ${pct(p.eff_B)}.`,
          `The heaviest and longest-lived point, ${p.mass_gev}~GeV and ${p.ctau_mm}~mm, gives ${pct(p.eff_A)} and ${pct(p.eff_B)}.`,
        ][i],
      ),
    ),
    S('The signal-trained tracker comes closest on its own training point, as expected.'),
    S('Away from it, its efficiency falls faster than that of the generic-trained tracker.'),
  ],
];

const RES_LRT = [
  [
    S('A search would compare a learned tracker with the standard reconstruction, not only with another learned tracker.'),
    S(`The standard reconstruction with large-radius tracking finds ${pct(lrt.eff_lrt)} of the displaced targets at a fake-track rate of ${pct(lrt.fake_rate_lrt)}.`),
    S(`It needs ${ms(lrt.time_lrt_ms)} per event for the large-radius pass alone.`),
    S('Both learned trackers find many more displaced targets with far fewer fake tracks.'),
    S('This comparison is less controlled than the main one, because the standard reconstruction differs in every stage.'),
    S('We show it only to place the learned trackers on a familiar scale.'),
  ],
  [
    S('Many searches need both decay products of the long-lived particle, not just one of them.'),
    S(`The generic-trained tracker finds both daughters in ${pct(lrt.pair_eff_A)} of the signal events, against ${pct(lrt.pair_eff_B)} for the signal-trained tracker.`),
    S('The pair efficiency is roughly the square of the single-particle efficiency, so small gains per particle become larger gains per event.'),
    S('The daughters of one decay are often close to each other, and a tracker can merge them into one track.'),
    S('Merged pairs are rare for both trackers and slightly rarer for the generic-trained one.'),
  ],
];

const RES_FAIL = [
  [
    S('We inspected the displaced targets that one tracker finds and the other misses.'),
    S('Most targets missed only by the signal-trained tracker have a first hit in the strip layers.'),
    S('In these cases the signal-trained network assigns low scores to the edges between the first two hits.'),
    S('The generic-trained network gives the same edges high scores, because it has seen many tracks that start in the strips from material interactions.'),
    S('Targets missed only by the generic-trained tracker are fewer and show no common pattern.'),
  ],
  [
    S('Some failures are shared by both trackers.'),
    S('Particles that cross a gap between modules lose a hit and may be split into two short tracks.'),
    S('Particles that scatter strongly in the material change direction and are followed only up to the scattering point.'),
    S('Both failure modes depend on the detector and the graph, not on the training, so they cancel in the comparison.'),
    S('They set the ceiling that neither tracker can pass without a better graph.'),
  ],
];

const DISCUSSION = [
  [
    S('The result has a practical consequence for experiments.'),
    S('Signal samples for every model in a search programme are expensive to simulate, and their number grows with every new idea.'),
    S('Generic samples are simulated anyway, in large numbers, for every physics analysis.'),
    S('If a tracker trained on generic samples is at least as good on displaced signals, the expensive signal samples are needed only for the evaluation.'),
    S('This makes learned tracking easier to adopt and easier to validate.'),
  ],
  [
    S('It also simplifies the statistical treatment of a search.'),
    S('When the tracker is trained on the signal, the efficiency for a new model must be studied with care, because the tracker may favour the trained model.'),
    S('A generic-trained tracker has no such preference, so its efficiency for a new model can be estimated with the same procedure as for any other selection.'),
    S('The uncertainty of that estimate then comes from the simulation of the detector, not from the training.'),
  ],
  [
    S('We do not claim that generic training is always better.'),
    S('A tracker trained on a large and varied signal sample might match or surpass the generic-trained one.'),
    S('Our signal sample was as large as the generic one in events but much smaller in particles.'),
    S('A fair comparison at equal numbers of training particles is a natural extension of this study.'),
    S('The subset study in the appendix gives a first indication that the generic events would still win.'),
  ],
];

const APPX_GRAPH = [
  [
    S('The module map lists, for every module, the modules on the next layer that particles reached in the training events.'),
    S('A pair of hits enters the graph only if their modules are listed together.'),
    S('The map is built once from the generic training events and used for both trackers.'),
    S('Building it from signal events instead changes the graph by less than one edge in a thousand.'),
    S('The choice of events for the map therefore does not affect the comparison.'),
  ],
  [
    S('The edge features are the differences of the hit coordinates and the angle between the edge and the beam axis.'),
    S('The node features are the hit coordinates and the sensor type.'),
    S('All features are scaled to unit variance on the training events of each tracker separately.'),
    S('Using the scaling of the generic events for both trackers gives the same result within the seed spread.'),
  ],
];

const APPX_CHECKS = [
  [
    S('We repeated the comparison with a second track builder that resolves branches by the angle between consecutive edges.'),
    S('The efficiencies of both trackers change by less than their uncertainty, and the difference keeps its sign.'),
    S('We also repeated it with the edge threshold lowered and raised by a tenth.'),
    S('A lower threshold raises the efficiency and the fake-track rate of both trackers together.'),
    S('A higher threshold lowers both, and again the difference keeps its sign.'),
  ],
  [
    S('A last check concerns the test events themselves.'),
    S('We split the external test sample into halves by event number and evaluated each half separately.'),
    S('Both halves give differences within one standard deviation of the full result.'),
    S('The result is therefore not driven by a small group of unusual events.'),
  ],
];

const APPX_REPRO = [
  [
    S('Every number in this paper is produced by one script from the stored outputs of the pipeline.'),
    S('The script reads the efficiencies, rates and timings from files and writes the tables directly.'),
    S('No number was copied by hand into the text.'),
    S('The configuration of each training run, including its seed, is stored with its output.'),
    S('Rerunning the evaluation from the stored networks reproduces every number exactly.'),
  ],
];

const SUMMARY_MORE = [
  [
    S('Three findings stand out.'),
    S('The generic-trained tracker is better on displaced particles even though it saw almost none of them in training.'),
    S('Its advantage grows where the signal-trained tracker should be strongest, at large displacement.'),
    S('And it degrades more slowly when the conditions of the test events move away from those of the training.'),
  ],
];

/* ---- figures and tables ---- */
const FIGS = {
  detector: ['Layout of the simulated detector in the transverse (left) and longitudinal (right) views. Pixel layers are drawn in dark grey and strip layers in light grey.'],
  pipeline: ['The four stages of the pipeline. Graph construction and track building are the same for both trackers; only the training events of the edge classifier differ.'],
  eff_disp: ['Efficiency versus the transverse displacement of the production vertex for displaced targets. Solid: the generic-trained tracker; dashed: the signal-trained tracker. The lower panel shows their difference in points.'],
  eff_species: ['Efficiency by particle species for the two trackers. The error bars show the bootstrap uncertainty.'],
  pileup: ['Efficiency versus the average number of pile-up interactions. Neither tracker was trained with pile-up.'],
  timing: ['Time per event spent in each stage of the pipeline, on one graphics processor. The standard reconstruction is shown for comparison.'],
  fake: ['Fake-track rate versus the number of hits on the track. Most fake tracks of the signal-trained tracker are short.'],
  resolution: ['Resolution of the track parameters for matched displaced tracks. The two trackers overlap within their uncertainties.'],
  graph: ['Edge efficiency of the constructed graph per pair of adjacent layers. The graph is the same for both trackers.'],
  ablation: ['Efficiency of the generic-trained tracker for variants of the network. The dashed line shows the signal-trained tracker.'],
  seeds: ['Efficiency of the generic-trained tracker for each training seed. The band shows the mean and its spread.'],
  bootstrap: ['Distribution of the efficiency difference over the bootstrap replicas of the test events. The curve is a Gaussian with the same mean and width.'],
};
for (const k of Object.keys(FIGS)) FIGS[k] = FIGS[k].map((c) => c.split(/(?<=\.) (?=[A-Z])/).map(S).join(' '));
function figure(k, star = false) {
  const env = star ? 'figure*' : 'figure';
  const w = star ? '0.9\\textwidth' : '0.8\\linewidth';
  return [
    `\\begin{${env}}[tbp]`,
    '  \\centering',
    `  \\fbox{\\parbox[c][0.45\\linewidth][c]{${w}}{\\centering placeholder artwork: ${k.replace(/_/g, ' ')}}}`,
    `  \\caption{${FIGS[k]}}`,
    `  \\label{fig:${k}}`,
    `\\end{${env}}`,
  ].join('\n');
}
const TABCAP = {
  samples: S('Simulated samples and their splits. The external test sample is used only for the final comparison.'),
  headline: S('Efficiency, fake-track rate and duplicate rate of the two trackers on displaced targets.'),
  species: S('Efficiency by particle species, with the bootstrap uncertainty in percentage points.'),
  hyper: S('Hyperparameters of the network and of the training, shared by both trackers.'),
};
function table(k, colspec, head, rows) {
  return [
    '\\begin{table}[tbp]',
    `  \\caption{${TABCAP[k]}}`,
    `  \\label{tab:${k}}`,
    '  \\centering',
    `  \\begin{tabular}{${colspec}}`,
    '    \\hline\\hline',
    `    ${head.join(' & ')} \\\\`,
    '    \\hline',
    ...rows.map((r) => `    ${r.join(' & ')} \\\\`),
    '    \\hline\\hline',
    '  \\end{tabular}',
    '\\end{table}',
  ].join('\n');
}
const pc = (v, d = 2) => (v * 100).toFixed(d);
const TABLES = {
  samples: table('samples', 'lrrr', ['Sample', 'Training', 'Validation', 'Test'], [
    ['Top-quark pairs', thousands(T.n_train_events), thousands(T.n_val_events), thousands(T.n_test_events)],
    ['Heavy neutral lepton', thousands(T.n_train_events), thousands(T.n_val_events), thousands(T.n_test_events)],
    ['External signal', '---', '---', thousands(T.n_test_events)],
  ]),
  headline: table('headline', 'lcc', ['', 'Generic-trained', 'Signal-trained'], [
    ['Efficiency (\\%)', pc(H.eff_A), pc(H.eff_B)],
    ['Fake-track rate (\\%)', pc(H.fake_rate_A), pc(H.fake_rate_B)],
    ['Duplicate rate (\\%)', pc(H.duplicate_rate_A, 1), pc(H.duplicate_rate_B, 1)],
  ]),
  species: table('species', 'lrcc', ['Species', 'Targets', 'Generic-trained (\\%)', 'Signal-trained (\\%)'], SPECIES.map((s) => [s.label, thousands(s.n), `$${pc(s.eff_A)} \\pm ${pc(s.eff_A_sigma)}$`, `$${pc(s.eff_B)} \\pm ${pc(s.eff_B_sigma)}$`])),
  hyper: table('hyper', 'lr', ['Parameter', 'Value'], [
    ['Message-passing steps', String(T.n_message_passing)],
    ['Hidden units', String(T.hidden_dim)],
    ['Trainable parameters', thousands(T.n_parameters)],
    ['Epochs', String(T.n_epochs)],
    ['Batch size (events)', String(T.batch_size)],
    ['Learning rate', '$3\\times10^{-4}$'],
    ['Edge threshold', '0.5'],
    ['Seeds', String(T.n_seeds)],
  ]),
};

/* ------------------------------------------------------------------------------------ */
/* Layout: one sentence per line / one paragraph per line / hard-wrapped                 */
/* ------------------------------------------------------------------------------------ */

let fnIndex = 0;
/** Attach a footnote to the end of a sentence (inside its terminal punctuation, as authors do). */
function withFootnote(s) {
  const f = FOOTNOTES[fnIndex++ % FOOTNOTES.length];
  return s.replace(/([.?!])$/, `\\footnote{${f}}$1`);
}
const perLine = (paras) => paras.map((p) => p.join('\n')).join('\n\n');
const perPara = (paras) => paras.map((p) => p.join(' ')).join('\n\n');
function wrap(text, width = 100) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}
const wrapped = (paras) => paras.map((p) => wrap(p.join(' '))).join('\n\n');

const DISPLAY = {
  d0: ['\\begin{equation}', '  d_0 = \\left(\\vec{p} \\times \\hat{t}\\right)_z ,', '  \\label{eq:d0}', '\\end{equation}'].join('\n'),
  loss: ['\\begin{equation}', '  \\mathcal{L} = -\\sum_{e} w_e \\left[ y_e \\log s_e + (1 - y_e) \\log (1 - s_e) \\right] ,', '  \\label{eq:loss}', '\\end{equation}'].join('\n'),
  eff: ['\\begin{equation}', '  \\epsilon = \\frac{N_{\\text{matched}}}{N_{\\text{targets}}} ,', '  \\label{eq:eff}', '\\end{equation}'].join('\n'),
  delta: ['\\begin{align}', '  \\Delta &= \\epsilon_{\\text{generic}} - \\epsilon_{\\text{signal}} , \\label{eq:delta} \\\\', '  \\sigma_\\Delta^2 &= \\sigma_{\\text{boot}}^2 + \\sigma_{\\text{seeds}}^2 . \\label{eq:sigma}', '\\end{align}'].join('\n'),
};

function intro() {
  const paras = INTRO.map((p) => [...p]);
  paras[1][3] = withFootnote(paras[1][3]);
  paras[7][1] = withFootnote(paras[7][1]);
  return ['% Introduction (one sentence per line).', '\\section{Introduction}', '\\label{sec:intro}', '', perLine(paras), ''].join('\n');
}

function method() {
  const det = METHOD_DET.map((p) => [...p]);
  det[1][2] = withFootnote(det[1][2]);
  const g = METHOD_GRAPH.map((p) => [...p]);
  g[0][3] = withFootnote(g[0][3]);
  const tr = METHOD_TRAIN.map((p) => [...p]);
  const mt = METHOD_METRIC.map((p) => [...p]);
  mt[0][0] = withFootnote(mt[0][0]);
  const out = [
    '% Method (one paragraph per line).',
    '\\section{Detector, samples and method}',
    '\\label{sec:method}',
    '',
    '\\subsection{Detector and samples}',
    '\\label{sec:detector}',
    '',
    perPara(det.slice(0, 2)),
    '',
    figure('detector'),
    '',
    TABLES.samples,
    '',
    det[2].join(' '),
    DISPLAY.d0,
    S(`where $\\vec{p}$ is the point of closest approach to the beam axis and $\\hat{t}$ the unit direction of motion at that point.`),
    '',
    '\\subsection{Graph and network}',
    '\\label{sec:graph}',
    '',
    perPara(g.slice(0, 2)),
    '',
    figure('pipeline', true),
    '',
    g[2].join(' '),
    DISPLAY.loss,
    S('where $s_e$ is the score of edge $e$, $y_e$ is one for a true edge and zero otherwise, and the weight $w_e$ balances the rare true edges against the many false ones.'),
    '',
    '\\subsection{Training, track building and metrics}',
    '\\label{sec:metrics}',
    '',
    perPara(tr.slice(0, 2)),
    '',
    tr[2].join(' '),
    DISPLAY.eff,
    S(`where both counts use the same population of targets; ${eq('eff')} is evaluated separately for each tracker.`),
    '',
    perPara(mt.slice(0, 1)),
    '',
    mt[1].join(' '),
    DISPLAY.delta,
    S(`with the two components defined in ${app('stat')}.`),
    '',
    perPara(mt.slice(2)),
    '',
  ];
  return out.join('\n');
}

function results() {
  const r = RES.map((p) => [...p]);
  r[1][4] = withFootnote(r[1][4]);
  r[6][4] = withFootnote(r[6][4]);
  r[8][1] = withFootnote(r[8][1]);
  const blocks = ['% Results (hard-wrapped at about 100 columns).', '\\section{Results}', '\\label{sec:results}', ''];
  const place = { 0: ['table:headline'], 1: ['fake'], 2: ['eff_disp'], 4: ['eff_species', 'table:species'], 5: ['pileup'], 6: ['resolution'], 7: ['graph'], 8: ['timing'], 9: ['ablation'] };
  r.forEach((p, i) => {
    if (i === 2) blocks.push('\\subsection{Displacement, species and pile-up}', '\\label{sec:dependence}', '');
    if (i === 6) blocks.push('\\subsection{Resolution, graph and timing}', '\\label{sec:resolution}', '');
    if (i === 10) blocks.push('\\subsection{Checks and interpretation}', '\\label{sec:checks}', '');
    blocks.push(wrapped([p]), '');
    for (const f of place[i] ?? []) blocks.push(f.startsWith('table:') ? TABLES[f.slice(6)] : figure(f, f === 'eff_disp'), '');
  });
  return blocks.join('\n');
}

function appendix() {
  return [
    '% Appendix (one sentence per line).',
    '\\section{Uncertainty of the difference}',
    '\\label{app:stat}',
    '',
    perLine(APPX),
    '',
    figure('bootstrap'),
    '',
    '\\section{Seeds, hyperparameters and training statistics}',
    '\\label{app:seeds}',
    '',
    perLine(APPX_SEEDS),
    '',
    figure('seeds'),
    '',
    TABLES.hyper,
    '',
  ].join('\n');
}

function main() {
  return [
    '% SYNTHETIC SCALE FIXTURE for paper-copilot, generated by scripts/gen-large-fixture.mjs (seed ' + SEED + ').',
    '% A real-size multi-file PRD-style paper; every number comes from ../repo. Not a real analysis.',
    '\\documentclass[aps,prd,preprint,superscriptaddress,nofootinbib]{revtex4-2}',
    '\\usepackage{amsmath}',
    '\\usepackage{graphicx}',
    '\\usepackage{hyperref}',
    '',
    '\\begin{document}',
    '',
    '\\title{Tracking displaced particles with a graph neural network that never saw the signal}',
    '\\author{A. Fixture}',
    '\\affiliation{Nowhere Institute}',
    '\\author{B. Scale}',
    '\\affiliation{Elsewhere Laboratory}',
    '',
    '\\begin{abstract}',
    ABSTRACT.join('\n'),
    '\\end{abstract}',
    '',
    '\\maketitle',
    '',
    '\\input{sections/intro}',
    '\\input{sections/method}',
    '\\input{sections/results}',
    '',
    '\\section{Summary}',
    '\\label{sec:summary}',
    '',
    perLine(SUMMARY),
    '',
    '\\begin{acknowledgments}',
    S('We thank the authors of the open simulation and tracking software that this study builds on.'),
    '\\end{acknowledgments}',
    '',
    '\\appendix',
    '\\input{sections/appendix}',
    '',
    '\\bibliography{refs}',
    '',
    '\\end{document}',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------------------------ */
/* Write                                                                                 */
/* ------------------------------------------------------------------------------------ */

const files = {
  'tex/main.tex': main(),
  'tex/sections/intro.tex': intro(),
  'tex/sections/method.tex': method(),
  'tex/sections/results.tex': results(),
  'tex/sections/appendix.tex': appendix(),
  'tex/refs.bib': `% Synthetic bibliography for the paper-copilot scale fixture (generated).\n\n${BIB.map((b) => b.lines.join('\n')).join('\n\n')}\n`,
  'README.md': [
    '# fixtures/large-multifile',
    '',
    'A real-size, multi-file PRD-style paper (`tex/`) and the synthetic analysis repository whose numbers it',
    'states (`repo/`), for the scale and performance tests (`packages/core/test/scale*.test.ts`,',
    '`apps/server/test/scale*.test.ts`, `e2e/perf.mjs`).',
    '',
    `Generated by \`node scripts/gen-large-fixture.mjs\` (seed ${SEED}); do not edit by hand, change the script and`,
    're-run it (`--check` verifies the committed files are up to date). Synthetic: not a real analysis.',
    '',
    `- ${seen.size} distinct sentences (prose, captions and footnotes), 12 figures, 4 tables, ${BIB.length} references`,
    '- `tex/main.tex` inputs `sections/intro.tex`, `method.tex`, `results.tex` and `appendix.tex`',
    '- every prose numeral that is not structural matches a fact of `repo/results/*` or `repo/docs/definitions.md`',
    '',
  ].join('\n'),
};
for (const [k, v] of Object.entries(REPO)) files[`repo/${k}`] = v;

// every bib entry is cited, every figure and table referenced
const allTex = Object.entries(files).filter(([k]) => k.endsWith('.tex')).map(([, v]) => v).join('\n');
for (const b of BIB) if (!allTex.includes(b.key)) throw new Error(`bib key never cited: ${b.key}`);
for (const k of Object.keys(FIGS)) if (!allTex.includes(`\\ref{fig:${k}}`)) throw new Error(`figure never referenced: ${k}`);
for (const k of Object.keys(TABLES)) if (!allTex.includes(`\\ref{tab:${k}}`)) throw new Error(`table never referenced: ${k}`);

if (CHECK) {
  const stale = Object.entries(files).filter(([rel, text]) => !existsSync(join(OUT, rel)) || readFileSync(join(OUT, rel), 'utf8') !== text);
  if (stale.length) {
    console.error(`stale fixture files (re-run node scripts/gen-large-fixture.mjs): ${stale.map(([r]) => r).join(', ')}`);
    process.exit(1);
  }
  console.log(`fixtures up to date (${Object.keys(files).length} files)`);
} else {
  rmSync(OUT, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = join(OUT, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  console.log(`wrote ${Object.keys(files).length} files to ${OUT} (${seen.size} sentences, seed ${SEED})`);
}
