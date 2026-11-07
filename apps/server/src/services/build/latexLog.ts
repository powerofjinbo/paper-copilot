/**
 * LaTeX log parsing. The compile runs with `-file-line-error` and `max_print_line=10000`, so errors
 * arrive as unwrapped `<file>:<line>: <message>` lines; `! <message>` lines (errors raised with no
 * file context, e.g. "Emergency stop") are kept too. File names are mapped back from the shadow tree
 * to texRoot-relative paths by the caller-supplied `mapFile`.
 */
import type { CompileError } from '@paper-copilot/core';

const FILE_LINE = /^(.+?\.[A-Za-z0-9]{1,12}):(\d+): (.+)$/;
const BANG = /^! (.+)$/;
const CONTEXT = /^l\.(\d+) (.*)$/;

export interface ParseLogOptions {
  /** Map a path as written in the log to a texRoot-relative path (or keep it). */
  mapFile: (raw: string) => string;
  /** File used for errors without a location. */
  mainFile: string;
  max?: number;
}

/** The undefined command at the end of an `l.<n> ...` context line, if any. */
function trailingCommand(ctx: string): string | null {
  const m = /(\\[A-Za-z@]+\*?|\\.)\s*$/.exec(ctx);
  return m ? m[1]! : null;
}

export function parseLatexLog(log: string, opts: ParseLogOptions): CompileError[] {
  const lines = log.split(/\r?\n/);
  const out: CompileError[] = [];
  const seen = new Set<string>();
  const max = opts.max ?? 50;
  const push = (e: CompileError) => {
    const key = `${e.file}:${e.line}:${e.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i]!;
    const fl = FILE_LINE.exec(line);
    let file: string | null = null;
    let lineNo: number | null = null;
    let msg: string | null = null;
    if (fl && !line.startsWith('l.')) {
      file = opts.mapFile(fl[1]!);
      lineNo = Number(fl[2]);
      msg = fl[3]!.trim();
    } else {
      const b = BANG.exec(line);
      if (b) {
        // "! ==> Fatal error occurred" duplicates the error before it; keep it only if nothing else was found.
        msg = b[1]!.trim();
        file = opts.mainFile;
      }
    }
    if (msg === null || file === null) continue;
    // Look ahead for TeX's context line "l.<n> <text up to the error>".
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const next = lines[j]!;
      if (BANG.test(next) || (FILE_LINE.test(next) && !next.startsWith('l.'))) break; // the next error
      const c = CONTEXT.exec(next);
      if (!c) continue;
      if (lineNo === null) lineNo = Number(c[1]);
      if (/^Undefined control sequence/.test(msg)) {
        const cmd = trailingCommand(c[2]!);
        if (cmd) msg = `Undefined control sequence ${cmd}`;
      }
      break;
    }
    if (/^==> Fatal error occurred/.test(msg) && out.length > 0) continue;
    push({ file, line: Number.isFinite(lineNo) ? lineNo : null, message: msg.length > 500 ? msg.slice(0, 500) + '…' : msg });
  }
  return out;
}

/** The last `n` bytes (UTF-8) of a text, cut at a line start when possible. */
export function tailBytes(text: string, n = 4096): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= n) return text;
  let s = buf.subarray(buf.length - n).toString('utf8');
  s = s.replace(/^�+/, '');
  const nl = s.indexOf('\n');
  return nl >= 0 && nl < 200 ? s.slice(nl + 1) : s;
}

/**
 * A missing class or package ("LaTeX Error: File `textcase.sty' not found.") gets an install hint, so
 * the author is told what to run instead of decoding the TeX log. The TeX package usually has the
 * file's name; a few well-known files live in a differently named package. `tinytex` is true when the
 * log shows a TinyTeX tree, a minimal distribution that misses many publisher classes.
 */
const PACKAGE_OF_FILE: Record<string, string> = {
  'revtex4-2.cls': 'revtex',
  'revtex4-1.cls': 'revtex4-1',
  'JHEP.cls': 'jhep',
  'elsarticle.cls': 'elsarticle',
  'graphicx.sty': 'graphics',
  'amsmath.sty': 'amsmath',
  'amssymb.sty': 'amsfonts',
  'siunitx.sty': 'siunitx',
  'hyperref.sty': 'hyperref',
  'natbib.sty': 'natbib',
};

export function missingFileHint(message: string, log: string): string | null {
  const m = /File [`'"]([^'"`]+\.(?:sty|cls|bst|tex))' not found/.exec(message);
  if (!m) return null;
  const file = m[1]!;
  const pkg = PACKAGE_OF_FILE[file] ?? file.replace(/\.(sty|cls|bst|tex)$/, '');
  const tinytex = /TinyTeX/i.test(log);
  const base = `Install the missing TeX package: tlmgr install ${pkg}${tinytex ? '' : ' (with sudo for MacTeX / TeX Live)'}`;
  return tinytex
    ? `${base}. You are compiling with TinyTeX, a minimal distribution; for a paper, a full MacTeX / TeX Live avoids missing packages (put /Library/TeX/texbin first on PATH).`
    : `${base}.`;
}
