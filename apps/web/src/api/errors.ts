/** HTTP error surfaced by the API clients: the server's JSON `message` (or `error`) plus the status code. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Best human-readable message of an error response body (Fastify uses {statusCode, error, message}). */
export function messageOf(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 500);
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const k of ['message', 'error', 'detail']) {
      const v = b[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return fallback;
}

/** A message for any thrown value, for notices and inline errors. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Accept either a bare array or an object wrapping it under one of `keys` (servers differ on
 * `[...]` versus `{proposals: [...]}`); anything else becomes [].
 */
export function unwrapArray<T>(data: unknown, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

/** Accept either the object itself or `{[key]: object}`. */
export function unwrapObject<T>(data: unknown, key: string, isIt: (v: Record<string, unknown>) => boolean): T {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    if (isIt(o)) return o as T;
    const inner = o[key];
    if (inner && typeof inner === 'object') return inner as T;
  }
  return data as T;
}
