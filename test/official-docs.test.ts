import assert from 'node:assert/strict';
import test from 'node:test';
import { extractOfficialText, isPublicAddress, OfficialDocumentFetcher, PinnedHttpsTransport, type FetchTransport } from '../src/docs/fetcher.js';
import { recommendOfficialDocs } from '../src/docs/official.js';
import { OfficialDocsService } from '../src/docs/service.js';
import type { RepositoryReader } from '../src/core/repository.js';
import type { Change } from '../src/schema/types.js';

const change = (path: string, state = 'M'): Change => ({ state, path: { encoding: 'utf8', display: path, rawBase64: null }, oldPath: null, added: 1, deleted: 1 });

test('official documents come only from the fixed registry and remain version-neutral', () => {
  const result = recommendOfficialDocs([change('.github/workflows/ci.yml'), change('vite.config.ts'), change('src/App.vue')]);
  assert.deepEqual(result.map((item) => item.id), ['github-actions', 'vite']);
  assert.ok(result.every((item) => item.url.startsWith('https://') && item.version === null));
});

test('unknown, deleted, and non-UTF8 paths produce no recommendation', () => {
  const nonUtf8: Change = { ...change('ignored'), path: { encoding: 'base64', display: '(non-UTF-8 path)', rawBase64: 'AA==' } };
  assert.deepEqual(recommendOfficialDocs([change('src/plain.js'), change('vite.config.ts', 'D'), nonUtf8]), []);
  assert.deepEqual(recommendOfficialDocs([change('Dockerfile')], 99), []);
});

test('official document transport rejects private and reserved destinations', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.1.1', '192.168.1.1', '192.0.2.1', '192.88.99.1', '224.0.0.1']) assert.equal(isPublicAddress(address, 4), false);
  for (const address of ['::1', '::2', '::7f00:1', 'fc00::1', 'fe80::1', 'fec0::1', 'feff::1', '64:ff9b::808:808', '2001:db8::1', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(address, 6), false);
  assert.equal(isPublicAddress('8.8.8.8', 4), true); assert.equal(isPublicAddress('2606:4700:4700::1111', 6), true);
});

test('HTML extraction uses article content and removes active or navigational elements', () => {
  const text = extractOfficialText('<html><body><nav>ignore nav</nav><main><h1>Guide</h1><script>steal()</script><p>Safe content</p><footer>ignore footer</footer></main></body></html>', 'text/html; charset=utf-8');
  assert.equal(text, 'Guide Safe content'); assert.doesNotMatch(text, /steal|ignore/u);
});

test('fetcher uses only registry URLs and returns bounded extracted text', async () => {
  const urls: string[] = []; const transport: FetchTransport = { fetch: async (url) => { urls.push(url.href); return { status: 200, contentType: 'text/html', contentEncoding: 'identity', body: Buffer.from('<main><p>Official guide</p></main>') }; } };
  const result = await new OfficialDocumentFetcher(transport).fetch('vite');
  assert.deepEqual(urls, ['https://vite.dev/config/']); assert.equal(result.excerpt, 'Official guide');
  await assert.rejects(new OfficialDocumentFetcher(transport).fetch('unknown'), /Unknown official document/u);
});

test('official document transport bounds DNS resolution time', async () => {
  const transport = new PinnedHttpsTransport(() => new Promise(() => undefined), 5);
  await assert.rejects(transport.fetch(new URL('https://vite.dev/config/')), /DNS lookup timed out/u);
});

test('fetcher fails closed for redirects, compression, and unsupported content', async () => {
  const response = { status: 302, contentType: 'text/html', contentEncoding: 'identity', body: Buffer.from('<main>redirect</main>') };
  const transport: FetchTransport = { fetch: async () => response };
  await assert.rejects(new OfficialDocumentFetcher(transport).fetch('vite'), /request was rejected/u);
  response.status = 200; response.contentEncoding = 'gzip';
  await assert.rejects(new OfficialDocumentFetcher(transport).fetch('vite'), /Compressed official documents/u);
  response.contentEncoding = 'identity'; response.contentType = 'application/json';
  await assert.rejects(new OfficialDocumentFetcher(transport).fetch('vite'), /unsupported content type/u);
});

