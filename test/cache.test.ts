import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { aiCacheKey, defaultAiCacheRoot, digestAiInput, FileAiCache, type AiCacheRequest } from '../src/ai/cache.js';

function request(input = 'commit subject'): AiCacheRequest {
  return { operation: 'translate', targetLanguage: 'ja', promptVersion: 'translate-v1', provider: 'ollama', model: 'qwen3', exactInputDigest: digestAiInput(input) };
}

async function temporaryCache(t: test.TestContext, limits = {}): Promise<{ root: string; cache: FileAiCache }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'git-history-ai-cache-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'cache');
  return { root, cache: new FileAiCache(root, { pruneIntervalMs: 1_000_000, ...limits }) };
}

test('cache locations follow platform conventions', () => {
  assert.equal(defaultAiCacheRoot('darwin', {}, '/Users/example'), '/Users/example/Library/Caches/git-history-viewer/ai/v1');
  assert.equal(defaultAiCacheRoot('linux', { XDG_CACHE_HOME: '/var/cache/example' }, '/home/example'), '/var/cache/example/git-history-viewer/ai/v1');
  assert.equal(defaultAiCacheRoot('linux', { XDG_CACHE_HOME: 'relative' }, '/home/example'), '/home/example/.cache/git-history-viewer/ai/v1');
  assert.equal(defaultAiCacheRoot('win32', { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' }, 'C:\\Users\\example'), 'C:\\Users\\example\\AppData\\Local\\git-history-viewer\\Cache\\ai\\v1');
  assert.equal(defaultAiCacheRoot('win32', { LOCALAPPDATA: 'relative' }, 'C:\\Users\\example'), 'C:\\Users\\example\\AppData\\Local\\git-history-viewer\\Cache\\ai\\v1');
});

test('cache keys cover the exact request contract', () => {
  const base = request(); const key = aiCacheKey(base);
  assert.match(key, /^[0-9a-f]{64}$/u); assert.equal(aiCacheKey({ ...base }), key);
  assert.notEqual(aiCacheKey({ ...base, model: 'another-model' }), key);
  assert.notEqual(aiCacheKey({ ...base, promptVersion: 'translate-v2' }), key);
  assert.notEqual(aiCacheKey({ ...base, exactInputDigest: digestAiInput('different') }), key);
});

test('split JSON stores only bounded metadata and result with private permissions', async (t) => {
  const { root, cache } = await temporaryCache(t); const source = 'private commit contents'; const cacheRequest = request(source);
  const record = await cache.put(cacheRequest, { translated: '非公開コミット' }); const loaded = await cache.get<{ translated: string }>(record.key);
  assert.equal(loaded?.result.translated, '非公開コミット');
  const filename = path.join(root, record.key.slice(0, 2), `${record.key}.json`); const raw = await readFile(filename, 'utf8');
  assert.doesNotMatch(raw, /private commit contents/u); assert.doesNotMatch(raw, /apiKey|absolutePath|remoteUrl/u);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(root)).mode & 0o777, 0o700); assert.equal((await lstat(filename)).mode & 0o777, 0o600);
  }
});

test('corrupt entries are misses and invalid results are rejected', async (t) => {
  const { root, cache } = await temporaryCache(t, { maxRecordBytes: 1_024 }); const cacheRequest = request(); const key = aiCacheKey(cacheRequest);
  await mkdir(path.join(root, key.slice(0, 2)), { recursive: true }); await writeFile(path.join(root, key.slice(0, 2), `${key}.json`), '{broken');
  assert.equal(await cache.get(key), null);
  await assert.rejects(() => cache.put(cacheRequest, { value: 'x'.repeat(2_000) }), (error: unknown) => (error as { code?: string }).code === 'OUTPUT_LIMIT');
  await assert.rejects(() => cache.put(cacheRequest, { value: undefined }), (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT');
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  await assert.rejects(() => cache.put(cacheRequest, cyclic), (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT');
});

test('concurrent requests share one computation', async (t) => {
  const { cache } = await temporaryCache(t); let calls = 0; const compute = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { translated: '結果' }; };
  const [first, second, third] = await Promise.all([cache.getOrCompute(request(), compute), cache.getOrCompute(request(), compute), cache.getOrCompute(request(), compute)]);
  assert.equal(calls, 1); assert.deepEqual(first.value, second.value); assert.deepEqual(second.value, third.value);
  assert.equal((await cache.getOrCompute(request(), compute)).cacheHit, true); assert.equal(calls, 1);
});

test('prune and clear touch only recognized cache files', async (t) => {
  const { root, cache } = await temporaryCache(t, { maxEntries: 2, maxBytes: 1_000_000 });
  await cache.put(request('one'), { value: 1 }); await cache.put(request('two'), { value: 2 }); await cache.put(request('three'), { value: 3 });
  const ignored = path.join(root, 'do-not-delete.txt'); await writeFile(ignored, 'keep');
  const pruned = await cache.prune(); assert.equal(pruned.removedEntries, 1); assert.equal((await cache.stats()).entries, 2);
  const cleared = await cache.clear(); assert.equal(cleared.removedEntries, 2); assert.equal((await cache.stats()).entries, 0); assert.equal(await readFile(ignored, 'utf8'), 'keep');
});

test('symlinked cache roots are rejected', { skip: process.platform === 'win32' }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'git-history-ai-cache-link-')); t.after(() => rm(base, { recursive: true, force: true }));
  const target = path.join(base, 'target'); const root = path.join(base, 'cache'); await mkdir(target); await chmod(target, 0o700); await symlink(target, root);
  const cache = new FileAiCache(root);
  await assert.rejects(() => cache.put(request(), { translated: '結果' }), (error: unknown) => (error as { code?: string }).code === 'CACHE_FAILED');
  await assert.rejects(() => cache.stats(), (error: unknown) => (error as { code?: string }).code === 'CACHE_FAILED');
  await assert.rejects(() => cache.clear(), (error: unknown) => (error as { code?: string }).code === 'CACHE_FAILED');
});
