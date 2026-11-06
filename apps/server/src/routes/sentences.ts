/**
 * Sentence review routes (the AI actions instruct/alternatives/grammar live in routes/llm.ts):
 *   GET  /api/sentences/:id/history   HistoryResponse { unit, versions } (also for removed/orphaned units)
 *   POST /api/sentences/:id/accept    proposed|unsupported -> ai-drafted, acceptedAt; returns the unit.
 *                                     No text changes, so no version row: the decision is logged in
 *                                     history.jsonl as an `accept` event. Accepting an already accepted
 *                                     sentence returns it unchanged.
 *   POST /api/sentences/:id/reject    RejectResponse { replacement: "[claim: <plain text>?]" }; the client
 *                                     applies it as an annotated change (state placeholder), so no claim
 *                                     is silently lost. Logged as a `reject` event.
 */
import type { FastifyInstance } from 'fastify';
import { ROUTES, findPlaceholders, type HistoryResponse, type SentenceState } from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx } from '../contracts';
import type { DocServiceExt } from '../docs/docService';
import { stripComment } from '../services/sync/scan';
import { parseWith } from './project';

const Params = z.object({ id: z.string().min(1).max(100) });

const ACCEPTABLE: ReadonlySet<SentenceState> = new Set(['proposed', 'unsupported']);
const ALREADY_ACCEPTED: ReadonlySet<SentenceState> = new Set(['ai-drafted', 'ai-edited', 'ai-from-intent']);

/** Longest content core findPlaceholders accepts inside `[...]` is 160 chars; `claim: ` + body + `?` must fit. */
const MAX_CLAIM_BODY = 150;

const FORMAT_CMDS = /^\\(?:emph|textit|textbf|textrm|textsc|textsf|texttt|textsl|textup|mbox|text|textnormal|underline)$/;
const DROP_CMDS = /^\\(?:label|footnote|footnotemark|footnotetext|index|marginpar|todo|thanks|protect|nolinebreak|linebreak|newline|noindent)$/;

/** Split LaTeX into atoms that must never be cut: math, commands with their arguments, groups, words, spaces. */
function latexAtoms(src: string): Array<{ kind: 'math' | 'cmd' | 'group' | 'space' | 'text'; text: string; name?: string; args?: string[] }> {
  const out: Array<{ kind: 'math' | 'cmd' | 'group' | 'space' | 'text'; text: string; name?: string; args?: string[] }> = [];
  const n = src.length;
  const balanced = (i: number, open: string, close: string): number => {
    // index after the group starting at i (src[i] === open), or n when unclosed
    let d = 0;
    for (let j = i; j < n; j++) {
      const c = src[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === open) d++;
      else if (c === close && --d === 0) return j + 1;
    }
    return n;
  };
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === '$') {
      const dbl = src[i + 1] === '$';
      const close = dbl ? src.indexOf('$$', i + 2) : (() => {
        for (let j = i + 1; j < n; j++) {
          if (src[j] === '\\') {
            j++;
            continue;
          }
          if (src[j] === '$') return j;
        }
        return -1;
      })();
      const end = close < 0 ? n : close + (dbl ? 2 : 1);
      out.push({ kind: 'math', text: src.slice(i, end) });
      i = end;
      continue;
    }
    if (c === '\\') {
      const nx = src[i + 1] ?? '';
      if (nx === '(' || nx === '[') {
        const closer = nx === '(' ? '\\)' : '\\]';
        const close = src.indexOf(closer, i + 2);
        const end = close < 0 ? n : close + 2;
        out.push({ kind: 'math', text: src.slice(i, end) });
        i = end;
        continue;
      }
      const m = /^\\([A-Za-z@]+\*?|.)/.exec(src.slice(i, i + 64));
      const name = m ? '\\' + m[1]! : '\\';
      let j = i + name.length;
      if (name === '\\begin') {
        const env = /^\s*\{([^}]*)\}/.exec(src.slice(j));
        const envName = env ? env[1]! : '';
        const endTag = `\\end{${envName}}`;
        const close = src.indexOf(endTag, j);
        const end = close < 0 ? n : close + endTag.length;
        out.push({ kind: 'math', text: src.slice(i, end) });
        i = end;
        continue;
      }
      const args: string[] = [];
      if (/^\\[A-Za-z@]/.test(name)) {
        for (;;) {
          let k = j;
          while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
          if (src[k] === '[' && args.length === 0 && !/^\\(?:\\)$/.test(name)) {
            j = balanced(k, '[', ']'); // optional argument: dropped
            continue;
          }
          if (src[k] === '{') {
            const e = balanced(k, '{', '}');
            args.push(src.slice(k + 1, Math.max(k + 1, e - 1)));
            j = e;
            continue;
          }
          break;
        }
      }
      out.push({ kind: 'cmd', text: src.slice(i, j), name, args });
      i = j;
      continue;
    }
    if (c === '{') {
      const e = balanced(i, '{', '}');
      out.push({ kind: 'group', text: src.slice(i, e) });
      i = e;
      continue;
    }
    if (/\s|~/.test(c)) {
      let j = i;
      while (j < n && /\s|~/.test(src[j]!)) j++;
      out.push({ kind: 'space', text: ' ' });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !/[\s~$\\{]/.test(src[j]!)) j++;
    out.push({ kind: 'text', text: src.slice(i, j).replace(/\[/g, '(').replace(/\]/g, ')') });
    i = j;
  }
  return out;
}

