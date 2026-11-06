/**
 * Data for the editor harness: facts from the fixture's claim file, an outline over the segmented
 * fixture, lint flags, canned AI outputs, and the demo provenance states. Nothing here is real model
 * output; it only exercises the editor.
 */
import type { Fact, LintFlag, Outline, OutlineSection, Segmentation, SentenceState } from '@paper-copilot/core';
import claim from '../../../../fixtures/canto-demo/repo/results/addendum_g_g1_v1_claim.json';

const ARTIFACT = 'results/addendum_g_g1_v1_claim.json';
const SHA = '9f2c4e1b7a0d6e3f5c8b2a1d4e7f0a3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f';
const DEF = 'Canto-L (ttbar) vs acorn (HNL)+LM, population P_G, generic_iso union test, n=8710';

function fact(id: string, value: number, unit: string, definition: string, locator: string, extra: Partial<Fact> = {}): Fact {
  return {
    id,
    kind: 'number',
    value,
    sigfigs: null,
    unit,
    uncertainties: {},
    definition,
    definitionSource: 'metadata: A, B, population, split, n_targets',
    artifact: ARTIFACT,
    locator,
    artifactSha256: SHA,
    fingerprint: `${SHA.slice(0, 12)}${locator}`,
    stale: false,
    validationState: 'candidate',
    aliases: [],
    confirmed: true,
    excluded: false,
    proseOnly: false,
    tags: ['G1'],
    ...extra,
  };
}

const c = claim as Record<string, number | string | boolean | number[]>;

export const FIXTURE_FACTS: Fact[] = [
  fact('f.g1.eff_A', c.eff_A as number, '', `Efficiency of Canto-L (ttbar), ${DEF}`, '#/eff_A', { aliases: ['96.94%', '96.9%', '0.969'] }),
  fact('f.g1.eff_B', c.eff_B as number, '', `Efficiency of acorn (HNL)+LM, ${DEF}`, '#/eff_B', { aliases: ['94.62%', '94.6%', '0.946'] }),
  fact('f.g1.delta_points', c.delta_points as number, 'points', `Efficiency difference, Canto-L (ttbar) minus acorn (HNL)+LM, ${DEF}`, '#/delta_points', {
    sigfigs: 3,
    uncertainties: { total: c.sigma_points as number, boot: c.sigma_boot_points as number, seeds: c.sigma_seeds_points as number },
    aliases: ['2.32 points', '2.3 points'],
  }),
  fact('f.g1.n_targets', c.n_targets as number, '', 'Number of target particles in P_G, generic_iso union test', '#/n_targets', { aliases: ['8,710', '8710'] }),
  fact('f.g1.fake_rate_A', c.fake_rate_A as number, '', 'Track fake rate of Canto-L (ttbar), tracks with >= 5 hits', '#/fake_rate_A', { aliases: ['0.55%'] }),
  fact('f.g1.fake_rate_B', c.fake_rate_B as number, '', 'Track fake rate of acorn (HNL)+LM, tracks with >= 5 hits', '#/fake_rate_B', { aliases: ['1.38%'] }),
  fact('f.def.pt_min', 1, 'GeV', 'Target particle: pT > 1 GeV (table value)', 'md:line=61', { kind: 'cut', artifact: 'docs/definitions.md', tags: ['definition'] }),
  fact('f.def.eta_max', 4, '', 'Target particle: |eta| < 4 (table value)', 'md:line=61', { kind: 'cut', artifact: 'docs/definitions.md', tags: ['definition'] }),
  fact('f.def.min_space_points', 5, '', 'Target particle: at least 5 space points', 'md:line=61', { kind: 'cut', artifact: 'docs/definitions.md', tags: ['definition'] }),
];

/** Lines inserted into the fixture so the harness shows an intent line and a placeholder sentence. */
export const INTENT_NOTE = '这里补一句：双重多数比单一多数更严格，因为共享的击中点不能让两条径迹同时匹配同一个粒子。';
export const PLACEHOLDER_SENTENCE = 'At large radius the gain is [fact?: efficiency gain for particles with $r > 300$~mm].';
/** A whole-sentence placeholder, as a rejected sentence leaves it (core gives it state 'placeholder'). */
export const CLAIM_PLACEHOLDER = '[claim: The lead also holds for particles with $r > 300$~mm?]';

export function prepareFixtureText(raw: string, repeat = 1): string {
  if (repeat > 1) {
    // a long paper for performance checks: the body repeated (labels made unique)
    const begin = raw.indexOf('\\section{Introduction}');
    const end = raw.indexOf('\\bibliography{');
    const body = raw.slice(begin, end);
    const copies = Array.from({ length: repeat - 1 }, (_, i) => body.replace(/\\label\{([^}]*)\}/g, (_m, l: string) => `\\label{${l}-${i + 2}}`));
    raw = raw.slice(0, end) + copies.join('') + raw.slice(end);
  }
  const lines = raw.split('\n');
  const out: string[] = [];
  for (const l of lines) {
    out.push(l);
    if (l.startsWith('A reconstructed track matches a particle')) out.push(INTENT_NOTE);
    if (l.startsWith('This lead holds for every particle species.')) out.push(PLACEHOLDER_SENTENCE, CLAIM_PLACEHOLDER);
  }
  return out.join('\n');
}

