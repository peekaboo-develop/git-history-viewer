import { ViewerError } from '../core/errors.js';
import type { AiEvidenceSummary, AiExplanation } from '../schema/types.js';
import { AI_OUTPUT_SCHEMA, AI_PROMPT_VERSION, AI_SYSTEM_PROMPT, validateExplanation } from './ollama.js';
import type { AiProvider, AiProviderDescriptor } from './provider.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ViewerError('PROVIDER_OUTPUT_LIMIT', 'The OpenAI response is too large.'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export interface OpenAiProviderOptions { profileId: string; label: string; model: string; apiKey: string; maxOutputTokens?: number; timeoutMs?: number; fetchImpl?: typeof fetch }

export class OpenAiProvider implements AiProvider {
  readonly descriptor: AiProviderDescriptor;
  private readonly apiKey: string; private readonly timeoutMs: number; private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiProviderOptions) {
    const maxOutputTokens = options.maxOutputTokens ?? 1536;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(options.profileId)) throw new ViewerError('INVALID_ARGUMENT', 'AI profile ID is invalid.');
    if (!options.label || options.label.length > 80 || /[\u0000-\u001f\u007f]/u.test(options.label)) throw new ViewerError('INVALID_ARGUMENT', 'AI profile label is invalid.');
    if (!options.model || options.model.length > 160 || /[\u0000-\u001f\u007f]/u.test(options.model)) throw new ViewerError('INVALID_ARGUMENT', 'OpenAI model is invalid.');
    if (!options.apiKey || options.apiKey.length > 512 || /[\u0000-\u0020\u007f]/u.test(options.apiKey)) throw new ViewerError('INVALID_ARGUMENT', 'OPENAI_API_KEY is missing or invalid.');
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 8192) throw new ViewerError('INVALID_ARGUMENT', 'AI maxOutputTokens must be between 128 and 8192.');
    this.apiKey = options.apiKey; this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS; this.fetchImpl = options.fetchImpl ?? fetch;
    this.descriptor = { profileId: options.profileId, label: options.label, providerId: 'openai', model: options.model, locality: 'remote', endpointOrigin: 'https://api.openai.com', adapterVersion: 'openai-responses-v1', structuredOutput: 'required-native', maxInputBytes: 16 * 1024, maxOutputTokens };
  }

  async cacheIdentity(): Promise<string> { return `${this.descriptor.adapterVersion}:${this.descriptor.model}`; }
  notice(): string { return 'Execution sends the displayed metadata to OpenAI. API usage may incur charges under your OpenAI account.'; }
  canonicalRequest(evidence: AiEvidenceSummary, cacheIdentity: string): unknown {
    return { promptVersion: AI_PROMPT_VERSION, provider: 'openai', adapterVersion: this.descriptor.adapterVersion, model: this.descriptor.model, cacheIdentity, system: AI_SYSTEM_PROMPT, evidence, schema: AI_OUTPUT_SCHEMA, settings: { maxOutputTokens: this.descriptor.maxOutputTokens, store: false } };
  }
  request(evidence: AiEvidenceSummary): Record<string, unknown> {
    return { model: this.descriptor.model, input: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(evidence) }], text: { format: { type: 'json_schema', name: 'git_commit_explanation', strict: true, schema: AI_OUTPUT_SCHEMA } }, max_output_tokens: this.descriptor.maxOutputTokens, store: false };
  }
  async generate(evidence: AiEvidenceSummary): Promise<AiExplanation> {
    const body = JSON.stringify(this.request(evidence));
    if (Buffer.byteLength(body) > 32 * 1024) throw new ViewerError('OUTPUT_LIMIT', 'The AI provider request is too large.');
    let response: Response;
    try { response = await this.fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body }); }
    catch (error) {
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') throw new ViewerError('PROVIDER_TIMEOUT', 'The OpenAI provider timed out.', { retryable: true });
      throw new ViewerError('PROVIDER_UNAVAILABLE', 'The OpenAI provider is unavailable.', { retryable: true, cause: error });
    }
    if (!response.ok) throw new ViewerError('PROVIDER_UNAVAILABLE', 'The OpenAI provider rejected the request.', { retryable: response.status === 429 || response.status >= 500, details: { status: response.status } });
    const raw = await readBounded(response); let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'OpenAI returned non-JSON output.'); }
    if (!record(value) || value.status !== 'completed' || !Array.isArray(value.output)) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'OpenAI returned an incomplete response.');
    const message = value.output.find((item) => record(item) && item.type === 'message');
    if (!record(message) || !Array.isArray(message.content)) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'OpenAI returned no response message.');
    const refusal = message.content.find((item) => record(item) && item.type === 'refusal');
    if (refusal) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'OpenAI refused to generate the explanation.');
    const output = message.content.find((item) => record(item) && item.type === 'output_text');
    if (!record(output) || typeof output.text !== 'string') throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'OpenAI returned no structured output.');
    let parsed: unknown; try { parsed = JSON.parse(output.text); } catch { throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'OpenAI returned invalid structured output.'); }
    return validateExplanation(parsed, new Set(evidence.changes.flatMap((item) => item.oldPath ? [item.path, item.oldPath] : [item.path])));
  }
}
