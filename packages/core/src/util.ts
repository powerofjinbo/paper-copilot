/** Placeholder used by contract stubs until the owning module is implemented. */
export function notImplemented(name: string, ..._args: unknown[]): never {
  throw new Error(`not implemented: ${name}`);
}

/** ISO timestamp (second resolution is enough for logs; ms kept for ordering). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Stable JSON stringify (sorted keys) for hashing objects. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
