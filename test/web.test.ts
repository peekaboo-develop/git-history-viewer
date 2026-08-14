import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { openRepository } from '../src/core/repository.js';
import { createViewerServer } from '../src/web/server.js';
import { fixture } from './fixture.js';

function request(port: number, url: string, options: { host?: string; method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: options.method ?? 'GET', headers: { Host: options.host ?? `127.0.0.1:${port}`, ...options.headers } }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }); req.on('error', reject); req.end();
  });
}

test('web server binds loopback and enforces session, host, origin, and method', async (t) => {
  const data = await fixture(); const reader = await openRepository(data.repo); const viewer = await createViewerServer(reader, { port: 0, limit: 50, token: 'a'.repeat(64) }); await viewer.listen();
  t.after(() => viewer.close()); const port = viewer.port ?? 0; const address = viewer.server.address(); assert.equal(address && typeof address !== 'string' ? address.address : '', '127.0.0.1');
  assert.equal((await request(port, '/')).status, 401); assert.equal((await request(port, '/', { host: 'evil.test' })).status, 421);
  const login = await request(port, `/?token=${'a'.repeat(64)}`); assert.equal(login.status, 303); assert.match(login.headers['set-cookie']?.[0] ?? '', /HttpOnly; SameSite=Strict/u);
  const session = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  assert.equal((await request(port, '/api/v1/repository', { headers: { Cookie: session, Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request(port, '/', { method: 'POST', headers: { Cookie: session } })).status, 405);
  const page = await request(port, '/', { headers: { Cookie: session } }); assert.equal(page.status, 200); assert.match(String(page.headers['content-security-policy'] ?? ''), /frame-ancestors 'none'/u);
});
