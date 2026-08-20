import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { openRepository } from '../src/core/repository.js';
import { createViewerServer } from '../src/web/server.js';
import { fixture } from './fixture.js';

function request(port: number, url: string, options: { host?: string; method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: options.method ?? 'GET', headers: { Host: options.host ?? `127.0.0.1:${port}`, ...options.headers } }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }); req.on('error', reject); req.end(options.body);
  });
}

test('web server binds loopback and enforces session, host, origin, and method', async (t) => {
  const data = await fixture(); const reader = await openRepository(data.repo); const viewer = await createViewerServer(reader, { port: 0, limit: 50, token: 'a'.repeat(64) }); await viewer.listen();
  t.after(() => viewer.close()); const port = viewer.port ?? 0; const address = viewer.server.address(); assert.equal(address && typeof address !== 'string' ? address.address : '', '127.0.0.1');
  assert.equal((await request(port, '/')).status, 401); assert.equal((await request(port, '/', { host: 'evil.test' })).status, 421);
  const login = await request(port, `/?token=${'a'.repeat(64)}`); assert.equal(login.status, 303); assert.match(login.headers['set-cookie']?.[0] ?? '', /HttpOnly; SameSite=Strict/u);
  const session = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  assert.equal((await request(port, '/api/v1/repository', { headers: { Cookie: session, Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request(port, '/api/v1/repository', { headers: { Cookie: session, Origin: 'not a url' } })).status, 403);
  assert.equal((await request(port, '/', { method: 'POST', headers: { Cookie: session } })).status, 405);
  const page = await request(port, '/', { headers: { Cookie: session } }); assert.equal(page.status, 200); assert.match(String(page.headers['content-security-policy'] ?? ''), /frame-ancestors 'none'/u); assert.match(page.body, /id="loading"/u); assert.match(page.body, /リポジトリを読み込んでいます/u); assert.match(page.body, /Git履歴を読み解く/u); assert.match(page.body, /ローカル・読み取り専用/u); assert.match(page.body, /data-tooltip="MCP設定ガイドを開く"/u); assert.match(page.body, /aria-controls="detail-panel"/u); assert.match(page.body, /id="detail-close"/u);
  const topology = await request(port, '/topology.js', { headers: { Cookie: session } });
  assert.equal(topology.status, 200); assert.match(topology.body, /buildTopology/u); assert.doesNotMatch(topology.body, /innerHTML/u);
  const filters = await request(port, '/filters.js', { headers: { Cookie: session } });
  assert.equal(filters.status, 200); assert.match(filters.body, /relatedHistory/u); assert.doesNotMatch(filters.body, /innerHTML/u);
  const app = await request(port, '/app.js', { headers: { Cookie: session } }); assert.equal(app.status, 200); assert.match(app.body, /コミット情報/u); assert.match(app.body, /公式資料の抜粋/u); assert.match(app.body, /対象.*除外.*一部省略/u); assert.match(app.body, /STALE_CURSOR/u); assert.match(app.body, /最新の履歴で読み直しています/u); assert.match(app.body, /maxRank-node\.rank/u); assert.match(app.body, /git-history-detail/u); assert.match(app.body, /detail-closed/u);
  const styles = await request(port, '/styles.css', { headers: { Cookie: session } }); assert.equal(styles.status, 200); assert.match(styles.body, /loading-progress/u); assert.match(styles.body, /prefers-reduced-motion/u); assert.match(styles.body, /getting-started/u); assert.match(styles.body, /tooltip:focus-visible/u);
  const guides = await request(port, '/api/v1/mcp/guides', { headers: { Cookie: session } });
  assert.equal(guides.status, 200); assert.match(guides.body, /codex mcp add/u); assert.match(guides.body, /FULL_COMMIT_OID/u);
  assert.doesNotMatch(guides.body, new RegExp(data.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  assert.equal((await request(port, '/api/v1/mcp/guides?repo=/tmp/evil', { headers: { Cookie: session } })).status, 400);
  const officialDocs = await request(port, `/api/v1/commits/${data.unsafe}/official-docs`, { headers: { Cookie: session } });
  assert.equal(officialDocs.status, 200); assert.equal(JSON.parse(officialDocs.body).data.networkAccessed, false);
  assert.equal((await request(port, `/api/v1/commits/${data.unsafe}/official-docs?url=https://evil.test`, { headers: { Cookie: session } })).status, 400);
});

test('AI POST requires exact origin, CSRF, content type, and bounded requestId body', async (t) => {
  const data = await fixture(); const reader = await openRepository(data.repo);
  const previewProfiles: Array<string | null | undefined> = [];
  const fakeAi = {
    capabilities: () => ({ enabled: true as const, profiles: [{ profileId: 'test', label: 'Test', providerId: 'ollama' as const, endpointOrigin: 'http://127.0.0.1:11434', model: 'test', locality: 'loopback' as const, adapterVersion: 'test-v1', structuredOutput: 'required-native' as const, maxInputBytes: 16384, maxOutputTokens: 1536 }], defaultProfileId: 'test', policy: 'metadata-only' }),
    preview: async (_oid: string, profile: string | null | undefined) => { previewProfiles.push(profile); return { requestId: 'b'.repeat(32) }; },
    execute: async () => ({ explanation: { schemaVersion: '1' as const, summaryJa: 'ok', changes: [], terms: [], risks: [], testObservations: [], limitations: [] }, cache: { hit: false, stored: true }, warning: null }),
    previewGrounded: async () => ({ requestId: 'd'.repeat(32) }),
    executeGrounded: async () => ({ explanation: { schemaVersion: '1' as const, summaryJa: 'ok', changes: [], terms: [], risks: [], testObservations: [], limitations: [], citations: [] }, citationTargets: [], cache: { hit: false, stored: true }, warning: null }),
  };
  const docsRequests: string[] = []; const fakeDocs = { preview: async () => ({ requestId: 'c'.repeat(32), items: [], networkAccessed: false as const, versionDetection: 'unavailable' as const, limits: { pages: 2 as const, rawBytesPerPage: 1048576, excerptBytesPerPage: 4096 } }), execute: async (requestId: string) => { docsRequests.push(requestId); return { documentSetId: null, documentSetExpiresAt: null, documents: [], failures: [] }; }, forAi: async () => ({ generation: 'g1', documents: [], citationTargets: [] }) };
  const viewer = await createViewerServer(reader, { port: 0, limit: 50, token: 'a'.repeat(64), ai: fakeAi as never, docs: fakeDocs }); await viewer.listen();
  t.after(() => viewer.close()); const port = viewer.port ?? 0;
  const login = await request(port, `/?token=${'a'.repeat(64)}`); const session = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const capabilities = await request(port, '/api/v1/ai/capabilities', { headers: { Cookie: session } }); const csrf = JSON.parse(capabilities.body).data.csrfToken as string;
  const base = { Cookie: session, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-GHV-CSRF': csrf };
  assert.equal((await request(port, `/api/v1/commits/${data.unsafe}/explanation-preview?profile=test`, { headers: { Cookie: session } })).status, 200); assert.deepEqual(previewProfiles, ['test']);
  assert.equal((await request(port, `/api/v1/commits/${data.unsafe}/explanation-preview?profile=test&profile=other`, { headers: { Cookie: session } })).status, 400);
  assert.equal((await request(port, `/api/v1/commits/${data.unsafe}/explanation-preview?model=evil`, { headers: { Cookie: session } })).status, 400);
  assert.equal((await request(port, `/api/v1/commits/${data.unsafe}/grounded-explanation-preview?profile=test&documentSetId=${'e'.repeat(32)}`, { headers: { Cookie: session } })).status, 200);
  assert.equal((await request(port, `/api/v1/commits/${data.unsafe}/grounded-explanation-preview?profile=test`, { headers: { Cookie: session } })).status, 400);
  assert.equal((await request(port, '/api/v1/ai/explanations', { method: 'POST', headers: { ...base, Origin: '' }, body: JSON.stringify({ requestId: 'b'.repeat(32) }) })).status, 403);
  assert.equal((await request(port, '/api/v1/ai/explanations', { method: 'POST', headers: { ...base, 'X-GHV-CSRF': 'wrong' }, body: JSON.stringify({ requestId: 'b'.repeat(32) }) })).status, 403);
  assert.equal((await request(port, '/api/v1/ai/explanations', { method: 'POST', headers: { ...base, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await request(port, '/api/v1/ai/explanations', { method: 'POST', headers: { ...base, 'Transfer-Encoding': 'chunked' }, body: 'x'.repeat(1025) })).status, 413);
  assert.equal((await request(port, '/api/v1/ai/explanations', { method: 'POST', headers: base, body: JSON.stringify({ requestId: 'b'.repeat(32), model: 'evil' }) })).status, 400);
  assert.equal((await request(port, '/api/v1/ai/explanations', { method: 'POST', headers: base, body: JSON.stringify({ requestId: 'b'.repeat(32) }) })).status, 200);
  assert.equal((await request(port, '/api/v1/ai/grounded-explanations', { method: 'POST', headers: base, body: JSON.stringify({ requestId: 'd'.repeat(32) }) })).status, 200);
  assert.equal((await request(port, '/api/v1/ai/grounded-explanations', { method: 'POST', headers: base, body: JSON.stringify({ requestId: 'd'.repeat(32), documentSetId: 'evil' }) })).status, 400);
  assert.equal((await request(port, '/api/v1/docs/fetch', { method: 'POST', headers: base, body: JSON.stringify({ requestId: 'c'.repeat(32) }) })).status, 200); assert.deepEqual(docsRequests, ['c'.repeat(32)]);
  assert.equal((await request(port, '/api/v1/docs/fetch', { method: 'POST', headers: { ...base, 'X-GHV-CSRF': 'wrong' }, body: JSON.stringify({ requestId: 'c'.repeat(32) }) })).status, 403);
});
