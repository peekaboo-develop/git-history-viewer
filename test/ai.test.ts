import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileAiCache } from '../src/ai/cache.js';
import { buildAiEvidence } from '../src/ai/evidence.js';
import { OllamaProvider } from '../src/ai/ollama.js';
import { AiExplanationService } from '../src/ai/service.js';
import { openRepository } from '../src/core/repository.js';
import { fixture, git } from './fixture.js';

const explanation = {
  schemaVersion: '1', summaryJa: '変更の要約',
  changes: [{ titleJa: 'ファイル追加', detailJa: 'unsafe.txtを追加しました。', evidencePaths: ['unsafe.txt'] }],
  terms: [], risks: [{ level: 'unknown', rationaleJa: 'パッチ未確認です。', evidencePaths: ['unsafe.txt'] }],
  testObservations: [], limitations: [],
};

function fakeOllama(calls: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3:4b', digest: 'a'.repeat(64) }] }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(explanation) }, done: true }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

test('Ollama provider accepts only numeric loopback and rejects cloud models', () => {
  assert.throws(() => new OllamaProvider({ origin: 'http://localhost:11434', model: 'qwen3:4b' }), /127\.0\.0\.1/u);
  assert.throws(() => new OllamaProvider({ origin: 'https://127.0.0.1:11434', model: 'qwen3:4b' }), /127\.0\.0\.1/u);
  assert.throws(() => new OllamaProvider({ model: 'gpt-oss:120b-cloud' }), /cloud/u);
});

test('AI evidence is metadata-only, bounded, and excludes secret paths', async () => {
  const data = await fixture();
  await writeFile(path.join(data.repo, '.env.test'), 'SECRET=value\n');
  git(data.repo, 'add', '--', '.env.test'); git(data.repo, 'commit', '-m', `mention ${'b'.repeat(40)} https://example.test /Users/alice/private`);
  const oid = git(data.repo, 'rev-parse', 'HEAD'); const reader = await openRepository(data.repo);
  const built = await buildAiEvidence(reader, oid); const raw = JSON.stringify(built.evidence);
  assert.equal(built.includedChanges, 0); assert.ok(built.excludedChanges >= 1); assert.ok(built.inputBytes <= 16 * 1024);
  assert.doesNotMatch(raw, /SECRET=value|\.env\.test|example\.test|\/Users\/alice|b{40}/u);
});

test('preview, explicit execution, and cache coalesce Ollama calls', async () => {
  const data = await fixture(); const reader = await openRepository(data.repo); const calls: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new OllamaProvider({ model: 'qwen3:4b', fetchImpl: fakeOllama(calls) });
  const cache = new FileAiCache(await mkdtemp(path.join(os.tmpdir(), 'ghv-ai-cache-')));
  const service = new AiExplanationService(reader, provider, cache);
  const preview = await service.preview(data.unsafe);
  assert.equal(preview.provider.endpointOrigin, 'http://127.0.0.1:11434'); assert.equal(preview.cacheHit, false);
  const [first, duplicate] = await Promise.all([service.execute(preview.requestId), service.execute(preview.requestId)]);
  assert.equal(first.explanation.summaryJa, '変更の要約'); assert.deepEqual(first, duplicate);
  assert.equal(calls.filter((call) => call.url.endsWith('/api/chat')).length, 1);
  const chat = calls.find((call) => call.url.endsWith('/api/chat')); const request = JSON.parse(String(chat?.init?.body)) as Record<string, unknown>;
  assert.equal(request.stream, false); assert.equal(request.think, false); assert.equal(request.keep_alive, 0); assert.equal(Object.hasOwn(request, 'tools'), false);
  const secondPreview = await service.preview(data.unsafe); assert.equal(secondPreview.cacheHit, true);
  const second = await service.execute(secondPreview.requestId); assert.equal(second.cache.hit, true); assert.equal(calls.filter((call) => call.url.endsWith('/api/chat')).length, 1);
});
