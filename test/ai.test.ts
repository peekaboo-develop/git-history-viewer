import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AnthropicProvider } from '../src/ai/anthropic.js';
import { FileAiCache } from '../src/ai/cache.js';
import { buildAiEvidence } from '../src/ai/evidence.js';
import { GoogleProvider, toGeminiJsonSchema } from '../src/ai/google.js';
import { OllamaProvider } from '../src/ai/ollama.js';
import { OpenAiProvider } from '../src/ai/openai.js';
import { AiServiceRegistry } from '../src/ai/registry.js';
import { AiExplanationService } from '../src/ai/service.js';
import { GroundedAiExplanationService } from '../src/ai/grounding.js';
import { AiExecutionQueue } from '../src/ai/queue.js';
import type { AiProvider } from '../src/ai/provider.js';
import { ViewerError } from '../src/core/errors.js';
import { openRepository } from '../src/core/repository.js';
import { fixture, git } from './fixture.js';

const explanation = {
  schemaVersion: '1' as const, summaryJa: '変更の要約',
  changes: [{ titleJa: 'ファイル追加', detailJa: 'unsafe.txtを追加しました。', evidencePaths: ['unsafe.txt'] }],
  terms: [], risks: [{ level: 'unknown' as const, rationaleJa: 'パッチ未確認です。', evidencePaths: ['unsafe.txt'] }],
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

test('AI registry binds preview request IDs to the selected profile', async () => {
  const data = await fixture(); const reader = await openRepository(data.repo); const generated: string[] = [];
  const makeProvider = (profileId: string): AiProvider => ({
    descriptor: { profileId, label: profileId, providerId: 'ollama', model: profileId, locality: 'loopback', endpointOrigin: 'http://127.0.0.1:11434', adapterVersion: 'test-v1', structuredOutput: 'required-native', maxInputBytes: 16 * 1024, maxOutputTokens: 1536 },
    cacheIdentity: async () => `identity-${profileId}`,
    canonicalRequest: (evidence, identity) => ({ evidence, identity }),
    canonicalGroundedRequest: (evidence, identity) => ({ evidence, identity, grounded: true }),
    notice: () => 'test',
    generate: async () => { generated.push(profileId); return { ...explanation, limitations: [] }; },
    generateGrounded: async () => ({ ...explanation, limitations: [], citations: [] }),
  });
  const first = new AiExplanationService(reader, makeProvider('first'), undefined, false); const second = new AiExplanationService(reader, makeProvider('second'), undefined, false);
  const registry = new AiServiceRegistry([first, second], 'first');
  assert.deepEqual(registry.capabilities().profiles.map((profile) => profile.profileId), ['first', 'second']);
  const preview = await registry.preview(data.unsafe, 'second'); assert.equal(preview.provider.profileId, 'second');
  await registry.execute(preview.requestId); assert.deepEqual(generated, ['second']);
  await assert.rejects(registry.preview(data.unsafe, 'missing'), /Unknown AI profile/u);
});

test('OpenAI provider uses fixed Responses endpoint and performs no preview network call', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(explanation) }] }] }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const provider = new OpenAiProvider({ profileId: 'openai-test', label: 'OpenAI test', model: 'gpt-5.4-mini', apiKey: 'sk-test-secret', fetchImpl });
  assert.equal(await provider.cacheIdentity(), 'openai-responses-v1:gpt-5.4-mini'); assert.equal(calls.length, 0);
  const result = await provider.generate({ subject: 'test', body: '', comparison: 'first-parent', changes: [{ state: 'A', path: 'unsafe.txt', oldPath: null, added: 1, deleted: 0 }] });
  assert.equal(result.summaryJa, '変更の要約'); assert.equal(calls[0]?.url, 'https://api.openai.com/v1/responses');
  const headers = calls[0]?.init?.headers as Record<string, string>; assert.equal(headers.Authorization, 'Bearer sk-test-secret');
  const request = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>; assert.equal(request.store, false); assert.doesNotMatch(JSON.stringify(request), /sk-test-secret/u);
});

