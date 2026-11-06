/**
 * UX review (daily use by a non-native Chinese/English author). Static checks that back the
 * Playwright flows in harness/review-ux.mjs: discoverability of the ghost key, localisation of the
 * editor's feedback notes, and the contrast of ghost text in both themes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../../src/i18n';

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../../src/${p}`, import.meta.url)), 'utf8');

describe('discoverability', () => {
  it('names the ghost-suggestion key (Ctrl+Space or its Alt+/ fallback) somewhere in the UI, in both languages', () => {
    // Ctrl+Space is the macOS "previous input source" shortcut and the Windows Chinese-IME toggle, so the
    // OS eats it for exactly this user; Alt+/ works but is mentioned nowhere. Neither appears in any UI string.
    const editorStrings = src('editor/i18n.ts');
    for (const lang of ['en', 'zh'] as const) {
      const all = Object.values(MESSAGES[lang]).join('\n');
      const mentions = /Ctrl\+Space|Alt\+\/|⌥\//.test(all) || (lang === 'en' && /Ctrl\+Space|Alt\+\//.test(editorStrings));
      expect(mentions, `${lang} UI never names the ghost key`).toBe(true);
    }
  });
});

describe('editor feedback notes follow the UI language', () => {
  it('ghost / review notes are not hard-coded English literals', () => {
    // ghostNoteEffect.of({ ..., text: 'nothing left to review' }) is rendered verbatim, so a 中文 UI shows English
    const files = ['editor/keymap.ts', 'editor/controller.ts', 'editor/ghost/ghostPlugin.ts'];
    const literals = files.flatMap((f) => [...src(f).matchAll(/ghostNoteEffect\.of\(\{[^}]*?text:\s*(['`])([^'`]*)\1/g)].map((m) => `${f}: "${m[2]}"`));
    expect(literals).toEqual([]);
  });
});

/* ------------------------------------------------------------------ contrast from the design tokens */

type RGBA = { r: number; g: number; b: number; a: number };
function parseColor(v: string): RGBA {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = v.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (!m) throw new Error(`cannot parse colour ${v}`);
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}
function lum({ r, g, b }: RGBA): number {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(fg: RGBA, bg: RGBA): number {
  const mix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
  const [hi, lo] = [lum(mix), lum(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

describe('ghost text contrast', () => {
  const css = src('styles/tokens.css');
  const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media')));
  const darkStart = css.indexOf(":root[data-theme='dark'] {");
  const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf('}', darkStart))) };

  for (const [name, t] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`${name}: the gray ghost sentence the author must read and judge stays >= 3:1 against the editor background`, () => {
      const ratio = contrast(parseColor(t['--ghost-ink']), parseColor(t['--bg']));
      expect(Math.round(ratio * 100) / 100).toBeGreaterThanOrEqual(3);
    });
    it(`${name}: proposed (not yet reviewed) sentences stay near AA (>= 4.3:1)`, () => {
      const ratio = contrast(parseColor(t['--proposed-ink']), parseColor(t['--bg']));
      expect(Math.round(ratio * 100) / 100).toBeGreaterThanOrEqual(4.3);
    });
  }
});

/* ------------------------------------------------------------------ regression tests for the fixes */

describe('fixes: keys named for the platform (UX-5) and never swallowed silently (UX-1, UX-8)', () => {
  it('UI strings name Mod bindings with {mod} (⌘ on macOS), never a hard-coded "Ctrl+Enter / Ctrl+S / Ctrl+Shift+J / Ctrl+."', async () => {
    const { translate } = await import('../../src/i18n');
    for (const lang of ['en', 'zh'] as const) {
      const bad = Object.entries(MESSAGES[lang]).filter(([, v]) => /Ctrl\+(Enter|S\b|Shift\+J|\.)/.test(v));
      expect(bad, `${lang}: hard-coded Ctrl`).toEqual([]);
      expect(translate(lang, 'review.keys')).not.toMatch(/\{mod\}|\{alt\}/);
      expect(translate(lang, 'review.keys')).toMatch(/(Ctrl|⌘)\+Enter/);
    }
  });

  it('Mod-Enter is always consumed (never falls through to insertBlankLine, a LaTeX paragraph break)', () => {
    const km = src('editor/keymap.ts');
    const body = km.slice(km.indexOf('const modEnter: Command'), km.indexOf('const altEnter: Command'));
    expect(body).not.toMatch(/return false/);
    expect(body).toMatch(/alreadyAccepted/);
  });

  it('Alt+Up/Down fall through to "move line" when there is nothing to review (no preventDefault, the result is returned)', () => {
    const km = src('editor/keymap.ts');
    expect(km).not.toMatch(/Alt-Arrow(Down|Up)', run: review\(-?1\), preventDefault: true/);
    expect(km).toMatch(/env\(view\)\?\.ops\.reviewStep\(view, dir\) \?\? false/);
  });

  it('the ghost key has bindings that survive macOS / Chinese IMEs, and the help overlay names it in both languages', async () => {
    const km = src('editor/keymap.ts');
    for (const key of ["'Ctrl-Space'", "'Ctrl-Shift-Space'", "'Alt-/'"]) expect(km).toContain(`key: ${key}, run: requestGhost`);
    const { translate } = await import('../../src/i18n');
    for (const lang of ['en', 'zh'] as const) expect(translate(lang, 'help.ghostNote')).toMatch(/Alt\+\/|⌥\//);
  });
});

describe('fixes: anti-anchoring for drafting (UX-3)', () => {
  it('both Draft buttons are disabled until outline.authorFilled', () => {
    const panel = src('panels/OutlinePanel.tsx');
    const row = panel.slice(panel.indexOf('<div className="draft-row">'), panel.indexOf('</div>', panel.indexOf('<div className="draft-row">')));
    const disabled = [...row.matchAll(/disabled=\{([^}]*)\}/g)].map((m) => m[1]);
    expect(disabled).toHaveLength(2);
    for (const d of disabled) expect(d).toMatch(/locked/);
    expect(panel).toMatch(/const locked = !authorFilled/);
  });
});
