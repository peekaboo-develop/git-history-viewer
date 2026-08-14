import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asViewerError, ViewerError } from '../core/errors.js';
import type { RepositoryReader } from '../core/repository.js';
import { SCHEMA_VERSION, success } from '../schema/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const publicRoot = path.join(packageRoot, 'public');

function equalSecret(left: string | null, right: string): boolean {
  const a = Buffer.from(left ?? ''); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookie(request: IncomingMessage, name: string): string | null {
  for (const item of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = item.trim().split('='); if (key === name) return value.join('=');
  }
  return null;
}
function headers(type: string): Record<string, string> {
  return {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  };
}
function send(response: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): void {
  response.writeHead(status, { ...headers(type), ...extra });
  if (response.req.method === 'HEAD') response.end(); else response.end(body);
}
function statusFor(code: string): number {
  if (['INVALID_ARGUMENT', 'INVALID_OID'].includes(code)) return 400;
  if (['CONTENT_DISABLED', 'CONTENT_EXCLUDED'].includes(code)) return 403;
  if (['NOT_FOUND', 'NOT_GIT_REPOSITORY'].includes(code)) return 404;
  if (['STALE_CURSOR', 'STATE_CHANGED'].includes(code)) return 409;
  if (code === 'OUTPUT_LIMIT') return 413; if (code === 'TIMEOUT') return 504; return 500;
}

export interface ViewerServerOptions { port: number; limit: number; token?: string }

export async function createViewerServer(reader: RepositoryReader, options: ViewerServerOptions) {
  const token = options.token ?? randomBytes(32).toString('hex');
  const cookieName = 'git_history_session';
  let actualPort: number | null = null;
  let versionPromise: Promise<string> | null = null;
  const generation = () => {
    if (!versionPromise) versionPromise = reader.generation().finally(() => { versionPromise = null; });
    return versionPromise;
  };
  const staticRoutes = new Map<string, readonly [string, string]>([
    ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ] as const);

  const server = http.createServer(async (request, response) => {
    try {
      if (actualPort === null) return send(response, 503, 'Starting.');
      const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      const host = request.headers.host ?? '';
      if (!allowedHosts.has(host)) return send(response, 421, 'Misdirected request.');
      const origin = request.headers.origin;
      if (origin && !allowedHosts.has(new URL(origin).host)) return send(response, 403, 'Origin rejected.');
      if (!['GET', 'HEAD'].includes(request.method ?? '')) return send(response, 405, 'Method not allowed.', undefined, { Allow: 'GET, HEAD' });
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname === '/' && url.searchParams.has('token')) {
        if (!equalSecret(url.searchParams.get('token'), token)) return send(response, 403, 'Invalid session token.');
        return send(response, 303, '', undefined, { Location: '/', 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (!equalSecret(cookie(request, cookieName), token)) return send(response, 401, 'Session required.');
      const gen = await generation();
      const json = (data: unknown) => send(response, 200, JSON.stringify(success(gen, data)), 'application/json; charset=utf-8');
      if (url.pathname === '/api/v1/repository') return json(await reader.repository());
      if (url.pathname === '/api/v1/status') return json(await reader.status(true));
      if (url.pathname === '/api/v1/refs') return json({ items: await reader.refs(), truncated: false, omittedCount: 0, nextCursor: null });
      if (url.pathname === '/api/v1/commits') {
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : options.limit;
        if ([...url.searchParams.keys()].some((key) => !['limit', 'cursor'].includes(key))) throw new ViewerError('INVALID_ARGUMENT', 'Unsupported query parameter.');
        return json(await reader.commits(limit, url.searchParams.get('cursor')));
      }
      if (url.pathname === '/api/v1/worktrees') return json(await reader.worktrees());
      if (url.pathname === '/api/v1/unpushed') return json(await reader.unpushed(url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50));
      if (url.pathname === '/api/v1/generation') return json({ generation: gen });
      const changes = url.pathname.match(/^\/api\/v1\/commits\/([0-9a-f]+)\/changes$/u);
      if (changes) return json(await reader.changes(changes[1] ?? '', url.searchParams.has('parentIndex') ? Number(url.searchParams.get('parentIndex')) : null, true));
      const commit = url.pathname.match(/^\/api\/v1\/commits\/([0-9a-f]+)$/u);
      if (commit) return json(await reader.commit(commit[1] ?? ''));
      const asset = staticRoutes.get(url.pathname);
      if (asset) return send(response, 200, await readFile(path.join(publicRoot, asset[0])), asset[1]);
      return send(response, 404, 'Not found.');
    } catch (error) {
      const known = asViewerError(error);
      const body = { schemaVersion: SCHEMA_VERSION, generation: '', data: null, warnings: [], error: known.publicValue() };
      send(response, statusFor(known.code), JSON.stringify(body), 'application/json; charset=utf-8');
    }
  });

  return {
    server, token,
    get port() { return actualPort; },
    get url() { if (actualPort === null) throw new Error('Server is not listening.'); return `http://127.0.0.1:${actualPort}/?token=${token}`; },
    listen: () => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', () => {
        server.off('error', reject); const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('Could not resolve listener address.'));
        actualPort = address.port; resolve();
      });
    }),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