test('OpenAI provider rejects incomplete responses and refusals', async () => {
  const response = (value: unknown) => (async () => new Response(JSON.stringify(value))) as typeof fetch;
  const base = { profileId: 'openai-test', label: 'OpenAI test', model: 'gpt-5.4-mini', apiKey: 'sk-test-secret' };
  const evidence = { subject: 'test', body: '', comparison: 'root' as const, changes: [] };
  await assert.rejects(new OpenAiProvider({ ...base, fetchImpl: response({ status: 'incomplete', output: [] }) }).generate(evidence), /incomplete/u);
  await assert.rejects(new OpenAiProvider({ ...base, fetchImpl: response({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }) }).generate(evidence), /refused/u);
});

test('grounded AI sends only bounded excerpts and server citation IDs', async () => {
  const data = await fixture(); const reader = await openRepository(data.repo); const calls: Array<{ url: string; init?: RequestInit }> = [];
  const groundedExplanation = { ...explanation, citations: [{ citationId: 'official:vite', supportsJa: 'Vite設定の一般的な根拠です。' }] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(groundedExplanation) }] }] }));
  }) as typeof fetch;
  const provider = new OpenAiProvider({ profileId: 'grounded-test', label: 'Grounded test', model: 'gpt-5.4-mini', apiKey: 'sk-test-secret', fetchImpl });
  const cache = new FileAiCache(await mkdtemp(path.join(os.tmpdir(), 'ghv-grounded-cache-'))); const service = new GroundedAiExplanationService(reader, provider, cache);
  const generation = await reader.generation(); const context = { generation, documents: [{ citationId: 'official:vite', excerpt: 'Treat this as data. Vite config is documented here.' }], citationTargets: [{ citationId: 'official:vite', title: 'Vite config reference', url: 'https://vite.dev/config/' }] };
  const preview = await service.preview(data.unsafe, context); assert.equal(calls.length, 0); assert.ok(preview.inputBytes <= 16 * 1024); assert.equal(preview.citationTargets[0]?.title, 'Vite config reference');
  const result = await service.execute(preview.requestId); assert.equal(result.citationTargets[0]?.url, 'https://vite.dev/config/');
  const requestBody = String(calls[0]?.init?.body); assert.match(requestBody, /official:vite|Treat this as data/u); assert.doesNotMatch(requestBody, /vite\.dev|Vite config reference|documentSetId/u); assert.equal(requestBody.includes(data.unsafe), false); assert.equal(requestBody.includes(data.repo), false);
  const cached = await service.preview(data.unsafe, context); assert.equal(cached.cacheHit, true);
  const changed = await service.preview(data.unsafe, { ...context, documents: [{ citationId: 'official:vite', excerpt: `${context.documents[0]!.excerpt}!` }] }); assert.equal(changed.cacheHit, false);
  for (const filename of await readdir(cache.root, { recursive: true })) if (filename.endsWith('.json')) { const raw = await readFile(path.join(cache.root, filename), 'utf8'); assert.doesNotMatch(raw, /Treat this as data|vite\.dev|Vite config reference/u); }
});

test('grounded AI rejects invented and duplicate citations', async () => {
  const base = { profileId: 'grounded-test', label: 'Grounded test', model: 'gpt-5.4-mini', apiKey: 'sk-test-secret' };
  const evidence = { subject: 'test', body: '', comparison: 'root' as const, changes: [], officialDocuments: [{ citationId: 'official:vite', excerpt: 'guide' }] };
  const response = (citations: unknown[]) => (async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...explanation, changes: [], risks: [], citations }) }] }] }))) as typeof fetch;
  await assert.rejects(new OpenAiProvider({ ...base, fetchImpl: response([{ citationId: 'official:fake', supportsJa: 'fake' }]) }).generateGrounded(evidence), /unavailable official document/u);
  await assert.rejects(new OpenAiProvider({ ...base, fetchImpl: response([{ citationId: 'official:vite', supportsJa: 'one' }, { citationId: 'official:vite', supportsJa: 'two' }]) }).generateGrounded(evidence), /unavailable official document/u);
});

