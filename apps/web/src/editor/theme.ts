/** Editor theme and LaTeX highlighting; all colours come from the design tokens (light and dark). */
import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/** LaTeX syntax (commands, arguments, braces, math) stays monospace; prose uses the text font. */
const code = { fontFamily: 'var(--font-mono)', fontSize: 'var(--pc-code-size)' };

export const texHighlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--pc-tok-cmd)', ...code },
  { tag: t.atom, color: 'var(--pc-tok-arg)', ...code },
  { tag: [t.string, t.standard(t.variableName)], color: 'var(--pc-tok-arg)', ...code },
  { tag: t.keyword, color: 'var(--pc-tok-math)', ...code },
  { tag: t.special(t.variableName), color: 'var(--pc-tok-math)', fontStyle: 'italic' },
  { tag: t.number, color: 'var(--pc-tok-math)' },
  { tag: t.bracket, color: 'var(--pc-tok-bracket)', ...code },
  { tag: t.comment, color: 'var(--pc-tok-comment)', fontStyle: 'italic' },
]);

export const paperTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg)',
    color: 'var(--ink)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--pc-editor-font)',
    lineHeight: '1.72',
    justifyContent: 'safe center',
  },
  '.cm-content': {
    fontSize: 'var(--pc-editor-size)',
    maxWidth: '90ch',
    flexGrow: '0',
    flexShrink: '1',
    flexBasis: '90ch',
    padding: '28px 24px 45vh 6px',
    caretColor: 'var(--ink)',
  },
  '.cm-line': { padding: '0 2px 0 6px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)', borderLeftWidth: '1.5px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--pc-selection)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--pc-active-line)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--ink-3)',
    border: 'none',
    fontFamily: 'var(--font-ui)',
  },
  '.cm-lineNumbers .cm-gutterElement': { fontSize: '11px', padding: '0 6px 0 10px', minWidth: '28px', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-2)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--pc-bracket-match)', outline: 'none' },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: 'var(--lint-warn)' },
  '.cm-tooltip': { border: 'none', backgroundColor: 'transparent' },
  '.cm-panels': { backgroundColor: 'var(--bg-elev)', color: 'var(--ink)', fontFamily: 'var(--font-ui)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--pc-search)', outline: '1px solid var(--pc-search-outline)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--pc-search-selected)' },
  '.cm-placeholder': { color: 'var(--ink-3)', fontStyle: 'italic' },
});
