import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asViewerError, ViewerError } from '../core/errors.js';
import type { RepositoryReader } from '../core/repository.js';
import type { AiRuntime } from '../ai/registry.js';
import { OfficialDocsService, type OfficialDocsPreview, type OfficialDocsResult } from '../docs/service.js';
import { commitPrompt, MCP_CLIENT_GUIDES, MCP_RESOURCES } from '../mcp/guides.js';
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
function originHost(value: string): string | null { try { return new URL(value).host; } catch { return null; } }
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
  if (['STALE_CURSOR', 'STATE_CHANGED', 'AI_REQUEST_EXPIRED'].includes(code)) return 409;
  if (code === 'AI_QUEUE_FULL') return 429;
  if (['AI_DISABLED', 'PROVIDER_MODEL_NOT_FOUND', 'PROVIDER_UNAVAILABLE'].includes(code)) return 503;
  if (['OUTPUT_LIMIT', 'PROVIDER_OUTPUT_LIMIT'].includes(code)) return 413;
  if (['TIMEOUT', 'PROVIDER_TIMEOUT'].includes(code)) return 504;
  if (code === 'PROVIDER_OUTPUT_INVALID') return 502;
  return 500;
}

async function jsonBody(request: IncomingMessage, maximumBytes: number): Promise<Record<string, unknown>> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) throw new ViewerError('OUTPUT_LIMIT', 'Request body is too large.');
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const values: Buffer[] = []; let total = 0; let settled = false;
    const cleanup = () => { request.off('data', onData); request.off('end', onEnd); request.off('error', onError); };
    const onData = (chunk: Buffer | string) => {
      if (settled) return; const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += value.length;
      if (total > maximumBytes) { settled = true; cleanup(); request.resume(); reject(new ViewerError('OUTPUT_LIMIT', 'Request body is too large.')); return; }
      values.push(value);
    };
    const onEnd = () => { if (!settled) { settled = true; cleanup(); resolve(values); } };
    const onError = (error: Error) => { if (!settled) { settled = true; cleanup(); reject(new ViewerError('INVALID_ARGUMENT', 'Request body could not be read.', { cause: error })); } };
    request.on('data', onData); request.on('end', onEnd); request.on('error', onError);
  });
  let parsed: unknown; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ViewerError('INVALID_ARGUMENT', 'Request body must be valid JSON.'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ViewerError('INVALID_ARGUMENT', 'Request body must be a JSON object.');
  return parsed as Record<string, unknown>;
}

export interface OfficialDocsRuntime { preview(oid: string): Promise<OfficialDocsPreview>; execute(requestId: string): Promise<OfficialDocsResult> }
export interface ViewerServerOptions { port: number; limit: number; token?: string; ai?: AiRuntime; docs?: OfficialDocsRuntime }

