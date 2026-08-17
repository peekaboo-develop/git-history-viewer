import { ViewerError } from '../core/errors.js';
import type { AiEvidenceSummary, AiExplanation } from '../schema/types.js';
import { AI_OUTPUT_SCHEMA, AI_PROMPT_VERSION, AI_SYSTEM_PROMPT, validateExplanation } from './explanation-schema.js';
import type { AiProvider, AiProviderDescriptor } from './provider.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ViewerError('PROVIDER_OUTPUT_LIMIT', 'The AI provider response is too large.'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export interface OllamaProviderOptions { profileId?: string; label?: string; origin?: string; model: string; maxOutputTokens?: number; timeoutMs?: number; fetchImpl?: typeof fetch }

export class OllamaProvider implements AiProvider {
  readonly id = 'ollama-loopback'; readonly origin: string; readonly model: string;
  readonly descriptor: AiProviderDescriptor;
  private readonly timeoutMs: number; private readonly fetchImpl: typeof fetch;
  constructor(options: OllamaProviderOptions) {
    const url = new URL(options.origin ?? 'http://127.0.0.1:11434');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port) throw new ViewerError('INVALID_ARGUMENT', 'Ollama origin must be http://127.0.0.1:PORT.');
    if (!options.model || options.model.length > 160 || /[\u0000-\u001f\u007f]/u.test(options.model)) throw new ViewerError('INVALID_ARGUMENT', 'Ollama model is invalid.');
    if (/(?:^|[:_-])cloud(?:$|[:_-])/iu.test(options.model)) throw new ViewerError('INVALID_ARGUMENT', 'Ollama cloud models are not supported.');
    const profileId = options.profileId ?? 'ollama-default'; const label = options.label ?? options.model; const maxOutputTokens = options.maxOutputTokens ?? 1536;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(profileId)) throw new ViewerError('INVALID_ARGUMENT', 'AI profile ID is invalid.');
    if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) throw new ViewerError('INVALID_ARGUMENT', 'AI profile label is invalid.');
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 8192) throw new ViewerError('INVALID_ARGUMENT', 'AI maxOutputTokens must be between 128 and 8192.');
    this.origin = url.origin; this.model = options.model; this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS; this.fetchImpl = options.fetchImpl ?? fetch;
    this.descriptor = { profileId, label, providerId: 'ollama', model: this.model, locality: 'loopback', endpointOrigin: this.origin, adapterVersion: 'ollama-v1', structuredOutput: 'required-native', maxInputBytes: 16 * 1024, maxOutputTokens };
  }
  private async call(path: '/api/tags' | '/api/chat', init: RequestInit): Promise<unknown> {
    try {
      const response = await this.fetchImpl(`${this.origin}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw new ViewerError('PROVIDER_UNAVAILABLE', 'The Ollama provider is unavailable.', { retryable: true, details: { status: response.status } });
      const raw = await readBounded(response);
      try { return JSON.parse(raw) as unknown; } catch { throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'The Ollama provider returned non-JSON output.'); }
    } catch (error) {
      if (error instanceof ViewerError) throw error;
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') throw new ViewerError('PROVIDER_TIMEOUT', 'The Ollama provider timed out.', { retryable: true });
      throw new ViewerError('PROVIDER_UNAVAILABLE', 'The Ollama provider is unavailable.', { retryable: true, cause: error });
    }
  }
  async revision(): Promise<string> {
    const value = await this.call('/api/tags', { method: 'GET' });
    if (!record(value) || !Array.isArray(value.models)) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Ollama returned an invalid model list.');
    const found = value.models.find((item) => record(item) && (item.name === this.model || item.model === this.model));
    if (!record(found) || typeof found.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(found.digest)) throw new ViewerError('PROVIDER_MODEL_NOT_FOUND', 'The configured Ollama model is not installed.');
    return found.digest;
  }
  cacheIdentity(): Promise<string> { return this.revision(); }
  notice(): string { return 'Ollama endpoint is loopback, but execution location still depends on your Ollama model and configuration.'; }
  canonicalRequest(evidence: AiEvidenceSummary, cacheIdentity: string): unknown {
    return { promptVersion: AI_PROMPT_VERSION, provider: this.descriptor.providerId, adapterVersion: this.descriptor.adapterVersion, model: this.model, cacheIdentity, system: AI_SYSTEM_PROMPT, evidence, schema: AI_OUTPUT_SCHEMA, settings: { temperature: 0, maxOutputTokens: this.descriptor.maxOutputTokens, think: false } };
  }
  request(evidence: AiEvidenceSummary): Record<string, unknown> {
    return { model: this.model, messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(evidence) }], format: AI_OUTPUT_SCHEMA, stream: false, think: false, keep_alive: 0, options: { temperature: 0, num_predict: this.descriptor.maxOutputTokens } };
  }
  async generate(evidence: AiEvidenceSummary): Promise<AiExplanation> {
    const body = JSON.stringify(this.request(evidence));
    if (Buffer.byteLength(body) > 32 * 1024) throw new ViewerError('OUTPUT_LIMIT', 'The AI provider request is too large.');
    const value = await this.call('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!record(value) || !record(value.message) || typeof value.message.content !== 'string') throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Ollama returned an invalid chat response.');
    let parsed: unknown; try { parsed = JSON.parse(value.message.content); } catch { throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Ollama returned invalid structured output.'); }
    return validateExplanation(parsed, new Set(evidence.changes.flatMap((item) => item.oldPath ? [item.path, item.oldPath] : [item.path])));
  }
}
