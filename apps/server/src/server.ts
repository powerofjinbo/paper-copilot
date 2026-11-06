/**
 * The HTTP + WebSocket server (Fastify 5), bound to 127.0.0.1 only.
 *
 * SECURITY (apps/server/src/contracts.ts):
 * - every request's Host header must be 127.0.0.1:<port> or localhost:<port> (plus the Vite dev port in
 *   dev mode), else 421, which defeats DNS rebinding;
 * - every /api request and the /ws upgrade must carry the per-launch token (`x-paper-token`, or
 *   `?token=` on GET requests such as the PDF URL and the WebSocket), compared in constant time;
 * - the /ws upgrade must come from the server's own origin (or the Vite dev origin in dev mode);
 * - GET /api/session hands the token to the Vite dev client only with `x-paper-client: 1` (a custom
 *   header forces a CORS preflight, which is never approved) and an allowed Host;
 * - no CORS headers are ever sent; index.html (with the token in `<meta name="paper-token">`) is
 *   served with no-store and frame-ancestors 'none'; the token and the API key are never logged.
 */
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { ROUTES } from '@paper-copilot/core';
import { HttpError, type Ctx, type RegisterRoutes } from './contracts';
import { createWsHub, type WsHub } from './ws';
import { SERVER_VERSION } from './version';
import { registerProjectRoutes } from './routes/project';
import { registerDocRoutes } from './routes/doc';
import { registerSentencesRoutes } from './routes/sentences';
import { registerSyncRoutes } from './routes/sync';
import { registerDisclosureRoutes } from './routes/disclosure';
import { registerOutlineRoutes } from './routes/outline';
import { registerAgentsRoutes } from './routes/agents';
import { registerBuildRoutes } from './routes/build';
import { registerFactsRoutes } from './routes/facts';
import { registerLitRoutes } from './routes/lit';
import { registerLlmRoutes } from './routes/llm';
import { registerPanelsRoutes } from './routes/panels';
import { registerVoiceRoutes } from './routes/voice';
import { registerLintRoutes } from './routes/lint';

export const DEFAULT_PORT = 4317;
export const VITE_DEV_PORT = 5173;
export const SESSION_ROUTE = '/api/session';

/** Every route module of the server (hub + service agents). */
export const ROUTE_MODULES: Array<[string, RegisterRoutes]> = [
  ['project', registerProjectRoutes],
  ['doc', registerDocRoutes],
  ['outline', registerOutlineRoutes],
  ['sentences', registerSentencesRoutes],
  ['sync', registerSyncRoutes],
  ['disclosure', registerDisclosureRoutes],
  ['facts', registerFactsRoutes],
  ['panels', registerPanelsRoutes],
  ['lit', registerLitRoutes],
  ['llm', registerLlmRoutes],
  ['agents', registerAgentsRoutes],
  ['build', registerBuildRoutes],
  ['voice', registerVoiceRoutes],
  ['lint', registerLintRoutes],
];

export interface ServerOptions {
  ctx: Ctx;
  /** 0 = ephemeral. Default 4317. */
  port?: number;
  /** Only 127.0.0.1 is accepted (the contract); kept as an option to fail loudly on anything else. */
  host?: string;
  /** Allow the Vite dev origin/host (127.0.0.1:5173, localhost:5173). */
  dev?: boolean;
  devPort?: number;
  /** Built web client (default apps/web/dist). */
  webDist?: string;
  /** WebSocket keepalive interval (tests). */
  pingIntervalMs?: number;
}

export interface PaperServer {
  app: FastifyInstance;
  hub: WsHub;
  port: number;
  /** http://127.0.0.1:<port>/ */
  url: string;
  close(): Promise<void>;
}

/**
 * Route modules added to src/routes/ after this list was written are picked up too: every export named
 * register<Area>Routes not registered above is called. A module that fails to load is skipped with a
 * warning (the server still starts).
 */
