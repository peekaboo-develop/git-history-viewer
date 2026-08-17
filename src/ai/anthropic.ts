import { ViewerError } from '../core/errors.js';
import type { AiEvidenceSummary, AiExplanation } from '../schema/types.js';
import { AI_OUTPUT_SCHEMA, AI_PROMPT_VERSION, AI_SYSTEM_PROMPT, validateExplanation } from './explanation-schema.js';
import type { AiProvider, AiProviderDescriptor } from './provider.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ViewerError('PROVIDER_OUTPUT_LIMIT', 'The Anthropic response is too large.'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

function httpError(status: number): ViewerError {
  const details = { status };
  if (status === 404) return new ViewerError('PROVIDER_MODEL_NOT_FOUND', 'The configured Anthropic model is unavailable.', { details });
  if (status === 408 || status === 504) return new ViewerError('PROVIDER_TIMEOUT', 'The Anthropic provider timed out.', { retryable: true, details });
  if (status === 413) return new ViewerError('OUTPUT_LIMIT', 'The Anthropic provider request is too large.', { details });
  const retryable = status === 409 || status === 429 || status === 529 || status >= 500;
  return new ViewerError('PROVIDER_UNAVAILABLE', 'The Anthropic provider rejected the request.', { retryable, details });
}

export interface AnthropicProviderOptions { profileId: string; label: string; model: string; apiKey: string; maxOutputTokens?: number; timeoutMs?: number; fetchImpl?: typeof fetch }

export class AnthropicProvider implements AiProvider {
  readonly descriptor: AiProviderDescriptor;
  private readonly apiKey: string; private readonly timeoutMs: number; private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    const maxOutputTokens = options.maxOutputTokens ?? 1536;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(options.profileId)) throw new ViewerError('INVALID_ARGUMENT', 'AI profile ID is invalid.');
    if (!options.label || options.label.length > 80 || /[\u0000-\u001f\u007f]/u.test(options.label)) throw new ViewerError('INVALID_ARGUMENT', 'AI profile label is invalid.');
    if (!options.model || options.model.length > 160 || /[\u0000-\u001f\u007f]/u.test(options.model)) throw new ViewerError('INVALID_ARGUMENT', 'Anthropic model is invalid.');
    if (!options.apiKey || options.apiKey.length > 512 || /[\u0000-\u0020\u007f]/u.test(options.apiKey)) throw new ViewerError('INVALID_ARGUMENT', 'ANTHROPIC_API_KEY is missing or invalid.');
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 8192) throw new ViewerError('INVALID_ARGUMENT', 'AI maxOutputTokens must be between 128 and 8192.');
    this.apiKey = options.apiKey; this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS; this.fetchImpl = options.fetchImpl ?? fetch;
    this.descriptor = { profileId: options.profileId, label: options.label, providerId: 'anthropic', model: options.model, locality: 'remote', endpointOrigin: 'https://api.anthropic.com', adapterVersion: 'anthropic-messages-2023-06-01-v1', structuredOutput: 'required-native', maxInputBytes: 16 * 1024, maxOutputTokens };
  }

  async cacheIdentity(): Promise<string> { return `${this.descriptor.adapterVersion}:${this.descriptor.model}`; }
  notice(): string { return 'Execution sends the displayed metadata to Anthropic. API usage may incur charges under your Anthropic account.'; }
  request(evidence: AiEvidenceSummary): Record<string, unknown> {
    return { model: this.descriptor.model, max_tokens: this.descriptor.maxOutputTokens, system: AI_SYSTEM_PROMPT, messages: [{ role: 'user', content: JSON.stringify(evidence) }], output_config: { format: { type: 'json_schema', schema: AI_OUTPUT_SCHEMA } } };
  }
  canonicalRequest(evidence: AiEvidenceSummary, cacheIdentity: string): unknown {
    return { promptVersion: AI_PROMPT_VERSION, provider: 'anthropic', adapterVersion: this.descriptor.adapterVersion, apiVersion: API_VERSION, cacheIdentity, request: this.request(evidence) };
  }
  async generate(evidence: AiEvidenceSummary): Promise<AiExplanation> {
    const body = JSON.stringify(this.request(evidence));
    if (Buffer.byteLength(body) > 32 * 1024) throw new ViewerError('OUTPUT_LIMIT', 'The AI provider request is too large.');
    let response: Response;
    try { response = await this.fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { 'x-api-key': this.apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' }, body }); }
    catch (error) {
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') throw new ViewerError('PROVIDER_TIMEOUT', 'The Anthropic provider timed out.', { retryable: true });
      throw new ViewerError('PROVIDER_UNAVAILABLE', 'The Anthropic provider is unavailable.', { retryable: true, cause: error });
    }
    if (!response.ok) { await response.body?.cancel(); throw httpError(response.status); }
    const raw = await readBounded(response); let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Anthropic returned non-JSON output.'); }
    if (!record(value) || value.type !== 'message' || value.role !== 'assistant' || !Array.isArray(value.content)) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Anthropic returned an invalid message.');
    if (value.stop_reason === 'max_tokens' || value.stop_reason === 'model_context_window_exceeded') throw new ViewerError('PROVIDER_OUTPUT_LIMIT', 'Anthropic returned an incomplete explanation.');
    if (value.stop_reason !== 'end_turn') throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Anthropic did not complete the explanation.');
    if (value.content.length !== 1 || !record(value.content[0]) || value.content[0].type !== 'text' || typeof value.content[0].text !== 'string') throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Anthropic returned unexpected content.');
    let parsed: unknown; try { parsed = JSON.parse(value.content[0].text); } catch { throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Anthropic returned invalid structured output.'); }
    return validateExplanation(parsed, new Set(evidence.changes.flatMap((item) => item.oldPath ? [item.path, item.oldPath] : [item.path])));
  }
}