export interface DemoState {
  prefix: string;
  state: SentenceState;
  model?: string;
  editDistance?: number;
  intentNote?: string;
  move?: string;
}

/** Provenance states given to some fixture sentences, so every gutter colour shows up. */
export const DEMO_STATES: DemoState[] = [
  { prefix: 'We study a tracker trained only on', state: 'ai-drafted', model: 'claude-opus-5-5', move: 'enabler' },
  { prefix: 'On isolated displaced particles that neither model', state: 'ai-edited', model: 'claude-opus-5-5', editDistance: 0.42, move: 'headline' },
  { prefix: 'Machine-learning pipelines such as', state: 'external', move: 'context' },
  {
    prefix: 'In this paper, we train on generic events',
    state: 'ai-from-intent',
    model: 'claude-sonnet-5-5',
    intentNote: '说明我们只用通用事件训练，并在设计冻结之后生成的粒子上测试。',
    move: 'contribution',
  },
  { prefix: 'On the isolated gun particles, the tracker finds', state: 'ai-drafted', model: 'claude-opus-5-5', move: 'result' },
  { prefix: 'The test set holds', state: 'proposed', model: 'claude-opus-5-5', move: 'sample' },
  { prefix: 'The fake-track rate is', state: 'proposed', model: 'claude-opus-5-5', move: 'result' },
  { prefix: 'This lead holds for every particle species.', state: 'unsupported', model: 'claude-opus-5-5', move: 'claim' },
];

const JOBS: Record<string, string> = {
  abstract: 'State the problem, the gap, and the headline number with its baseline.',
  'sec:intro': 'Motivate signal-free training: earlier ML trackers were trained on the signal they evaluate.',
  'sec:method': 'Define the targets, the matching and the efficiency, so every later number is unambiguous.',
  'sec:results': 'Show the efficiency gain on isolated gun particles with its uncertainty and the fake rate.',
  'sec:concl': 'Restate the claim with its condition, then the main limitation.',
  'app:val': 'Report the validation-set comparison.',
};

const GHOST: Record<string, OutlineSection['ghostMode']> = {
  abstract: 'complete-my-sentence',
  'sec:intro': 'complete-my-sentence',
  'sec:method': 'auto-propose',
  'sec:results': 'auto-propose',
  'sec:concl': 'complete-my-sentence',
  'app:val': 'auto-propose',
};

export function buildOutline(seg: Segmentation): Outline {
  const sections: OutlineSection[] = [];
  for (const s of seg.sections) {
    const paragraphs = seg.paragraphs
      .filter((p) => p.sectionId === s.id && p.kind === 'prose')
      .map((p, i) => ({
        pid: `${s.id}/p${p.index}`,
        job: i === 0 ? (JOBS[s.id] ?? 'Say what this paragraph is for.') : 'Continue the argument of the section.',
        moves: [],
        claimIds: s.id === 'sec:results' ? ['G1'] : [],
        intentNotes: [],
        plan: {
          job: JOBS[s.id] ?? '',
          claimIds: [],
          said: {},
          remaining:
            s.id === 'sec:results'
              ? [{ id: 'r-next', intent: 'Say whether the gain holds per particle species, with the number.', factIds: ['f.g1.delta_points'], citeKeys: [], move: 'result' }]
              : [],
        },
        provenance: 'author' as const,
      }));
    sections.push({
      id: s.id,
      title: s.title,
      question: '',
      template: s.part === 'abstract' ? 'abstract' : s.part === 'intro' ? 'introduction' : s.part === 'concl' ? 'conclusions' : 'section',
      ghostMode: GHOST[s.id] ?? 'auto-propose',
      paragraphs,
      provenance: 'author',
    });
  }
  return {
    story: { text: 'A tracker trained without the signal finds more displaced particles than one trained on it.', keyPhrase: 'trained without the signal', provenance: 'author' },
    gap: { text: 'ML trackers for displaced tracks were trained on the signal they evaluate.', provenance: 'author' },
    enabler: { text: 'Train on generic ttbar events only.', provenance: 'author' },
    contrast: { text: 'Signal-free training instead of signal training.', provenance: 'author' },
    ladder: [],
    claimFigures: [{ claimId: 'G1', figureId: 'fig:eff' }],
    headline: { factId: 'f.g1.delta_points', baselineFactId: 'f.g1.eff_B', condition: 'isolated gun particles, same track builder', text: '', provenance: 'author' },
    framings: [],
    sections,
    authorFilled: true,
  };
}

export interface LintSeed {
  prefix: string;
  flag: Omit<LintFlag, 'id' | 'sentenceId' | 'line' | 'excerpt' | 'dismissed'>;
}

