import { ViewerError } from '../core/errors.js';
import type { RepositoryReader } from '../core/repository.js';
import type { AiEvidenceSummary, Change } from '../schema/types.js';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024;
const MAX_CHANGES = 200;

const secretBase = /(?:^\.env|credential|secret|token|password|passwd|private|id_rsa|\.pem$|\.key$|\.npmrc$|\.pypirc$|\.netrc$)/iu;

function safePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return !normalized.split('/').some((part) => ['.aws', '.ssh', '.gnupg'].includes(part.toLowerCase()) || secretBase.test(part));
}

function clipUtf8(value: string, bytes: number): string {
  const raw = Buffer.from(value);
  if (raw.length <= bytes) return value;
  return raw.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function sanitizeMessage(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED TOKEN]')
    .replace(/\b(?:[0-9a-f]{40}|[0-9a-f]{64})\b/gu, '[COMMIT OID]')
    .replace(/https?:\/\/\S+/giu, '[URL omitted]')
    .replace(/(?:^|\s)(\/(?:Users|home|var|private|tmp)\/\S+)/gu, ' [absolute path omitted]');
}

function evidenceChange(change: Change): AiEvidenceSummary['changes'][number] | null {
  if (change.path?.encoding !== 'utf8' || !safePath(change.path.display)) return null;
  if (change.oldPath && (change.oldPath.encoding !== 'utf8' || !safePath(change.oldPath.display))) return null;
  return { state: change.state, path: change.path.display, oldPath: change.oldPath?.display ?? null, added: change.added, deleted: change.deleted };
}

export interface BuiltAiEvidence {
  evidence: AiEvidenceSummary;
  includedChanges: number;
  excludedChanges: number;
  truncated: boolean;
  inputBytes: number;
  parentIndex: number | null;
}

export async function buildAiEvidence(reader: RepositoryReader, oid: string): Promise<BuiltAiEvidence> {
  const [commit, changes] = await Promise.all([reader.commit(oid), reader.changes(oid, null, true)]);
  const allowed = changes.changes.map(evidenceChange).filter((value): value is NonNullable<typeof value> => value !== null);
  let truncated = commit.bodyTruncated || allowed.length > MAX_CHANGES;
  const evidence: AiEvidenceSummary = {
    subject: clipUtf8(sanitizeMessage(commit.subject), 2 * 1024),
    body: clipUtf8(sanitizeMessage(commit.body), MAX_BODY_BYTES),
    comparison: changes.parentOid === null ? 'root' : 'first-parent',
    changes: allowed.slice(0, MAX_CHANGES),
  };
  while (Buffer.byteLength(JSON.stringify(evidence)) > MAX_EVIDENCE_BYTES && evidence.changes.length > 0) {
    evidence.changes.pop(); truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(evidence)) > MAX_EVIDENCE_BYTES) {
    evidence.body = clipUtf8(evidence.body, Math.max(0, MAX_EVIDENCE_BYTES - Buffer.byteLength(JSON.stringify({ ...evidence, body: '' })) - 128));
    truncated = true;
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(evidence));
  if (inputBytes > MAX_EVIDENCE_BYTES) throw new ViewerError('OUTPUT_LIMIT', 'Commit metadata is too large for AI explanation.');
  return {
    evidence, includedChanges: evidence.changes.length,
    excludedChanges: changes.changes.length - evidence.changes.length,
    truncated, inputBytes, parentIndex: changes.parentIndex,
  };
}
