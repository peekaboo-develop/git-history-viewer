import { randomBytes } from 'node:crypto';
import { ViewerError } from '../core/errors.js';
import type { RepositoryReader } from '../core/repository.js';
import { OfficialDocumentFetcher, type FetchedOfficialDocument } from './fetcher.js';
import { officialDocById, recommendOfficialDocs, type OfficialDocRecommendation } from './official.js';
import type { CitationTarget } from '../schema/types.js';

interface Pending { oid: string; generation: string; items: OfficialDocRecommendation[]; expiresAt: number }
interface ServiceOptions { now?: () => number; ttlMs?: number; maxScheduled?: number }
export interface OfficialDocsPreview { requestId: string | null; items: OfficialDocRecommendation[]; networkAccessed: false; versionDetection: 'unavailable'; limits: { pages: 2; rawBytesPerPage: number; excerptBytesPerPage: number } }
export interface GroundingDocument { citationId: string; excerpt: string }
export interface GroundingContext { generation: string; documents: GroundingDocument[]; citationTargets: CitationTarget[] }
export interface OfficialDocsResult { documentSetId: string | null; documentSetExpiresAt: string | null; documents: Array<FetchedOfficialDocument & { citationId: string }>; failures: Array<{ id: string; code: string }> }
interface DocumentSet extends GroundingContext { oid: string; expiresAt: number }

export class OfficialDocsService {
  private readonly pending = new Map<string, Pending>(); private readonly executions = new Map<string, Promise<OfficialDocsResult>>(); private readonly documentSets = new Map<string, DocumentSet>(); private fetchTail: Promise<void> = Promise.resolve(); private scheduled = 0;
  private readonly now: () => number; private readonly ttlMs: number; private readonly maxScheduled: number;
  constructor(private readonly reader: RepositoryReader, private readonly fetcher = new OfficialDocumentFetcher(), options: ServiceOptions = {}) {
    this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? 5 * 60_000; this.maxScheduled = options.maxScheduled ?? 5;
  }
  async preview(oid: string): Promise<OfficialDocsPreview> {
    let changes: Awaited<ReturnType<RepositoryReader['changes']>> | undefined; let generation = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await this.reader.generation(); const candidate = await this.reader.changes(oid, null, true); const after = await this.reader.generation();
      if (before === after) { changes = candidate; generation = after; break; }
    }
    if (!changes) throw new ViewerError('STATE_CHANGED', 'Repository state changed while preparing the official document preview.');
    const items = recommendOfficialDocs(changes.changes); const requestId = items.length ? randomBytes(16).toString('hex') : null;
    const now = this.now(); this.cleanup(now);
    if (requestId) { if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value as string); this.pending.set(requestId, { oid, generation, items, expiresAt: now + this.ttlMs }); }
    return { requestId, items, networkAccessed: false, versionDetection: 'unavailable', limits: { pages: 2, rawBytesPerPage: 1024 * 1024, excerptBytesPerPage: 4 * 1024 } };
  }
  async execute(requestId: string): Promise<OfficialDocsResult> {
    if (!/^[0-9a-f]{32}$/u.test(requestId)) throw new ViewerError('INVALID_ARGUMENT', 'Official document request ID is invalid.');
    const existing = this.executions.get(requestId); if (existing) return existing;
    const pending = this.pending.get(requestId); if (!pending || pending.expiresAt <= this.now()) throw new ViewerError('AI_REQUEST_EXPIRED', 'Official document preview expired.');
    if (this.scheduled >= this.maxScheduled) throw new ViewerError('AI_QUEUE_FULL', 'The official document fetch queue is full.', { retryable: true });
    this.pending.delete(requestId);
    this.scheduled++;
    const execution = (async () => {
      if (await this.reader.generation() !== pending.generation) throw new ViewerError('STATE_CHANGED', 'Repository state changed after the official document preview.');
      const documents: Array<FetchedOfficialDocument & { citationId: string }> = []; const failures: Array<{ id: string; code: string }> = [];
      for (const item of pending.items) {
        try {
          const fetched = await this.serialFetch(item.id, pending); const registry = officialDocById(item.id);
          if (!registry) throw new ViewerError('INVALID_ARGUMENT', 'Unknown official document ID.');
          documents.push({ ...fetched, id: registry.id, title: registry.title, url: registry.url, citationId: `official:${registry.id}` });
        }
        catch (error) {
          if (error instanceof ViewerError && ['AI_REQUEST_EXPIRED', 'STATE_CHANGED'].includes(error.code)) throw error;
          failures.push({ id: item.id, code: error instanceof ViewerError ? error.code : 'PROVIDER_UNAVAILABLE' });
        }
      }
      if (documents.length === 0) return { documentSetId: null, documentSetExpiresAt: null, documents, failures };
      const documentSetId = randomBytes(16).toString('hex'); const expiresAt = this.now() + this.ttlMs;
      this.documentSets.set(documentSetId, {
        oid: pending.oid, generation: pending.generation, expiresAt,
        documents: documents.map((item) => ({ citationId: item.citationId, excerpt: item.excerpt })),
        citationTargets: documents.map((item) => ({ citationId: item.citationId, title: item.title, url: item.url })),
      });
      this.cleanup(this.now());
      return { documentSetId, documentSetExpiresAt: new Date(expiresAt).toISOString(), documents, failures };
    })();
    if (this.executions.size >= 100) this.executions.delete(this.executions.keys().next().value as string);
    this.executions.set(requestId, execution);
    const cleanup = () => { this.scheduled--; setTimeout(() => this.executions.delete(requestId), 60_000).unref(); };
    void execution.then(cleanup, cleanup); return execution;
  }
  async forAi(oid: string, documentSetId: string): Promise<GroundingContext> {
    if (!/^[0-9a-f]{32}$/u.test(documentSetId)) throw new ViewerError('INVALID_ARGUMENT', 'Official document set ID is invalid.');
    const now = this.now(); this.cleanup(now); const set = this.documentSets.get(documentSetId);
    if (!set || set.expiresAt <= now) throw new ViewerError('AI_REQUEST_EXPIRED', 'The official document set expired or no longer exists.');
    if (set.oid !== oid) throw new ViewerError('INVALID_ARGUMENT', 'The official document set belongs to a different commit.');
    if (await this.reader.generation() !== set.generation) throw new ViewerError('STATE_CHANGED', 'Repository state changed after the official documents were fetched.');
    return { generation: set.generation, documents: set.documents.map((item) => ({ ...item })), citationTargets: set.citationTargets.map((item) => ({ ...item })) };
  }
  private cleanup(now: number): void {
    for (const [id, item] of this.pending) if (item.expiresAt <= now) this.pending.delete(id);
    for (const [id, item] of this.documentSets) if (item.expiresAt <= now) this.documentSets.delete(id);
    while (this.documentSets.size > 100) this.documentSets.delete(this.documentSets.keys().next().value as string);
  }
  private serialFetch(id: string, pending: Pending): Promise<FetchedOfficialDocument> {
    const run = this.fetchTail.then(async () => {
      if (pending.expiresAt <= this.now()) throw new ViewerError('AI_REQUEST_EXPIRED', 'Official document preview expired while waiting for network access.');
      if (await this.reader.generation() !== pending.generation) throw new ViewerError('STATE_CHANGED', 'Repository state changed before the official document fetch.');
      const document = await this.fetcher.fetch(id);
      if (await this.reader.generation() !== pending.generation) throw new ViewerError('STATE_CHANGED', 'Repository state changed during the official document fetch.');
      return document;
    });
    this.fetchTail = run.then(() => undefined, () => undefined); return run;
  }
}