test('grounded cache hit rechecks repository generation after reading', async () => {
  const data = await fixture(); const baseReader = await openRepository(data.repo); let generation = 'g1';
  const reader = { generation: async () => generation, commit: baseReader.commit.bind(baseReader), changes: baseReader.changes.bind(baseReader) } as unknown as typeof baseReader;
  const cachedValue = { ...explanation, citations: [{ citationId: 'official:vite', supportsJa: 'guide' }] }; let reads = 0;
  const cache = { stats: async () => ({ entries: 1, bytes: 1, oldestModifiedAt: null, newestModifiedAt: null }), get: async () => { reads++; generation = 'g2'; return { result: cachedValue }; } } as unknown as FileAiCache;
  const provider = new OpenAiProvider({ profileId: 'grounded-test', label: 'Grounded', model: 'gpt-5.4-mini', apiKey: 'sk-test-secret', fetchImpl: (async () => { throw new Error('provider must not run'); }) as typeof fetch });
  const service = new GroundedAiExplanationService(reader, provider, cache); const context = { generation: 'g1', documents: [{ citationId: 'official:vite', excerpt: 'guide' }], citationTargets: [] };
  const preview = await service.preview(data.unsafe, context); assert.equal(reads, 1); generation = 'g1';
  await assert.rejects(service.execute(preview.requestId), /changed while reading/u); assert.equal(reads, 2);
});

test('all provider adapters keep citation targets out of grounded requests', () => {
  const evidence = { subject: 'test', body: '', comparison: 'root' as const, changes: [], officialDocuments: [{ citationId: 'official:vite', excerpt: 'UNTRUSTED_DOC_EXCERPT' }] };
  const providers = [
    new OllamaProvider({ model: 'qwen3:4b' }),
    new OpenAiProvider({ profileId: 'openai-test', label: 'OpenAI', model: 'gpt-5.4-mini', apiKey: 'sk-test-secret' }),
    new AnthropicProvider({ profileId: 'anthropic-test', label: 'Anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-test-secret' }),
    new GoogleProvider({ profileId: 'google-test', label: 'Google', model: 'gemini-2.5-flash', apiKey: 'google-test-secret' }),
  ];
  const requests = [providers[0]!.groundedRequest(evidence), providers[1]!.groundedRequest(evidence), providers[2]!.groundedRequest(evidence), providers[3]!.groundedRequest(evidence)];
  for (const request of requests) { const raw = JSON.stringify(request); assert.match(raw, /official:vite/u); assert.match(raw, /UNTRUSTED_DOC_EXCERPT/u); assert.doesNotMatch(raw, /vite\.dev|Vite config reference|documentSetId/u); }
});

test('all grounded adapters accept escape-heavy evidence within the 16 KiB preview budget', async () => {
  const escaped = '\\"'.repeat(1900); const evidence = { subject: 'test', body: '', comparison: 'root' as const, changes: [], officialDocuments: [{ citationId: 'official:vite', excerpt: escaped }, { citationId: 'official:typescript', excerpt: escaped }] };
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 16 * 1024); const output = { ...explanation, changes: [], risks: [], citations: [] }; const bodies: string[] = [];
  const capture = (value: unknown) => (async (_input: string | URL | Request, init?: RequestInit) => { bodies.push(String(init?.body)); return new Response(JSON.stringify(value)); }) as typeof fetch;
  const providers = [
    new OllamaProvider({ model: 'qwen3:4b', fetchImpl: capture({ message: { content: JSON.stringify(output) } }) }),
    new OpenAiProvider({ profileId: 'openai-wire', label: 'OpenAI', model: 'gpt-5.4-mini', apiKey: 'sk-test-secret', fetchImpl: capture({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }) }),
    new AnthropicProvider({ profileId: 'anthropic-wire', label: 'Anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-test-secret', fetchImpl: capture({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }] }) }),
    new GoogleProvider({ profileId: 'google-wire', label: 'Google', model: 'gemini-2.5-flash', apiKey: 'google-test-secret', fetchImpl: capture({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(output) }] } }] }) }),
  ];
  for (const provider of providers) await provider.generateGrounded(evidence);
  assert.equal(bodies.length, 4); for (const body of bodies) assert.ok(Buffer.byteLength(body) <= 48 * 1024);
});

