import { randomBytes } from 'node:crypto';
import { FileAiCache, aiCacheKey, digestAiInput, type AiCacheRequest } from './cache.js';
import { buildAiEvidence } from './evidence.js';
import { GROUNDED_AI_PROMPT_VERSION, validateGroundedExplanation } from './explanation-schema.js';
import type { AiProvider, AiProviderDescriptor } from './provider.js';
import { ViewerError } from '../core/errors.js';
import type { RepositoryReader } from '../core/repository.js';
import type { CitationTarget, GroundedAiEvidence, GroundedAiExplanation } from '../schema/types.js';
import type { GroundingContext } from '../docs/service.js';
import { AiExecutionQueue } from './queue.js';
import { officialDocById } from '../docs/official.js';

const REQUEST_TTL_MS = 5 * 60_000;
const MAX_EVIDENCE_BYTES = 16 * 1024;
const MAX_DOCUMENT_BYTES = 4 * 1024;
const MAX_DOCUMENT_TOTAL_BYTES = 8 * 1024;
const MAX_PREVIEWS = 100;

function clipUtf8(value: string, bytes: number): string {
  const raw = Buffer.from(value); if (raw.length <= bytes) return value;
  return raw.subarray(0, Math.max(0, bytes)).toString('utf8').replace(/\uFFFD$/u, '');
}

export interface BuiltGroundedEvidence {
  evidence: GroundedAiEvidence; includedChanges: number; excludedChanges: number; truncated: boolean; inputBytes: number; parentIndex: number | null;
}

export async function buildGroundedAiEvidence(reader: RepositoryReader, oid: string, context: GroundingContext): Promise<BuiltGroundedEvidence> {
  if (context.documents.length === 0 || context.documents.length > 2) throw new ViewerError('INVALID_ARGUMENT', 'Grounded AI requires one or two official documents.');
  const ids = new Set<string>(); let documentBytes = 0;
  for (const item of context.documents) {
    const bytes = Buffer.byteLength(item.excerpt); documentBytes += bytes;
    if (!/^official:[a-z0-9-]{1,64}$/u.test(item.citationId) || ids.has(item.citationId) || bytes === 0 || bytes > MAX_DOCUMENT_BYTES) throw new ViewerError('INVALID_ARGUMENT', 'Official document evidence is invalid.');
    ids.add(item.citationId);
  }
  if (documentBytes > MAX_DOCUMENT_TOTAL_BYTES) throw new ViewerError('OUTPUT_LIMIT', 'Official document evidence is too large.');
  const base = await buildAiEvidence(reader, oid);
  const evidence: GroundedAiEvidence = { ...base.evidence, changes: [...base.evidence.changes], officialDocuments: context.documents.map((item) => ({ ...item })) };
  let truncated = base.truncated; let removed = 0;
  while (Buffer.byteLength(JSON.stringify(evidence)) > MAX_EVIDENCE_BYTES && evidence.changes.length > 0) { evidence.changes.pop(); removed++; truncated = true; }
  if (Buffer.byteLength(JSON.stringify(evidence)) > MAX_EVIDENCE_BYTES && evidence.body) {
    const available = Math.max(0, MAX_EVIDENCE_BYTES - Buffer.byteLength(JSON.stringify({ ...evidence, body: '' })) - 128);
    evidence.body = clipUtf8(evidence.body, available); truncated = true;
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(evidence));
  if (inputBytes > MAX_EVIDENCE_BYTES) throw new ViewerError('OUTPUT_LIMIT', 'Combined commit and official-document evidence is too large.');
  return { evidence, includedChanges: evidence.changes.length, excludedChanges: base.excludedChanges + removed, truncated, inputBytes, parentIndex: base.parentIndex };
}

interface Pending {
  generation: string; evidence: BuiltGroundedEvidence; citationTargets: CitationTarget[]; cacheRequest: AiCacheRequest; expiresAt: number; promise: Promise<GroundedAiExecution> | null;
}

export interface GroundedAiPreview {
  requestId: string; expiresAt: string; mode: 'official-docs'; source: { oid: string; parentIndex: number | null; generation: string }; provider: AiProviderDescriptor;
  evidence: GroundedAiEvidence; citationTargets: CitationTarget[]; includedChanges: number; excludedChanges: number; truncated: boolean; inputBytes: number; cacheHit: boolean; notice: string;
}

export interface GroundedAiExecution {
  explanation: GroundedAiExplanation; citationTargets: CitationTarget[]; cache: { hit: boolean; stored: boolean }; warning: string | null;
}

export class GroundedAiExplanationService {
  private readonly requests = new Map<string, Pending>();
  constructor(private readonly reader: RepositoryReader, readonly provider: AiProvider, private readonly cache = new FileAiCache(), private readonly cacheEnabled = true, private readonly queue = new AiExecutionQueue()) {}

  private cleanup(): void {
    const now = Date.now(); for (const [id, item] of this.requests) if (item.expiresAt <= now && item.promise === null) this.requests.delete(id);
    while (this.requests.size >= MAX_PREVIEWS) this.requests.delete(this.requests.keys().next().value as string);
  }