export async function createViewerServer(reader: RepositoryReader, options: ViewerServerOptions) {
  const token = options.token ?? randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const docs = options.docs ?? new OfficialDocsService(reader);
  const cookieName = 'git_history_session';
  let actualPort: number | null = null;
  let versionPromise: Promise<string> | null = null;
  const generation = () => {
    if (!versionPromise) versionPromise = reader.generation().finally(() => { versionPromise = null; });
    return versionPromise;
  };
  const staticRoutes = new Map<string, readonly [string, string]>([
    ['/', [path.join(publicRoot, 'index.html'), 'text/html; charset=utf-8']],
    ['/app.js', [path.join(publicRoot, 'app.js'), 'text/javascript; charset=utf-8']],
    ['/styles.css', [path.join(publicRoot, 'styles.css'), 'text/css; charset=utf-8']],
    ['/topology.js', [fileURLToPath(new URL('./topology.js', import.meta.url)), 'text/javascript; charset=utf-8']],
  ] as const);

  const server = http.createServer(async (request, response) => {
    try {
      if (actualPort === null) return send(response, 503, 'Starting.');
      const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      const host = request.headers.host ?? '';
      if (!allowedHosts.has(host)) return send(response, 421, 'Misdirected request.');
      const origin = request.headers.origin;
      if (origin && !allowedHosts.has(originHost(origin) ?? '')) return send(response, 403, 'Origin rejected.');
      if (!['GET', 'HEAD', 'POST'].includes(request.method ?? '')) return send(response, 405, 'Method not allowed.', undefined, { Allow: 'GET, HEAD, POST' });
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname === '/' && url.searchParams.has('token')) {
        if (!equalSecret(url.searchParams.get('token'), token)) return send(response, 403, 'Invalid session token.');
        return send(response, 303, '', undefined, { Location: '/', 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (!equalSecret(cookie(request, cookieName), token)) return send(response, 401, 'Session required.');
      if (request.method === 'POST') {
        if (!['/api/v1/ai/explanations', '/api/v1/docs/fetch'].includes(url.pathname) || url.search) return send(response, 405, 'Method not allowed.', undefined, { Allow: 'GET, HEAD' });
        if (origin !== `http://${host}`) return send(response, 403, 'Origin required.');
        if (!equalSecret(typeof request.headers['x-ghv-csrf'] === 'string' ? request.headers['x-ghv-csrf'] : null, csrfToken)) return send(response, 403, 'CSRF token rejected.');
        if (request.headers['content-type'] !== 'application/json') return send(response, 415, 'Content-Type must be application/json.');
        const body = await jsonBody(request, 1024);
        if (Object.keys(body).length !== 1 || typeof body.requestId !== 'string') throw new ViewerError('INVALID_ARGUMENT', 'Only requestId is accepted.');
        if (url.pathname === '/api/v1/docs/fetch') {
          const data = await docs.execute(body.requestId);
          return send(response, 200, JSON.stringify(success(await generation(), data)), 'application/json; charset=utf-8');
        }
        if (!options.ai) throw new ViewerError('AI_DISABLED', 'AI explanation is disabled.');
        const data = await options.ai.execute(body.requestId);
        const warnings = data.warning ? [{ code: 'CACHE_WRITE_FAILED', message: data.warning, details: {} }] : [];
        return send(response, 200, JSON.stringify(success(await generation(), data, warnings)), 'application/json; charset=utf-8');
      }
      const gen = await generation();
      const json = (data: unknown) => send(response, 200, JSON.stringify(success(gen, data)), 'application/json; charset=utf-8');
      if (url.pathname === '/api/v1/ai/capabilities') return json({ ...(options.ai?.capabilities() ?? { enabled: false }), csrfToken });
      if (url.pathname === '/api/v1/mcp/guides') {
        if (url.search) throw new ViewerError('INVALID_ARGUMENT', 'MCP guides do not accept query parameters.');
        return json({ guides: MCP_CLIENT_GUIDES, resources: MCP_RESOURCES.map(({ uri, title, description, mimeType }) => ({ uri, title, description, mimeType })), commitPromptTemplate: commitPrompt('{FULL_COMMIT_OID}') });
      }
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
      const officialDocs = url.pathname.match(/^\/api\/v1\/commits\/([0-9a-f]+)\/official-docs$/u);
      if (officialDocs) {
        if (url.search) throw new ViewerError('INVALID_ARGUMENT', 'Official document recommendations do not accept query parameters.');
        return json(await docs.preview(officialDocs[1] ?? ''));
      }
      const preview = url.pathname.match(/^\/api\/v1\/commits\/([0-9a-f]+)\/explanation-preview$/u);
      if (preview) {
        if ([...url.searchParams.keys()].some((key) => key !== 'profile') || url.searchParams.getAll('profile').length > 1) throw new ViewerError('INVALID_ARGUMENT', 'AI preview accepts only one profile parameter.');
        if (!options.ai) throw new ViewerError('AI_DISABLED', 'AI explanation is disabled.');
        return json(await options.ai.preview(preview[1] ?? '', url.searchParams.get('profile')));
      }
      const commit = url.pathname.match(/^\/api\/v1\/commits\/([0-9a-f]+)$/u);
      if (commit) return json(await reader.commit(commit[1] ?? ''));
      const asset = staticRoutes.get(url.pathname);
      if (asset) return send(response, 200, await readFile(asset[0]), asset[1]);
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
