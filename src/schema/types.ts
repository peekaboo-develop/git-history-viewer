export const SCHEMA_VERSION = '1' as const;
export const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export type ErrorCode = 'INVALID_ARGUMENT' | 'INVALID_OID' | 'NOT_FOUND' |
  'STALE_CURSOR' | 'STATE_CHANGED' | 'CONTENT_DISABLED' | 'CONTENT_EXCLUDED' |
  'OUTPUT_LIMIT' | 'TIMEOUT' | 'NOT_GIT_REPOSITORY' | 'GIT_FAILED' | 'CACHE_FAILED';

export interface PublicWarning { code: string; message: string; details: Record<string, string | number | boolean | null> }
export interface PublicError { code: ErrorCode; message: string; retryable: boolean; details: Record<string, string | number | boolean | null> }
export interface Envelope<T> { schemaVersion: '1'; generation: string; data: T | null; warnings: PublicWarning[]; error?: PublicError }
export interface PathValue { display: string; encoding: 'utf8' | 'base64'; rawBase64: string | null }
export interface RepositoryInfo {
  name: string; objectFormat: 'sha1' | 'sha256'; head: string | null; branch: string | null;
  detached: boolean; unborn: boolean;
  capabilities: { patchPolicy: ContentPolicy; maxCommits: number; maxPatchBytes: number };
}
export interface StatusFile { path: PathValue; state: string }
export interface RepositoryStatus {
  head: string | null; branch: string | null; upstream: string | null; ahead: number; behind: number;
  staged: number; modified: number; untracked: number; conflicted: number;
  files: StatusFile[] | null; filesTruncated: boolean; omittedFileCount: number;
}
export interface GitRef {
  name: string; fullName: string; kind: 'local' | 'remote' | 'tag'; objectOid: string;
  peeledCommitOid: string | null; upstream: string | null; current: boolean;
}
export interface CommitSummary {
  oid: string; parents: string[]; authorName: string; authoredAt: string; subject: string;
  refs: GitRef[]; unpushed: boolean;
}
export interface CommitDetail extends CommitSummary {
  body: string; bodyOriginalBytes: number; bodyTruncated: boolean; committerName: string; committedAt: string;
}
export interface Change {
  state: string; path: PathValue | null; oldPath: PathValue | null; added: number | null; deleted: number | null;
}
export interface CommitChanges {
  oid: string; parentIndex: number | null; parentOid: string | null; changes: Change[];
  pathsIncluded: boolean; truncated: boolean; omittedCount: number;
}
export interface WorktreeInfo {
  id: string; displayName: string; head: string | null; branch: string | null; detached: boolean;
  current: boolean; locked: boolean; prunable: boolean;
}
export interface Page<T> { items: T[]; truncated: boolean; omittedCount: number | null; nextCursor: string | null }
export type ContentPolicy = 'metadata' | 'redacted' | 'full';
export interface PatchResult {
  oid: string; parentIndex: number | null; parentOid: string | null; policy: 'redacted' | 'full'; text: string;
  includedPaths: PathValue[]; excludedPaths: Array<{ path: PathValue; reason: string }>;
  byteCount: number; truncated: boolean;
}

export function success<T>(generation: string, data: T, warnings: PublicWarning[] = []): Envelope<T> {
  return { schemaVersion: SCHEMA_VERSION, generation, data, warnings };
}