test('metadata and grounded requests share one provider execution queue', async () => {
  const data = await fixture(); const reader = await openRepository(data.repo); let active = 0; let maximum = 0; let release!: () => void; let markStarted!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const provider: AiProvider = {
    descriptor: { profileId: 'shared', label: 'Shared', providerId: 'openai', model: 'test', locality: 'remote', endpointOrigin: 'https://api.openai.com', adapterVersion: 'test-v1', structuredOutput: 'required-native', maxInputBytes: 16 * 1024, maxOutputTokens: 1536 },
    cacheIdentity: async () => 'test-v1:test', notice: () => 'test', canonicalRequest: (value) => value, canonicalGroundedRequest: (value) => value,
    generate: async () => { active++; maximum = Math.max(maximum, active); markStarted(); await blocked; active--; return { ...explanation, limitations: [] }; },
    generateGrounded: async () => { active++; maximum = Math.max(maximum, active); active--; return { ...explanation, limitations: [], citations: [] }; },
  };
  const metadata = new AiExplanationService(reader, provider, undefined, false); const grounded = metadata.createGroundedService(); const generation = await reader.generation();
  const metadataPreview = await metadata.preview(data.unsafe); const groundedPreview = await grounded.preview(data.unsafe, { generation, documents: [{ citationId: 'official:vite', excerpt: 'guide' }], citationTargets: [] });
  const first = metadata.execute(metadataPreview.requestId); await started; const second = grounded.execute(groundedPreview.requestId); release(); await Promise.all([first, second]); assert.equal(maximum, 1);
});

test('AI registry serializes different provider profiles globally', async () => {
  const data = await fixture(); const reader = await openRepository(data.repo); let active = 0; let maximum = 0; let release!: () => void; let markStarted!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const make = (profileId: string, block: boolean): AiProvider => ({
    descriptor: { profileId, label: profileId, providerId: 'openai', model: profileId, locality: 'remote', endpointOrigin: 'https://api.openai.com', adapterVersion: 'test-v1', structuredOutput: 'required-native', maxInputBytes: 16 * 1024, maxOutputTokens: 1536 },
    cacheIdentity: async () => profileId, notice: () => 'test', canonicalRequest: (value) => value, canonicalGroundedRequest: (value) => value,
    generate: async () => { active++; maximum = Math.max(maximum, active); if (block) { markStarted(); await blocked; } active--; return { ...explanation, limitations: [] }; },
    generateGrounded: async () => ({ ...explanation, limitations: [], citations: [] }),
  });
  const first = new AiExplanationService(reader, make('first', true), undefined, false); const second = new AiExplanationService(reader, make('second', false), undefined, false); const registry = new AiServiceRegistry([first, second], 'first');
  const firstPreview = await registry.preview(data.unsafe, 'first'); const secondPreview = await registry.preview(data.unsafe, 'second'); const running = registry.execute(firstPreview.requestId); await started; const waiting = registry.execute(secondPreview.requestId); release(); await Promise.all([running, waiting]); assert.equal(maximum, 1);
});

test('metadata AI rechecks consent expiry after shared queue wait', async () => {
  const data = await fixture(); const reader = await openRepository(data.repo); const queue = new AiExecutionQueue(); let now = 0; let release!: () => void; let markStarted!: () => void; let secondCalls = 0;
  const blocked = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const make = (profileId: string, block: boolean): AiProvider => ({
    descriptor: { profileId, label: profileId, providerId: 'openai', model: profileId, locality: 'remote', endpointOrigin: 'https://api.openai.com', adapterVersion: 'test-v1', structuredOutput: 'required-native', maxInputBytes: 16 * 1024, maxOutputTokens: 1536 },
    cacheIdentity: async () => profileId, notice: () => 'test', canonicalRequest: (value) => value, canonicalGroundedRequest: (value) => value,
    generate: async () => { if (block) { markStarted(); await blocked; } else secondCalls++; return { ...explanation, limitations: [] }; }, generateGrounded: async () => ({ ...explanation, limitations: [], citations: [] }),
  });
  const first = new AiExplanationService(reader, make('first', true), undefined, false, queue, () => now, 10); const second = new AiExplanationService(reader, make('second', false), undefined, false, queue, () => now, 10);
  const firstPreview = await first.preview(data.unsafe); const secondPreview = await second.preview(data.unsafe); const running = first.execute(firstPreview.requestId); await started; const expired = second.execute(secondPreview.requestId); const rejected = assert.rejects(expired, /expired while waiting/u); now = 10; release(); await running; await rejected; assert.equal(secondCalls, 0);
});

