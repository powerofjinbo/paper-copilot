/**
 * One ApiClient per page. `?mock=1` (or `?demo=1`) selects the in-browser MockApiClient (loaded as a
 * separate chunk, so the fixture never ships with the real client); otherwise the HTTP/WebSocket
 * client talks to the local server.
 */
import type { ApiClient } from '../contracts';
import { HttpApiClient } from './client';

export function wantsMock(search: string = typeof location !== 'undefined' ? location.search : ''): boolean {
  const p = new URLSearchParams(search);
  const v = p.get('mock') ?? p.get('demo');
  return v !== null && v !== '0' && v !== 'false';
}

/** `?fixture=large`: the demo on fixtures/large-multifile (an \input project) instead of canto-demo. */
export function mockFixture(search: string = typeof location !== 'undefined' ? location.search : ''): 'canto' | 'large' {
  return new URLSearchParams(search).get('fixture') === 'large' ? 'large' : 'canto';
}

let instance: Promise<ApiClient> | null = null;

export function getApiClient(): Promise<ApiClient> {
  if (!instance) {
    instance = wantsMock()
      ? mockFixture() === 'large'
        ? import('./mockLarge').then((m) => m.createLargeMock())
        : import('./mock').then((m) => new m.MockApiClient())
      : Promise.resolve(new HttpApiClient());
  }
  return instance;
}
