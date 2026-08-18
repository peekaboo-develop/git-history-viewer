import { randomBytes } from 'node:crypto';
import { FileAiCache, aiCacheKey, digestAiInput, type AiCacheRequest } from './cache.js';
import { buildAiEvidence, type BuiltAiEvidence } from './evidence.js';
import { AI_PROMPT_VERSION, validateExplanation } from './explanation-schema.js';
import type { AiProvider, AiProviderDescriptor } from './provider.js';
import { ViewerError } from '../core/errors.js';
import type { RepositoryReader } from '../core/repository.js';
import type { AiExplanation } from '../schema/types.js';
import { GroundedAiExplanationService } from './grounding.js';
import { AiExecutionQueue } from './queue.js';

const REQUEST_TTL_MS = 5 * 60 * 1_000;
const MAX_PREVIEWS = 100;

interface PendingRequest { oid: string; generation: string; evidence: BuiltAiEvidence; cacheIdentity: string; cacheRequest: AiCacheRequest; expiresAt: number; promise: Promise<AiExecution> | null }
export interface AiExecution { explanation: AiExplanation; cache: { hit: boolean; stored: boolean }; warning: string | null }

export interface AiPreview {
  requestId: string; expiresAt: string; source: { oid: string; parentIndex: number | null; generation: string };
  provider: AiProviderDescriptor;
  evidence: BuiltAiEvidence['evidence']; includedChanges: number; excludedChanges: number; truncated: boolean; inputBytes: number; cacheHit: boolean;
  notice: string;
}

export class AiExplanationService {
  private readonly requests = new Map<string, PendingRequest>();
  constructor(private readonly reader: RepositoryReader, readonly provider: AiProvider, private readonly cache = new FileAiCache(), private readonly cacheEnabled = true, private queue = new AiExecutionQueue(), private readonly now: () => number = Date.now, private readonly requestTtlMs = REQUEST_TTL_MS) {}

  shareQueue(queue: AiExecutionQueue): void { this.queue = queue; }

  createGroundedService(): GroundedAiExplanationService { return new GroundedAiExplanationService(this.reader, this.provider, this.cache, this.cacheEnabled, this.queue); }

  capabilities(): { enabled: true; profiles: AiProviderDescriptor[]; defaultProfileId: string; policy: string } {
    return { enabled: true, profiles: [this.provider.descriptor], defaultProfileId: this.provider.descriptor.profileId, policy: `metadata-only; cache-${this.cacheEnabled ? 'enabled' : 'disabled'}` };
  }

  private cleanup(): void {
    const now = this.now(); for (const [id, item] of this.requests) if (item.expiresAt <= now && item.promise === null) this.requests.delete(id);
    while (this.requests.size >= MAX_PREVIEWS) this.requests.delete(this.requests.keys().next().value as string);
  }

  async preview(oid: string): Promise<AiPreview> {
    this.cleanup();
    if (this.cacheEnabled) await this.cache.stats();
    const [generation, evidence, cacheIdentity] = await Promise.all([this.reader.generation(), buildAiEvidence(this.reader, oid), this.provider.cacheIdentity()]);
    const canonicalRequest = JSON.stringify(this.provider.canonicalRequest(evidence.evidence, cacheIdentity));
    const descriptor = this.provider.descriptor;
    const cacheRequest: AiCacheRequest = { operation: 'explain', targetLanguage: 'ja', promptVersion: AI_PROMPT_VERSION, provider: descriptor.providerId, model: descriptor.model, exactInputDigest: digestAiInput(canonicalRequest) };
    const requestId = randomBytes(16).toString('hex'); const expiresAt = this.now() + this.requestTtlMs;
    this.requests.set(requestId, { oid, generation, evidence, cacheIdentity, cacheRequest, expiresAt, promise: null });
    const cacheHit = this.cacheEnabled && (await this.cache.get<AiExplanation>(aiCacheKey(cacheRequest))) !== null;
    return { requestId, expiresAt: new Date(expiresAt).toISOString(), source: { oid, parentIndex: evidence.parentIndex, generation }, provider: descriptor, evidence: evidence.evidence, includedChanges: evidence.includedChanges, excludedChanges: evidence.excludedChanges, truncated: evidence.truncated, inputBytes: evidence.inputBytes, cacheHit, notice: this.provider.notice() };
  }

  async execute(requestId: string): Promise<AiExecution> {
    if (!/^[0-9a-f]{32}$/u.test(requestId)) throw new ViewerError('INVALID_ARGUMENT', 'AI request ID is invalid.');
    const pending = this.requests.get(requestId);
    if (!pending || pending.expiresAt <= this.now()) { this.requests.delete(requestId); throw new ViewerError('AI_REQUEST_EXPIRED', 'The AI preview expired or no longer exists.'); }
    if (pending.promise) return pending.promise;
    const promise = this.queue.run(async (): Promise<AiExecution> => {
        if (pending.expiresAt <= this.now()) throw new ViewerError('AI_REQUEST_EXPIRED', 'The AI preview expired while waiting.');
        if (await this.reader.generation() !== pending.generation) throw new ViewerError('STATE_CHANGED', 'Repository state changed after the AI preview.');
        if (!this.cacheEnabled) return { explanation: await this.provider.generate(pending.evidence.evidence), cache: { hit: false, stored: false }, warning: null };
        const result = await this.cache.getOrComputeResilient(pending.cacheRequest, () => this.provider.generate(pending.evidence.evidence));
        const paths = new Set(pending.evidence.evidence.changes.flatMap((item) => item.oldPath ? [item.path, item.oldPath] : [item.path]));
        return { explanation: validateExplanation(result.value, paths), cache: { hit: result.cacheHit, stored: result.cacheStored }, warning: result.cacheWarning };
    });
    pending.promise = promise;
    return promise;
  }
}
