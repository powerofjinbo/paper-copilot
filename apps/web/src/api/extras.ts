/**
 * Optional capabilities beyond the ApiClient contract (apps/web/src/contracts.ts). Panels feature-detect
 * them, so a client without them still works.
 *
 * CONTRACT GAP: the Voice panel's per-entry "unassisted" toggle has no ApiClient method (the server's
 * VoiceService has setUnassisted). Both shell clients implement it here; the HTTP client sends
 * `PATCH /api/voice/corpus/:id {unassisted}` until the contract gains a method.
 */
import type { CorpusEntry } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';

export interface ApiClientExtras {
  setCorpusUnassisted(id: string, unassisted: boolean): Promise<CorpusEntry | null>;
  /** True when this client is the in-browser mock (no backend). */
  readonly isMock?: boolean;
}

export function hasExtras(api: ApiClient): api is ApiClient & ApiClientExtras {
  return typeof (api as Partial<ApiClientExtras>).setCorpusUnassisted === 'function';
}

export function isMockClient(api: ApiClient): boolean {
  return (api as Partial<ApiClientExtras>).isMock === true;
}