test('Anthropic provider uses fixed Messages API contract and performs no preview network call', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(explanation) }] }));
  }) as typeof fetch;
  const provider = new AnthropicProvider({ profileId: 'claude-test', label: 'Claude test', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-test-secret', fetchImpl });
  assert.equal(await provider.cacheIdentity(), 'anthropic-messages-2023-06-01-v1:claude-sonnet-4-6'); assert.equal(calls.length, 0);
  const evidence = { subject: 'test', body: '', comparison: 'first-parent' as const, changes: [{ state: 'A', path: 'unsafe.txt', oldPath: null, added: 1, deleted: 0 }] };
  const result = await provider.generate(evidence); assert.equal(result.summaryJa, '変更の要約'); assert.equal(calls[0]?.url, 'https://api.anthropic.com/v1/messages');
  const headers = calls[0]?.init?.headers as Record<string, string>; assert.equal(headers['x-api-key'], 'sk-ant-test-secret'); assert.equal(headers['anthropic-version'], '2023-06-01');
  const request = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>; assert.equal(typeof request.system, 'string'); assert.equal(Object.hasOwn(request, 'tools'), false); assert.doesNotMatch(JSON.stringify(request), /sk-ant-test-secret/u);
  assert.deepEqual((provider.canonicalRequest(evidence, 'identity') as { request: unknown }).request, request);
});

test('Anthropic provider rejects stop reasons and unexpected content', async () => {
  const response = (value: unknown) => (async () => new Response(JSON.stringify(value))) as typeof fetch;
  const base = { profileId: 'claude-test', label: 'Claude test', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-test-secret' };
  const evidence = { subject: 'test', body: '', comparison: 'root' as const, changes: [] };
  for (const reason of ['max_tokens', 'model_context_window_exceeded']) await assert.rejects(new AnthropicProvider({ ...base, fetchImpl: response({ type: 'message', role: 'assistant', stop_reason: reason, content: [] }) }).generate(evidence), (error: unknown) => error instanceof ViewerError && error.code === 'PROVIDER_OUTPUT_LIMIT');
  for (const reason of ['refusal', 'tool_use', 'pause_turn', 'stop_sequence']) await assert.rejects(new AnthropicProvider({ ...base, fetchImpl: response({ type: 'message', role: 'assistant', stop_reason: reason, content: [{ type: 'text', text: 'no' }] }) }).generate(evidence), (error: unknown) => error instanceof ViewerError && error.code === 'PROVIDER_OUTPUT_INVALID');
  await assert.rejects(new AnthropicProvider({ ...base, fetchImpl: response({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] }) }).generate(evidence), /unexpected content/u);
});

test('Anthropic provider classifies HTTP failures without exposing response bodies', async () => {
  const base = { profileId: 'claude-test', label: 'Claude test', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-test-secret' }; const evidence = { subject: 'test', body: '', comparison: 'root' as const, changes: [] };
  const expected: Array<[number, string, boolean]> = [[400, 'PROVIDER_UNAVAILABLE', false], [401, 'PROVIDER_UNAVAILABLE', false], [404, 'PROVIDER_MODEL_NOT_FOUND', false], [408, 'PROVIDER_TIMEOUT', true], [413, 'OUTPUT_LIMIT', false], [429, 'PROVIDER_UNAVAILABLE', true], [529, 'PROVIDER_UNAVAILABLE', true]];
  for (const [status, code, retryable] of expected) await assert.rejects(new AnthropicProvider({ ...base, fetchImpl: (async () => new Response('secret provider body', { status })) as typeof fetch }).generate(evidence), (error: unknown) => error instanceof ViewerError && error.code === code && error.retryable === retryable && !error.message.includes('secret provider body'));
});

test('Google provider uses fixed GenerateContent contract and performs no preview network call', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(explanation) }] } }] }));
  }) as typeof fetch;
  const provider = new GoogleProvider({ profileId: 'gemini-test', label: 'Gemini test', model: 'gemini-2.5-flash', apiKey: 'google-test-secret', fetchImpl });
  assert.equal(await provider.cacheIdentity(), 'gemini-generate-content-v1beta-response-json-schema-v1:gemini-2.5-flash'); assert.equal(calls.length, 0);
  const evidence = { subject: 'test', body: '', comparison: 'first-parent' as const, changes: [{ state: 'A', path: 'unsafe.txt', oldPath: null, added: 1, deleted: 0 }] };
  const result = await provider.generate(evidence); assert.equal(result.summaryJa, '変更の要約');
  assert.equal(calls[0]?.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  const headers = calls[0]?.init?.headers as Record<string, string>; assert.equal(headers['x-goog-api-key'], 'google-test-secret');
  const request = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>; assert.equal(request.store, false); assert.equal(Object.hasOwn(request, 'tools'), false); assert.doesNotMatch(JSON.stringify(request), /google-test-secret/u);
  assert.deepEqual((provider.canonicalRequest(evidence, 'identity') as { request: unknown }).request, request);
});

