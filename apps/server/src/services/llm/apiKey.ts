/**
 * Where the Anthropic API key comes from, and where the API lives.
 *
 * Key: ONLY the environment variable ANTHROPIC_API_KEY or the OS keychain entry the user created for
 * this app:
 *   macOS:  security add-generic-password -s paper-copilot -a "$USER" -w <key>
 *           (read with `security find-generic-password -s paper-copilot -w`)
 *   Linux:  secret-tool store --label='paper-copilot' service paper-copilot
 *           (read with `secret-tool lookup service paper-copilot`)
 * Keychain lookups fail soft (missing tool, locked keychain, no entry, timeout -> null). The key is never
 * logged, never sent to the browser and never written to disk by this module.
 *
 * Base URL: the app never inherits ANTHROPIC_BASE_URL silently (a sandbox or another tool may set it for
 * its own use). It passes `baseURL` explicitly: PAPER_ANTHROPIC_BASE_URL when set, else the public API.
 */
import { execFileSync } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'paper-copilot';
export const DEFAULT_BASE_URL = 'https://api.anthropic.com';

export type KeySource = 'env' | 'keychain' | 'none';

export interface ResolvedKey {
  key: string | null;
  source: KeySource;
}

/** Runs a command and returns its trimmed stdout, or null on any failure. Injected in tests. */
export type CommandRunner = (cmd: string, args: string[]) => string | null;

export const defaultRunner: CommandRunner = (cmd, args) => {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const t = out.trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
};

/** A plausible key: printable ASCII without whitespace (rejects a keychain prompt or an error text). */
export function plausibleKey(s: string | null | undefined): s is string {
  return typeof s === 'string' && /^[\x21-\x7e]{8,}$/.test(s);
}

export function keychainLookup(platform: NodeJS.Platform = process.platform, run: CommandRunner = defaultRunner): string | null {
  let out: string | null = null;
  if (platform === 'darwin') out = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
  else if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') out = run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE]);
  return plausibleKey(out) ? out : null;
}

export function resolveApiKey(opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; run?: CommandRunner; useKeychain?: boolean } = {}): ResolvedKey {
  const env = opts.env ?? process.env;
  const fromEnv = env.ANTHROPIC_API_KEY?.trim();
  if (plausibleKey(fromEnv)) return { key: fromEnv, source: 'env' };
  if (opts.useKeychain === false) return { key: null, source: 'none' };
  const fromKeychain = keychainLookup(opts.platform ?? process.platform, opts.run ?? defaultRunner);
  if (fromKeychain) return { key: fromKeychain, source: 'keychain' };
  return { key: null, source: 'none' };
}

/** The base URL the app uses: PAPER_ANTHROPIC_BASE_URL (validated http/https URL) or the public API. Never ANTHROPIC_BASE_URL. */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PAPER_ANTHROPIC_BASE_URL?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') return raw.replace(/\/+$/, '');
  } catch {
    /* fall through */
  }
  return DEFAULT_BASE_URL;
}