async function registerDiscoveredRoutes(app: FastifyInstance, ctx: Ctx, registered: Set<unknown>): Promise<void> {
  const dir = fileURLToPath(new URL('./routes/', import.meta.url));
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => /\.(ts|js|mjs)$/.test(f) && !/\.d\.ts$/.test(f) && !/\.test\./.test(f));
  } catch {
    return;
  }
  for (const f of names.sort()) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(join(dir, f)).href)) as Record<string, unknown>;
    } catch (e) {
      ctx.log.warn(`routes/${f} could not be loaded; its routes are unavailable`, e instanceof Error ? e.message : String(e));
      continue;
    }
    for (const [k, v] of Object.entries(mod)) {
      if (!/^register\w+Routes$/.test(k) || typeof v !== 'function' || registered.has(v)) continue;
      registered.add(v);
      try {
        await (v as RegisterRoutes)(app, ctx);
        ctx.log.info(`registered ${k} from routes/${f}`);
      } catch (e) {
        ctx.log.warn(`${k} from routes/${f} failed to register`, e instanceof Error ? e.message : String(e));
      }
    }
  }
}

/** apps/web/dist, or PAPER_WEB_DIST (an alternative build, e.g. the full-stack E2E build). */
export function defaultWebDist(): string {
  const env = process.env.PAPER_WEB_DIST;
  if (env && env.trim()) return resolve(env);
  return resolve(new URL('../../web/dist', import.meta.url).pathname);
}

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || given.length === 0 || given.length > 512) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** index.html with the launch token injected as <meta name="paper-token">. */
export function injectToken(html: string, token: string): string {
  const meta = `<meta name="paper-token" content="${escapeAttr(token)}">`;
  const cleaned = html.replace(/<meta\s+name=["']paper-token["'][^>]*>\s*/gi, '');
  if (/<head[^>]*>/i.test(cleaned)) return cleaned.replace(/<head[^>]*>/i, (m) => `${m}\n    ${meta}`);
  return meta + cleaned;
}

function missingDistPage(dist: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>paper-copilot</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:3px}</style></head>
<body><h1>paper-copilot server is running</h1>
<p>The web client has not been built yet (no <code>${escapeAttr(dist)}</code>).</p>
<p>Build it once and reload this page:</p><pre><code>pnpm --filter @paper-copilot/web build</code></pre>
<p>Or run the development client (it talks to this server through the Vite proxy):</p><pre><code>pnpm --filter @paper-copilot/web dev</code></pre>
<p>then open <code>http://127.0.0.1:${VITE_DEV_PORT}/</code> (start the server with <code>--dev</code>).</p></body></html>`;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export async function createServer(opts: ServerOptions): Promise<PaperServer> {
  const ctx = opts.ctx;
  const host = opts.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error(`refusing to bind to ${host}: the server listens on 127.0.0.1 only`);
  const devPort = opts.devPort ?? VITE_DEV_PORT;
  const dist = opts.webDist ?? defaultWebDist();

  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1024 * 1024,
    requestIdHeader: false,
    return503OnClosing: true,
    forceCloseConnections: true,
  });
  let port = 0;
  const allowedHosts = () => {
    const s = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (opts.dev) {
      s.add(`127.0.0.1:${devPort}`);
      s.add(`localhost:${devPort}`);
    }
    return s;
  };
  const allowedOrigins = () => {
    const s = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (opts.dev) {
      s.add(`http://127.0.0.1:${devPort}`);
      s.add(`http://localhost:${devPort}`);
    }
    return s;
  };

  const deny = (reply: FastifyReply, status: number, error: string) => reply.code(status).header('Cache-Control', 'no-store').send({ error });

  const pathOf = (req: FastifyRequest) => {
    const u = req.raw.url ?? '/';
    const q = u.indexOf('?');
    return q < 0 ? u : u.slice(0, q);
  };
  /**
   * The path as the router sees it, for classification only: percent-decoded (find-my-way decodes
   * when routing, so "/%61pi/doc" IS "/api/doc"), duplicate slashes folded, lower-cased. null when the
   * encoding is malformed.
   */
  const routedPathOf = (req: FastifyRequest): string | null => {
    let p = pathOf(req);
    try {
      for (let i = 0; i < 3 && p.includes('%'); i++) p = decodeURIComponent(p);
    } catch {
      return null;
    }
    return p.replace(/\/{2,}/g, '/').toLowerCase();
  };
  const looksProtected = (p: string): boolean => p === '/api' || p.startsWith('/api/') || p === ROUTES.ws || p.startsWith(`${ROUTES.ws}/`);
  /** Routes anyone on 127.0.0.1 with the right Host may load: the page, its static assets, the token handshake. */
  const PUBLIC_ROUTES = new Set(['/', '/index.html', '/*']);

  // registered before the auth hook so its onRequest/onResponse hooks always run (a refused upgrade's
  // socket is then destroyed after the error response)
  await app.register(fastifyWebsocket, { options: { maxPayload: 32 * 1024 * 1024 } });

  app.addHook('onRequest', async (req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts().has(hostHeader)) return deny(reply, 421, 'misdirected request: unexpected Host header');
    // Deny by default: the decision is made on the route Fastify actually matched (whatever spelling of
    // the path reached it) and, for unmatched paths, on the decoded path. Only the page, its static
    // assets and the session handshake are public.
    const routed = routedPathOf(req);
    if (routed === null) return deny(reply, 400, 'malformed path');
    const route = req.routeOptions?.url;
    if (route === SESSION_ROUTE) return; // checked in its handler (x-paper-client)
    const isPublic = !looksProtected(routed) && (route === undefined || PUBLIC_ROUTES.has(route));
    if (isPublic) return;
    const isWs = route === ROUTES.ws || routed === ROUTES.ws;
    if (isWs) {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins().has(String(origin).toLowerCase())) return deny(reply, 403, 'forbidden origin');
    }
    const header = req.headers['x-paper-token'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const q = req.query as Record<string, unknown> | undefined;
    const fromQuery = req.method === 'GET' && q && typeof q.token === 'string' ? q.token : undefined;
    if (!sameToken(fromHeader ?? fromQuery, ctx.token)) return deny(reply, 401, 'missing or invalid token');
    reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { statusCode?: number; message?: string; validation?: unknown; code?: string; name?: string; issues?: unknown };
    let status = 500;
    let message = 'internal error';
    if (err instanceof HttpError) {
      status = err.status;
      message = err.message;
    } else if (e && e.name === 'ZodError') {
      status = 400;
      message = `invalid request: ${e.message ?? ''}`.slice(0, 2000);
    } else if (e && typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      status = e.statusCode;
      message = e.message ?? 'bad request';
    }
    if (status >= 500) ctx.log.error(`${req.method} ${pathOf(req)} failed`, e?.message ?? String(err));
    return reply.code(status).header('Cache-Control', 'no-store').send({ error: message });
  });

  app.setNotFoundHandler(async (req, reply) => {
    const path = pathOf(req);
    const routed = routedPathOf(req);
    if (routed === null || looksProtected(routed) || req.method !== 'GET') return deny(reply, 404, `not found: ${req.method} ${path}`);
    // single-page app: unknown GET paths get index.html
    return sendIndex(reply);
  });

  const hub = createWsHub(ctx, { pingIntervalMs: opts.pingIntervalMs });

  app.get(SESSION_ROUTE, async (req, reply) => {
    if (req.headers['x-paper-client'] !== '1') return deny(reply, 403, 'x-paper-client header required');
    reply.header('Cache-Control', 'no-store');
    return { token: ctx.token, serverVersion: SERVER_VERSION };
  });

  app.get(ROUTES.ws, { websocket: true }, (socket) => {
    hub.attach(socket);
  });

  const registered = new Set<unknown>();
  for (const [name, register] of ROUTE_MODULES) {
    try {
      await register(app, ctx);
      registered.add(register);
    } catch (e) {
      throw new Error(`cannot register the ${name} routes: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await registerDiscoveredRoutes(app, ctx, registered);

  const hasDist = existsSync(join(dist, 'index.html'));
  let indexCache: string | null = null;
  const indexHtml = (): string => {
    if (!hasDist) return missingDistPage(dist);
    if (indexCache === null || process.env.PAPER_DEV_RELOAD === '1') indexCache = injectToken(readFileSync(join(dist, 'index.html'), 'utf8'), ctx.token);
    return indexCache;
  };
  function sendIndex(reply: FastifyReply) {
    return reply.code(200).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(indexHtml());
  }
  app.get('/', async (_req, reply) => sendIndex(reply));
  app.get('/index.html', async (_req, reply) => sendIndex(reply));
  if (hasDist) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', index: false, wildcard: true, serveDotFiles: false, cacheControl: true, maxAge: 0 });
  }

  await app.listen({ host, port: opts.port ?? DEFAULT_PORT });
  port = (app.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;
  ctx.log.info(`listening on ${url}`);

  let closed = false;
  return {
    app,
    hub,
    port,
    url,
    async close() {
      if (closed) return;
      closed = true;
      hub.close();
      await app.close();
    },
  };
}