/** Brackets inside an atom become \lbrack/\rbrack so the placeholder's own brackets stay matched. */
function safeBrackets(s: string): string {
  return s.replace(/(?<!\\)\[/g, '\\lbrack{}').replace(/(?<!\\)\]/g, '\\rbrack{}');
}

/**
 * `[claim: <text>?]` for a rejected sentence: its words as LaTeX that still compiles (inline math,
 * \cite and \ref kept verbatim so no number or key is invented or lost; labels, footnotes and optional
 * arguments dropped; formatting reduced to its text), on one line, cut at a safe point to fit the
 * placeholder limit of core findPlaceholders (160 chars). The full sentence stays in the version
 * history and in the `reject` event.
 */
export function claimPlaceholder(latex: string): string {
  // rejecting a sentence that already is a claim placeholder keeps it
  const trimmed = latex.trim().replace(/[.?!;:,]+$/, '').trim();
  const existing = findPlaceholders(trimmed);
  if (existing.length === 1 && existing[0]!.kind === 'claim' && existing[0]!.text === trimmed) return trimmed;
  const src = latex
    .split(/\r?\n/)
    .map((l) => stripComment(l))
    .join(' ');
  const pieces: string[] = [];
  for (const a of latexAtoms(src)) {
    if (a.kind === 'space') pieces.push(' ');
    else if (a.kind === 'text') pieces.push(a.text);
    else if (a.kind === 'math') {
      const one = a.text.replace(/\s+/g, ' ');
      pieces.push(one.length <= 80 ? safeBrackets(one) : '(equation)');
    } else if (a.kind === 'group') {
      const inner = claimBody(a.text.slice(1, -1));
      if (inner) pieces.push(inner);
    } else if (a.name && DROP_CMDS.test(a.name)) {
      continue;
    } else if (a.name && FORMAT_CMDS.test(a.name) && a.args && a.args.length) {
      pieces.push(claimBody(a.args[a.args.length - 1]!));
    } else {
      // keep the command (\cite{..}, \ref{..}, \%, macros) without its optional argument
      const t = (a.name ?? '') + (a.args ?? []).map((x) => `{${x.replace(/\s+/g, ' ')}}`).join('');
      pieces.push(safeBrackets(t));
    }
  }
  let body = pieces
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^claim:\s*/i, '');
  body = body.replace(/(?:\s|[.?!;:,]|\\[,;! ])+$/u, '').trim();
  if (body.length > MAX_CLAIM_BODY) {
    // cut at an atom boundary (a space outside math/commands)
    const atoms = body.split(/(\s+)/);
    let acc = '';
    for (const a of atoms) {
      if ((acc + a).length > MAX_CLAIM_BODY - 3) break;
      acc += a;
    }
    acc = acc.replace(/(?:\s|[.?!;:,])+$/u, '').trim();
    // never end inside math or a group: drop an unbalanced tail
    while (acc && (((acc.match(/(?<!\\)\$/g) ?? []).length % 2 === 1) || (acc.match(/(?<!\\)\{/g) ?? []).length !== (acc.match(/(?<!\\)\}/g) ?? []).length)) {
      const k = acc.lastIndexOf(' ');
      acc = k > 0 ? acc.slice(0, k).trimEnd() : '';
    }
    body = (acc || 'removed sentence') + '...';
  }
  return `[claim: ${body || 'removed sentence'}?]`;
}

/** Inner text of a group/argument, reduced the same way (no brackets, no truncation). */
function claimBody(latex: string): string {
  const p = claimPlaceholder(latex);
  const inner = p.slice('[claim: '.length, -2);
  return inner === 'removed sentence' ? '' : inner;
}

export function registerSentencesRoutes(app: FastifyInstance, ctx: Ctx): void {
  const log = (event: 'accept' | 'reject', id: string, file: string, data: Record<string, unknown>) => {
    const d = ctx.docs as DocServiceExt;
    if (typeof d.logEvent === 'function') d.logEvent(event, id, file, data);
  };

  app.get(ROUTES.sentenceHistory, async (req) => {
    const { id } = parseWith(Params, req.params, 'params');
    const unit = ctx.docs.unit(id) ?? ctx.db.unit(id);
    if (!unit) throw new HttpError(404, `no such sentence: ${id}`);
    const res: HistoryResponse = { unit, versions: ctx.db.versions(id) };
    return res;
  });

  app.post(ROUTES.sentenceAccept, async (req) => {
    const { id } = parseWith(Params, req.params, 'params');
    const unit = ctx.docs.unit(id);
    if (!unit) throw new HttpError(404, `no such sentence: ${id}`);
    if (ALREADY_ACCEPTED.has(unit.state)) return unit;
    if (!ACCEPTABLE.has(unit.state)) throw new HttpError(409, `only proposed or unsupported sentences can be accepted (this one is ${unit.state})`);
    const ts = new Date().toISOString();
    const next = ctx.docs.updateUnit(id, { state: 'ai-drafted', acceptedAt: ts, everAi: true });
    log('accept', id, unit.file, { from: unit.state, to: next.state, model: unit.model });
    return next;
  });

  app.post(ROUTES.sentenceReject, async (req) => {
    const { id } = parseWith(Params, req.params, 'params');
    const unit = ctx.docs.unit(id);
    if (!unit) throw new HttpError(404, `no such sentence: ${id}`);
    const text = ctx.docs.unitText(id);
    if (text === null) throw new HttpError(409, 'open the file before rejecting one of its sentences');
    const replacement = claimPlaceholder(text);
    log('reject', id, unit.file, { from: unit.state, text, replacement });
    return { replacement };
  });
}