  async preview(oid: string, context: GroundingContext): Promise<GroundedAiPreview> {
    this.cleanup(); if (this.cacheEnabled) await this.cache.stats();
    const before = await this.reader.generation(); if (before !== context.generation) throw new ViewerError('STATE_CHANGED', 'Repository state changed before the grounded AI preview.');
    const [evidence, cacheIdentity] = await Promise.all([buildGroundedAiEvidence(this.reader, oid, context), this.provider.cacheIdentity()]);
    const after = await this.reader.generation(); if (after !== before) throw new ViewerError('STATE_CHANGED', 'Repository state changed while preparing the grounded AI preview.');
    const canonical = JSON.stringify(this.provider.canonicalGroundedRequest(evidence.evidence, cacheIdentity)); const descriptor = this.provider.descriptor;
    const cacheRequest: AiCacheRequest = { operation: 'explain', targetLanguage: 'ja', promptVersion: GROUNDED_AI_PROMPT_VERSION, provider: descriptor.providerId, model: descriptor.model, exactInputDigest: digestAiInput(canonical) };
    const requestId = randomBytes(16).toString('hex'); const expiresAt = Date.now() + REQUEST_TTL_MS;
    const targets = context.documents.map((item) => {
      const registry = officialDocById(item.citationId.replace(/^official:/u, ''));
      if (!registry) throw new ViewerError('INVALID_ARGUMENT', 'Official document citation target is invalid.');
      return { citationId: item.citationId, title: registry.title, url: registry.url };
    });
    this.requests.set(requestId, { generation: after, evidence, citationTargets: targets, cacheRequest, expiresAt, promise: null });
    const cached = this.cacheEnabled ? await this.cache.get<GroundedAiExplanation>(aiCacheKey(cacheRequest)) : null;
    return { requestId, expiresAt: new Date(expiresAt).toISOString(), mode: 'official-docs', source: { oid, parentIndex: evidence.parentIndex, generation: after }, provider: descriptor, evidence: evidence.evidence, citationTargets: targets, includedChanges: evidence.includedChanges, excludedChanges: evidence.excludedChanges, truncated: evidence.truncated, inputBytes: evidence.inputBytes, cacheHit: cached !== null, notice: `${this.provider.notice()} The displayed official-document excerpts are also sent; citation links are not sent.` };
  }

  async execute(requestId: string): Promise<GroundedAiExecution> {
    if (!/^[0-9a-f]{32}$/u.test(requestId)) throw new ViewerError('INVALID_ARGUMENT', 'Grounded AI request ID is invalid.');
    const pending = this.requests.get(requestId);
    if (!pending || pending.expiresAt <= Date.now()) { this.requests.delete(requestId); throw new ViewerError('AI_REQUEST_EXPIRED', 'The grounded AI preview expired or no longer exists.'); }
    if (pending.promise) return pending.promise;
    const promise = this.queue.run(async (): Promise<GroundedAiExecution> => {
        if (pending.expiresAt <= Date.now()) throw new ViewerError('AI_REQUEST_EXPIRED', 'The grounded AI preview expired while waiting.');
        if (await this.reader.generation() !== pending.generation) throw new ViewerError('STATE_CHANGED', 'Repository state changed after the grounded AI preview.');
        const paths = new Set(pending.evidence.evidence.changes.flatMap((item) => item.oldPath ? [item.path, item.oldPath] : [item.path]));
        const citationIds = new Set(pending.evidence.evidence.officialDocuments.map((item) => item.citationId)); const key = aiCacheKey(pending.cacheRequest);
        if (this.cacheEnabled) {
          const cached = await this.cache.get<GroundedAiExplanation>(key);
          if (cached) {
            const explanation = validateGroundedExplanation(cached.result, paths, citationIds);
            if (await this.reader.generation() !== pending.generation) throw new ViewerError('STATE_CHANGED', 'Repository state changed while reading the grounded AI cache.');
            return this.result(explanation, pending, true, true, null);
          }
        }
        const generated = validateGroundedExplanation(await this.provider.generateGrounded(pending.evidence.evidence), paths, citationIds);
        if (await this.reader.generation() !== pending.generation) throw new ViewerError('STATE_CHANGED', 'Repository state changed during the grounded AI request.');
        if (!this.cacheEnabled) return this.result(generated, pending, false, false, null);
        try { await this.cache.put(pending.cacheRequest, generated); return this.result(generated, pending, false, true, null); }
        catch { return this.result(generated, pending, false, false, 'The explanation was generated but could not be cached.'); }
    });
    pending.promise = promise; return promise;
  }

  private result(explanation: GroundedAiExplanation, pending: Pending, hit: boolean, stored: boolean, warning: string | null): GroundedAiExecution {
    const cited = new Set(explanation.citations.map((item) => item.citationId));
    return { explanation, citationTargets: pending.citationTargets.filter((item) => cited.has(item.citationId)), cache: { hit, stored }, warning };
  }
}
