import { ViewerError } from '../core/errors.js';
import type { AiEvidenceSummary, AiExplanation, GroundedAiEvidence, GroundedAiExplanation } from '../schema/types.js';
import { AI_OUTPUT_SCHEMA, AI_PROMPT_VERSION, AI_SYSTEM_PROMPT, GROUNDED_AI_OUTPUT_SCHEMA, GROUNDED_AI_PROMPT_VERSION, GROUNDED_AI_SYSTEM_PROMPT, validateExplanation, validateGroundedExplanation } from './explanation-schema.js';
import type { AiProvider, AiProviderDescriptor } from './provider.js';

const ORIGIN = 'https://generativelanguage.googleapis.com';
const ADAPTER_VERSION = 'gemini-generate-content-v1beta-response-json-schema-v1';
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const SCHEMA_KEYS = new Set(['type', 'title', 'description', 'enum', 'items', 'properties', 'additionalProperties', 'required', 'const']);

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function inferredType(value: unknown): string {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  throw new ViewerError('INVALID_ARGUMENT', 'The AI output schema contains an unsupported const value.');
}

export function toGeminiJsonSchema(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new ViewerError('INVALID_ARGUMENT', 'The AI output schema is invalid for Gemini.');
  for (const key of Object.keys(value)) if (!SCHEMA_KEYS.has(key)) throw new ViewerError('INVALID_ARGUMENT', `The AI output schema uses an unsupported Gemini keyword: ${key}`);
  const result: Record<string, unknown> = {};
  if ('const' in value) {
    if ('enum' in value) throw new ViewerError('INVALID_ARGUMENT', 'The AI output schema cannot combine const and enum for Gemini.');
    result.type = value.type ?? inferredType(value.const); result.enum = [value.const];
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'const') continue;
    if (key === 'properties') {
      if (!record(item)) throw new ViewerError('INVALID_ARGUMENT', 'The AI output schema has invalid Gemini properties.');
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(item)) properties[name] = toGeminiJsonSchema(child);
      result.properties = properties; result.propertyOrdering = Object.keys(properties); continue;
    }
    if (key === 'items') { result.items = toGeminiJsonSchema(item); continue; }
    if (key === 'enum') {
      if (!Array.isArray(item) || item.length === 0) throw new ViewerError('INVALID_ARGUMENT', 'The AI output schema has an invalid Gemini enum.');
      result.enum = [...item]; if (!('type' in value)) result.type = inferredType(item[0]); continue;
    }
    if (key === 'required') { if (!Array.isArray(item) || !item.every((entry) => typeof entry === 'string')) throw new ViewerError('INVALID_ARGUMENT', 'The AI output schema has invalid Gemini required fields.'); result.required = [...item]; continue; }
    result[key] = item;
  }
  if (result.type === 'object' && !('additionalProperties' in result)) result.additionalProperties = false;
  return result;
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ViewerError('PROVIDER_OUTPUT_LIMIT', 'The Google response is too large.'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

function httpError(status: number): ViewerError {
  const details = { status };
  if (status === 404) return new ViewerError('PROVIDER_MODEL_NOT_FOUND', 'The configured Google model is unavailable.', { details });
  if (status === 408 || status === 499 || status === 504) return new ViewerError('PROVIDER_TIMEOUT', 'The Google provider timed out.', { retryable: true, details });
  if (status === 413) return new ViewerError('OUTPUT_LIMIT', 'The Google provider request is too large.', { details });
  const retryable = status === 429 || status >= 500;
  return new ViewerError('PROVIDER_UNAVAILABLE', 'The Google provider rejected the request.', { retryable, details });
}

export interface GoogleProviderOptions { profileId: string; label: string; model: string; apiKey: string; maxOutputTokens?: number; timeoutMs?: number; fetchImpl?: typeof fetch }

export class GoogleProvider implements AiProvider {
  readonly descriptor: AiProviderDescriptor;
  private readonly apiKey: string; private readonly timeoutMs: number; private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleProviderOptions) {
    const maxOutputTokens = options.maxOutputTokens ?? 1536;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(options.profileId)) throw new ViewerError('INVALID_ARGUMENT', 'AI profile ID is invalid.');
    if (!options.label || options.label.length > 80 || /[\u0000-\u001f\u007f]/u.test(options.label)) throw new ViewerError('INVALID_ARGUMENT', 'AI profile label is invalid.');
    if (!MODEL_PATTERN.test(options.model)) throw new ViewerError('INVALID_ARGUMENT', 'Google model must be a bare model ID.');
    if (!options.apiKey || options.apiKey.length > 512 || /[\u0000-\u0020\u007f]/u.test(options.apiKey)) throw new ViewerError('INVALID_ARGUMENT', 'GEMINI_API_KEY is missing or invalid.');
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 8192) throw new ViewerError('INVALID_ARGUMENT', 'AI maxOutputTokens must be between 128 and 8192.');
    this.apiKey = options.apiKey; this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS; this.fetchImpl = options.fetchImpl ?? fetch;
    this.descriptor = { profileId: options.profileId, label: options.label, providerId: 'google', model: options.model, locality: 'remote', endpointOrigin: ORIGIN, adapterVersion: ADAPTER_VERSION, structuredOutput: 'required-native', maxInputBytes: 16 * 1024, maxOutputTokens };
  }

  async cacheIdentity(): Promise<string> { return `${this.descriptor.adapterVersion}:${this.descriptor.model}`; }
  notice(): string { return 'Execution sends the displayed metadata to Google. Gemini API usage may incur charges under your Google account.'; }
  request(evidence: AiEvidenceSummary): Record<string, unknown> {
    return { systemInstruction: { parts: [{ text: AI_SYSTEM_PROMPT }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify(evidence) }] }], generationConfig: { responseMimeType: 'application/json', responseJsonSchema: toGeminiJsonSchema(AI_OUTPUT_SCHEMA), candidateCount: 1, maxOutputTokens: this.descriptor.maxOutputTokens }, store: false };
  }
  groundedRequest(evidence: GroundedAiEvidence): Record<string, unknown> {
    return { systemInstruction: { parts: [{ text: GROUNDED_AI_SYSTEM_PROMPT }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify(evidence) }] }], generationConfig: { responseMimeType: 'application/json', responseJsonSchema: toGeminiJsonSchema(GROUNDED_AI_OUTPUT_SCHEMA), candidateCount: 1, maxOutputTokens: this.descriptor.maxOutputTokens }, store: false };
  }
  canonicalRequest(evidence: AiEvidenceSummary, cacheIdentity: string): unknown {
    return { promptVersion: AI_PROMPT_VERSION, provider: 'google', adapterVersion: this.descriptor.adapterVersion, apiVersion: 'v1beta', cacheIdentity, request: this.request(evidence) };
  }
  canonicalGroundedRequest(evidence: GroundedAiEvidence, cacheIdentity: string): unknown {
    return { promptVersion: GROUNDED_AI_PROMPT_VERSION, provider: 'google', adapterVersion: this.descriptor.adapterVersion, apiVersion: 'v1beta', cacheIdentity, request: this.groundedRequest(evidence) };
  }
  generate(evidence: AiEvidenceSummary): Promise<AiExplanation> { return this.generateWith(evidence, false) as Promise<AiExplanation>; }
  generateGrounded(evidence: GroundedAiEvidence): Promise<GroundedAiExplanation> { return this.generateWith(evidence, true) as Promise<GroundedAiExplanation>; }
  private async generateWith(evidence: AiEvidenceSummary | GroundedAiEvidence, grounded: boolean): Promise<AiExplanation | GroundedAiExplanation> {
    const body = JSON.stringify(grounded ? this.groundedRequest(evidence as GroundedAiEvidence) : this.request(evidence));
    if (Buffer.byteLength(body) > 48 * 1024) throw new ViewerError('OUTPUT_LIMIT', 'The AI provider request is too large.');
    const endpoint = `${ORIGIN}/v1beta/models/${encodeURIComponent(this.descriptor.model)}:generateContent`;
    let response: Response;
    try { response = await this.fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' }, body }); }
    catch (error) {
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') throw new ViewerError('PROVIDER_TIMEOUT', 'The Google provider timed out.', { retryable: true });
      throw new ViewerError('PROVIDER_UNAVAILABLE', 'The Google provider is unavailable.', { retryable: true, cause: error });
    }
    if (!response.ok) { await response.body?.cancel(); throw httpError(response.status); }
    const raw = await readBounded(response); let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Google returned non-JSON output.'); }
    if (!record(value)) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Google returned an invalid response.');
    if (record(value.promptFeedback) && typeof value.promptFeedback.blockReason === 'string') throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Google blocked the explanation prompt.');
    if (!Array.isArray(value.candidates) || value.candidates.length !== 1 || !record(value.candidates[0])) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Google returned an invalid candidate set.');
    const candidate = value.candidates[0];
    if (candidate.finishReason === 'MAX_TOKENS') throw new ViewerError('PROVIDER_OUTPUT_LIMIT', 'Google returned an incomplete explanation.');
    if (candidate.finishReason !== 'STOP') throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Google did not complete the explanation.');
    if (!record(candidate.content) || !Array.isArray(candidate.content.parts) || candidate.content.parts.length !== 1 || !record(candidate.content.parts[0]) || typeof candidate.content.parts[0].text !== 'string' || Object.keys(candidate.content.parts[0]).some((key) => key !== 'text')) throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Google returned unexpected content.');
    let parsed: unknown; try { parsed = JSON.parse(candidate.content.parts[0].text); } catch { throw new ViewerError('PROVIDER_OUTPUT_INVALID', 'Google returned invalid structured output.'); }
    const paths = new Set(evidence.changes.flatMap((item) => item.oldPath ? [item.path, item.oldPath] : [item.path]));
    return grounded ? validateGroundedExplanation(parsed, paths, new Set((evidence as GroundedAiEvidence).officialDocuments.map((item) => item.citationId))) : validateExplanation(parsed, paths);
  }
}
