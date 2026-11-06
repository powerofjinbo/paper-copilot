/**
 * Flatten \input / \include for the whole-document lint pass, keeping a line map back to the real
 * files.
 *
 * - Paths resolve relative to texRoot (TeX's working directory), with ".tex" appended when the name has
 *   no extension, exactly as pdflatex does; a path that leaves texRoot is not followed.
 * - Commands inside comments are ignored; `\input x` without braces is accepted (TeX primitive form).
 * - Depth-limited (default 8) and cycle-safe (a file already on the include stack is not re-entered).
 * - Each file's text is passed through `transform` (the intent-line shadow) before it is scanned.
 * - The text before the command stays on its line; the included file's lines follow; the rest of the
 *   line continues on a new line. `lines[i]` gives the real (file, line) of flattened line i + 1.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { safeJoin } from '../../infra';

export interface FlatLine {
  file: string;
  line: number;
}

export interface FlattenResult {
  text: string;
  lines: FlatLine[];
  /** Files included, in first-inclusion order (root first). */
  files: string[];
  /** Includes that could not be followed, with the reason. */
  skipped: Array<{ from: string; line: number; target: string; reason: string }>;
}

export interface FlattenOptions {
  texRoot: string;
  /** Read a texRoot-relative file (e.g. the editor mirror first, then disk). Null = missing. */
  read?: (rel: string) => string | null;
  transform?: (text: string, rel: string) => string;
  maxDepth?: number;
}

/** First unescaped % of a line (comment start), or the line length. */
function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '%') return i;
  }
  return line.length;
}

const INCLUDE_SRC = /\\(input|include)(?![A-Za-z@])\s*(?:\{([^{}]*)\}|([^\s{}%\\]+))/g;

function diskRead(texRoot: string, rel: string): string | null {
  try {
    const abs = safeJoin(texRoot, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Resolve an \input target to a texRoot-relative file that exists, or a reason it cannot be followed. */
function resolveTarget(texRoot: string, target: string, read: (rel: string) => string | null): { rel: string } | { reason: string } {
  const t = target.trim().replace(/^"(.*)"$/, '$1');
  if (!t) return { reason: 'empty name' };
  const names = /\.[A-Za-z0-9]{1,8}$/.test(t) ? [t] : [`${t}.tex`, t];
  for (const name of names) {
    let abs: string;
    try {
      abs = safeJoin(texRoot, name);
    } catch {
      return { reason: 'outside the LaTeX tree' };
    }
    const rel = relative(texRoot, abs).split(sep).join('/');
    if (read(rel) !== null) return { rel };
  }
  return { reason: 'file not found' };
}

export function flattenTex(rootRel: string, opts: FlattenOptions): FlattenResult {
  const maxDepth = opts.maxDepth ?? 8;
  const read = opts.read ?? ((rel: string) => diskRead(opts.texRoot, rel));
  const outLines: string[] = [];
  const map: FlatLine[] = [];
  const files: string[] = [];
  const skipped: FlattenResult['skipped'] = [];
  const stack: string[] = [];

  const emit = (text: string, file: string, line: number) => {
    outLines.push(text);
    map.push({ file, line });
  };

  const visit = (rel: string, depth: number) => {
    const raw = read(rel);
    if (raw === null) return;
    if (!files.includes(rel)) files.push(rel);
    stack.push(rel);
    const text = opts.transform ? opts.transform(raw, rel) : raw;
    const lines = text.split('\n');
    // "a\nb\n" is two lines for TeX; a trailing empty element would add a paragraph break after an include.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      let line = lines[i]!;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const cs = commentStart(line);
      const code = line.slice(0, cs);
      // A fresh regex per line: visit() recurses inside this loop, so a shared /g regex would be reset.
      const includeRe = new RegExp(INCLUDE_SRC.source, 'g');
      let m: RegExpExecArray | null;
      let cursor = 0;
      let pending = '';
      let expanded = false;
      while ((m = includeRe.exec(code)) !== null) {
        // Skip \input preceded by an odd number of backslashes (\\input is a line break + "input").
        let bs = 0;
        for (let k = m.index - 1; k >= 0 && code[k] === '\\'; k--) bs++;
        if (bs % 2 === 1) continue;
        const target = (m[2] ?? m[3] ?? '').trim();
        const res = resolveTarget(opts.texRoot, target, read);
        let reason: string | null = null;
        if ('reason' in res) reason = res.reason;
        else if (stack.includes(res.rel)) reason = 'include cycle';
        else if (depth + 1 > maxDepth) reason = `nesting deeper than ${maxDepth}`;
        if (reason !== null || !('rel' in res)) {
          skipped.push({ from: rel, line: lineNo, target, reason: reason ?? 'unresolved' });
          continue;
        }
        pending += code.slice(cursor, m.index);
        if (pending.trim()) emit(pending, rel, lineNo);
        pending = '';
        visit(res.rel, depth + 1);
        cursor = m.index + m[0].length;
        expanded = true;
      }
      if (!expanded) {
        emit(line, rel, lineNo);
      } else {
        const rest = code.slice(cursor);
        // An empty remainder is dropped: emitting it would turn "\input{a}\nText" into a paragraph break.
        if (rest.trim()) emit(rest, rel, lineNo);
      }
    }
    stack.pop();
  };

  visit(rootRel, 0);
  return { text: outLines.join('\n'), lines: map, files, skipped };
}
