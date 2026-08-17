import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AnthropicProvider } from '../src/ai/anthropic.js';
import { FileAiCache } from '../src/ai/cache.js';
import { buildAiEvidence } from '../src/ai/evidence.js';
import { OllamaProvider } from '../src/ai/ollama.js';
import { OpenAiProvider } from '../src/ai/openai.js';
import { AiServiceRegistry } from '../src/ai/registry.js';
import { AiExplanationService } from '../src/ai/service.js';
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
    notice: () => 'test',
    generate: async () => { generated.push(profileId); return { ...explanation, limitations: [] }; },
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