export const LINT_SEEDS: LintSeed[] = [
  {
    prefix: 'Machine-learning pipelines such as',
    flag: { check: 'passive', source: 'style_check', msg: 'Passive voice: say who studied it', word: 'was studied', corpusRate: 4.1, userRate: 7.9, severity: 'hint' },
  },
  {
    prefix: 'The principal limitation is',
    flag: { check: 'vocab', source: 'aiese', msg: 'Excess-vocabulary word (Kobak ratio 3.4)', word: 'principal', corpusRate: 0.3, userRate: 1.2, severity: 'warn' },
  },
  {
    prefix: 'A reconstructed track matches a particle',
    flag: { check: 'long', source: 'style_check', msg: '38 words; the corpus median is 22', word: null, corpusRate: 11.0, userRate: 18.5, severity: 'hint' },
  },
];

/* ------------------------------------------------------------------------------------ */
/* Canned AI outputs                                                                     */
/* ------------------------------------------------------------------------------------ */

export const GHOST_MODEL = 'claude-haiku-5-5';
export const ACTION_MODEL = 'claude-sonnet-5-5';

/** A grounded continuation for a prefix (uses only fixture facts). */
export function ghostContinuation(prefix: string): { text: string; factIds: string[] } | null {
  const p = prefix.trimEnd();
  if (/xyz/i.test(p)) return null;
  if (p === '') return { text: 'The gain is 2.32~$\\pm$~0.28 points on all 8,710 targets.', factIds: ['f.g1.delta_points', 'f.g1.n_targets'] };
  if (/finds$/.test(p)) return { text: ' 2.32 points more targets than acorn (HNL).', factIds: ['f.g1.delta_points'] };
  if (/\bgain\b/i.test(p)) return { text: ' is 2.32 points, measured on 8,710 targets.', factIds: ['f.g1.delta_points', 'f.g1.n_targets'] };
  return { text: ' on the 8,710 targets of the isolated test set.', factIds: ['f.g1.n_targets'] };
}

export function cannedRewrite(text: string, instruction: string): { text: string; notes: string; drift: { actor: boolean; scope: boolean; direction: boolean; condition: boolean } } {
  if (text.startsWith('On the isolated gun particles, the tracker finds')) {
    return {
      text: 'With the same track builder, the tracker finds 2.32~$\\pm$~0.28 points more targets than acorn (HNL) on the isolated gun particles; see Fig.~\\ref{fig:eff}.',
      notes: '把比较条件（同一个径迹构建器）放到句首，基线 acorn (HNL) 紧跟在数字后面；数字、\\ref 与数学都没有改动。',
      drift: { actor: false, scope: false, direction: false, condition: false },
    };
  }
  if (text.startsWith('On isolated displaced particles that neither model')) {
    return {
      text: 'Compared with 94.62\\% for the signal-trained baseline, it finds 96.94\\% of the isolated displaced particles that neither model saw in training, at a fake-track rate of 0.55\\% against 1.38\\%.',
      notes: '按你的要求把基线放到前面；“在训练中都没见过”的条件保留。',
      drift: { actor: false, scope: false, direction: false, condition: false },
    };
  }
  const m = /^(.*?),\s+(.*?)([.?!])$/.exec(text);
  if (m && m[1] && m[2]) {
    const rest = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    const first = m[1].charAt(0).toLowerCase() + m[1].slice(1);
    return { text: `${rest}, ${first}${m[3]}`, notes: `按“${instruction}”调整了语序（模拟结果）。`, drift: { actor: false, scope: true, direction: false, condition: false } };
  }
  return { text, notes: '这句话已经很直接，没有改动（模拟结果）。', drift: { actor: false, scope: false, direction: false, condition: false } };
}

export function cannedGrammar(text: string): { text: string; notes: string } {
  if (text.includes(' against ')) return { text: text.replace(' against ', ' versus '), notes: '只改了一个介词：against → versus。' };
  if (text.includes('i.e., double majority')) return { text: text.replace('i.e., double majority', 'that is, by double majority'), notes: '补全了短语。' };
  return { text, notes: '没有发现语法问题。' };
}

export function cannedAlternatives(text: string): string[] {
  const out: string[] = [];
  out.push(text.replace(/^(\w+)/, (w) => (w === 'The' ? 'This' : w)).replace(/the tracker/, 'our tracker'));
  out.push(cannedRewrite(text, 'verb first').text);
  out.push(text.replace(/; see Fig\.~\\ref\{fig:eff\}\./, ' (Fig.~\\ref{fig:eff}).').replace(/^On /, 'For '));
  const seen = new Set<string>();
  return out.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
}

export function cannedIntent(note: string, n: number): string[] {
  const base = [
    'Double majority is stricter than a single majority: a hit shared by two tracks cannot make both of them match the same particle.',
    'Requiring a majority on both sides is stricter than a single majority, because one shared hit can no longer let two tracks match one particle.',
    'Double majority is the stricter criterion: a hit shared between two tracks cannot let both match the same particle.',
  ];
  if (!note.includes('双重多数')) {
    const generic = ['We train only on generic events and test on particles generated after the design freeze.', 'Training uses generic events only; the test particles were generated after the design freeze.', 'Only generic events enter the training, and the test set was generated after the design freeze.'];
    return generic.slice(0, n);
  }
  return base.slice(0, n);
}