test('docs service binds preview to generation and coalesces duplicate execution', async () => {
  let generation = 'g1'; let calls = 0;
  const reader = { changes: async () => ({ changes: [change('vite.config.ts')] }), generation: async () => generation } as unknown as RepositoryReader;
  const fetcher = { fetch: async (id: string) => { calls++; return { id, title: 'Vite config reference', url: 'https://vite.dev/config/', fetchedAt: new Date(0).toISOString(), excerpt: 'guide', byteCount: 5 }; } } as OfficialDocumentFetcher;
  const service = new OfficialDocsService(reader, fetcher); const preview = await service.preview('a'.repeat(40)); assert.equal(preview.networkAccessed, false); assert.ok(preview.requestId);
  const [first, duplicate] = await Promise.all([service.execute(preview.requestId!), service.execute(preview.requestId!)]); assert.deepEqual(first, duplicate); assert.equal(calls, 1);
  const stale = await service.preview('a'.repeat(40)); generation = 'g2'; await assert.rejects(service.execute(stale.requestId!), /state changed/u);
});

test('docs service serializes outbound fetches across request IDs', async () => {
  let active = 0; let maximum = 0;
  const reader = { changes: async () => ({ changes: [change('Dockerfile'), change('vite.config.ts')] }), generation: async () => 'g1' } as unknown as RepositoryReader;
  const fetcher = { fetch: async (id: string) => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 5)); active--; return { id, title: id, url: 'https://docs.example.invalid/', fetchedAt: new Date(0).toISOString(), excerpt: 'guide', byteCount: 5 }; } } as OfficialDocumentFetcher;
  const service = new OfficialDocsService(reader, fetcher); const first = await service.preview('a'.repeat(40)); const second = await service.preview('a'.repeat(40));
  await Promise.all([service.execute(first.requestId!), service.execute(second.requestId!)]); assert.equal(maximum, 1);
});

test('docs service rejects an unstable preview generation', async () => {
  let generationCall = 0;
  const reader = { changes: async () => ({ changes: [change('vite.config.ts')] }), generation: async () => `g${++generationCall}` } as unknown as RepositoryReader;
  await assert.rejects(new OfficialDocsService(reader).preview('a'.repeat(40)), /state changed while preparing/u);
});

test('docs service caps scheduled fetches', async () => {
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  const reader = { changes: async () => ({ changes: [change('vite.config.ts')] }), generation: async () => 'g1' } as unknown as RepositoryReader;
  const fetcher = { fetch: async (id: string) => { await blocked; return { id, title: id, url: 'https://vite.dev/config/', fetchedAt: new Date(0).toISOString(), excerpt: 'guide', byteCount: 5 }; } } as OfficialDocumentFetcher;
  const service = new OfficialDocsService(reader, fetcher); const previews = await Promise.all(Array.from({ length: 6 }, () => service.preview('a'.repeat(40))));
  const accepted = previews.slice(0, 5).map((preview) => service.execute(preview.requestId!));
  await assert.rejects(service.execute(previews[5]!.requestId!), /queue is full/u); release(); await Promise.all(accepted);
});

test('docs service rechecks consent expiry after queueing', async () => {
  let now = 0; let release!: () => void; let markStarted!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { markStarted = resolve; }); let calls = 0;
  const reader = { changes: async () => ({ changes: [change('vite.config.ts')] }), generation: async () => 'g1' } as unknown as RepositoryReader;
  const fetcher = { fetch: async (id: string) => { calls++; if (calls === 1) { markStarted(); await blocked; } return { id, title: id, url: 'https://vite.dev/config/', fetchedAt: new Date(0).toISOString(), excerpt: 'guide', byteCount: 5 }; } } as OfficialDocumentFetcher;
  const service = new OfficialDocsService(reader, fetcher, { now: () => now, ttlMs: 10 }); const first = await service.preview('a'.repeat(40)); const second = await service.preview('a'.repeat(40));
  const running = service.execute(first.requestId!); const waiting = service.execute(second.requestId!); const rejected = assert.rejects(waiting, /expired while waiting/u);
  await started; now = 11; release(); await running; await rejected; assert.equal(calls, 1);
});

test('docs service rejects repository changes during a fetch', async () => {
  let generation = 'g1';
  const reader = { changes: async () => ({ changes: [change('vite.config.ts')] }), generation: async () => generation } as unknown as RepositoryReader;
  const fetcher = { fetch: async (id: string) => { generation = 'g2'; return { id, title: id, url: 'https://vite.dev/config/', fetchedAt: new Date(0).toISOString(), excerpt: 'guide', byteCount: 5 }; } } as OfficialDocumentFetcher;
  const service = new OfficialDocsService(reader, fetcher); const preview = await service.preview('a'.repeat(40));
  await assert.rejects(service.execute(preview.requestId!), /state changed during/u);
});
