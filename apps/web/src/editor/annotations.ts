/**
 * CodeMirror annotations used by the editor.
 *
 * - `changeAnnotation`: provenance attached to a transaction that inserts AI text or changes a unit's state.
 *   The document sync reads it and sends it with the `doc.change` (null for plain typing).
 * - `remoteChange`: the transaction came from the server (snapshot, doc.replace); it is never echoed back.
 * - `ghostInsert`: the transaction inserts accepted ghost text (value: request id). The ghost machine already
 *   knows about it, so it is not fed back as a 'typed' event.
 */
import { Annotation } from '@codemirror/state';
import type { ChangeAnnotation } from '@paper-copilot/core';

export const changeAnnotation = Annotation.define<ChangeAnnotation>();
export const remoteChange = Annotation.define<boolean>();
export const ghostInsert = Annotation.define<string>();

/** A complete ChangeAnnotation from the fields that matter; every other field gets its neutral value. */
export function makeAnnotation(p: Partial<ChangeAnnotation> & Pick<ChangeAnnotation, 'origin'>): ChangeAnnotation {
  return {
    origin: p.origin,
    sentenceIds: p.sentenceIds ?? [],
    state: p.state ?? null,
    model: p.model ?? null,
    promptHash: p.promptHash ?? null,
    instruction: p.instruction ?? null,
    lang: p.lang ?? null,
    intentNote: p.intentNote ?? null,
    factIds: p.factIds ?? [],
    citeKeys: p.citeKeys ?? [],
    move: p.move ?? null,
    requestId: p.requestId ?? null,
  };
}