test('Google schema conversion is non-mutating and rejects unsupported keywords', () => {
  const source = { type: 'object', properties: { version: { const: '1' }, level: { enum: ['low', 'high'] } }, required: ['version', 'level'] };
  const before = JSON.stringify(source); const converted = toGeminiJsonSchema(source);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual((converted.properties as Record<string, unknown>).version, { type: 'string', enum: ['1'] });
  assert.deepEqual((converted.properties as Record<string, unknown>).level, { enum: ['low', 'high'], type: 'string' });
  assert.deepEqual(converted.propertyOrdering, ['version', 'level']); assert.equal(converted.additionalProperties, false);
  assert.throws(() => toGeminiJsonSchema({ type: 'string', pattern: '.*' }), /unsupported Gemini keyword/u);
});

test('Google provider rejects hostile model paths, blocked prompts, and incomplete candidates', async () => {
  const base = { profileId: 'gemini-test', label: 'Gemini test', model: 'gemini-2.5-flash', apiKey: 'google-test-secret' };
  for (const model of ['models/gemini-2.5-flash', '../secret', 'gemini:latest', 'gemini?key=secret', 'gemini%2Fother']) assert.throws(() => new GoogleProvider({ ...base, model }), /bare model ID/u);
  const response = (value: unknown) => (async () => new Response(JSON.stringify(value))) as typeof fetch; const evidence = { subject: 'test', body: '', comparison: 'root' as const, changes: [] };
  await assert.rejects(new GoogleProvider({ ...base, fetchImpl: response({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }) }).generate(evidence), /blocked/u);
  await assert.rejects(new GoogleProvider({ ...base, fetchImpl: response({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }) }).generate(evidence), (error: unknown) => error instanceof ViewerError && error.code === 'PROVIDER_OUTPUT_LIMIT');
  for (const reason of ['SAFETY', 'RECITATION', 'OTHER', 'MALFORMED_FUNCTION_CALL']) await assert.rejects(new GoogleProvider({ ...base, fetchImpl: response({ candidates: [{ finishReason: reason, content: { parts: [] } }] }) }).generate(evidence), (error: unknown) => error instanceof ViewerError && error.code === 'PROVIDER_OUTPUT_INVALID');
  await assert.rejects(new GoogleProvider({ ...base, fetchImpl: response({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }, { text: '{}' }] } }] }) }).generate(evidence), /unexpected content/u);
});

test('Google provider classifies HTTP failures without exposing response bodies', async () => {
  const base = { profileId: 'gemini-test', label: 'Gemini test', model: 'gemini-2.5-flash', apiKey: 'google-test-secret' }; const evidence = { subject: 'test', body: '', comparison: 'root' as const, changes: [] };
  const expected: Array<[number, string, boolean]> = [[400, 'PROVIDER_UNAVAILABLE', false], [403, 'PROVIDER_UNAVAILABLE', false], [404, 'PROVIDER_MODEL_NOT_FOUND', false], [408, 'PROVIDER_TIMEOUT', true], [413, 'OUTPUT_LIMIT', false], [429, 'PROVIDER_UNAVAILABLE', true], [503, 'PROVIDER_UNAVAILABLE', true]];
  for (const [status, code, retryable] of expected) await assert.rejects(new GoogleProvider({ ...base, fetchImpl: (async () => new Response('secret provider body', { status })) as typeof fetch }).generate(evidence), (error: unknown) => error instanceof ViewerError && error.code === code && error.retryable === retryable && !error.message.includes('secret provider body'));
});
