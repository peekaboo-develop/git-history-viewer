# Public data schemas

These TypeScript-like definitions are normative for CLI JSON, HTTP `data`, and MCP `structuredContent`.

```ts
type Oid = string; // complete lowercase 40- or 64-hex value
type IsoDate = string;

type PathValue = {
  display: string;
  encoding: "utf8" | "base64";
  rawBase64: string | null;
};

type Repository = {
  name: string;
  objectFormat: "sha1" | "sha256";
  head: Oid | null;
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  capabilities: {
    patchPolicy: "metadata" | "redacted" | "full";
    maxCommits: number;
    maxPatchBytes: number;
  };
};

type Status = {
  head: Oid | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  files: Array<{ path: PathValue; state: string }> | null;
  filesTruncated: boolean;
  omittedFileCount: number;
};

type Ref = {
  name: string;
  fullName: string;
  kind: "local" | "remote" | "tag";
  objectOid: Oid;
  peeledCommitOid: Oid | null;
  upstream: string | null;
  current: boolean;
};

type CommitSummary = {
  oid: Oid;
  parents: Oid[];
  authorName: string;
  authoredAt: IsoDate;
  subject: string;
  refs: Ref[];
  unpushed: boolean;
};

type Commit = CommitSummary & {
  body: string;
  bodyOriginalBytes: number;
  bodyTruncated: boolean;
  committerName: string;
  committedAt: IsoDate;
};

type Change = {
  state: string;
  path: PathValue | null;
  oldPath: PathValue | null;
  added: number | null;
  deleted: number | null;
};

type CommitChanges = {
  oid: Oid;
  parentIndex: number | null;
  parentOid: Oid | null;
  changes: Change[];
  pathsIncluded: boolean;
  truncated: boolean;
  omittedCount: number;
};

type Patch = {
  oid: Oid;
  parentIndex: number | null;
  parentOid: Oid | null;
  policy: "redacted" | "full";
  text: string;
  includedPaths: PathValue[];
  excludedPaths: Array<{ path: PathValue; reason: string }>;
  byteCount: number;
  truncated: boolean;
};

type Worktree = {
  id: string;
  displayName: string;
  head: Oid | null;
  branch: string | null;
  detached: boolean;
  current: boolean;
  locked: boolean;
  prunable: boolean;
};

type Page<T> = {
  items: T[];
  truncated: boolean;
  omittedCount: number | null;
  nextCursor: string | null;
};

type PublicError = {
  code: "INVALID_ARGUMENT" | "INVALID_OID" | "NOT_FOUND" |
    "STALE_CURSOR" | "STATE_CHANGED" | "CONTENT_DISABLED" |
    "CONTENT_EXCLUDED" | "OUTPUT_LIMIT" | "TIMEOUT" |
    "NOT_GIT_REPOSITORY" | "GIT_FAILED" | "CACHE_FAILED" |
    "AI_DISABLED" | "AI_REQUEST_EXPIRED" | "AI_QUEUE_FULL" |
    "PROVIDER_MODEL_NOT_FOUND" | "PROVIDER_UNAVAILABLE" |
    "PROVIDER_TIMEOUT" | "PROVIDER_OUTPUT_INVALID" | "PROVIDER_OUTPUT_LIMIT";
  message: string;
  retryable: boolean;
  details: Record<string, string | number | boolean | null>;
};

type PublicWarning = {
  code: string;
  message: string;
  details: Record<string, string | number | boolean | null>;
};

type Envelope<T> = {
  schemaVersion: "1";
  generation: string;
  data: T | null;
  warnings: PublicWarning[];
  error?: PublicError;
};
```

Absolute repository and worktree paths never appear in public Web, CLI JSON, HTTP, or MCP output. Email addresses are not part of public schemas. Invalid UTF-8 path bytes use `encoding: "base64"`; `display` is a safe replacement rendering and `rawBase64` preserves identity. Text path filters cannot select base64 paths in version 0.1.

## Parent selection

`parentIndex` defaults to `null` in every public request.

- Root: `null` selects the empty tree and responds with `parentOid: null`; any numeric index is invalid.
- Normal commit: `null` selects index 0; explicit 0 is accepted.
- Merge commit: `null` selects index 0 (first parent); any valid explicit parent index is accepted.

## Visibility variants

MCP metadata policy returns `Status.files: null` and `CommitChanges.pathsIncluded: false`, with every change path set to `null`. `include_paths: true` is accepted only by `git_history_status` and `git_history_get_commit_changes`. Web and CLI local output include relative paths by default.

## Limits and ordering

- Commit page: default 50, maximum 200; materialized graph maximum 500.
- Refs: maximum 5,000, sorted by kind then name after parsing.
- Worktrees: maximum 1,000, current first then display name.
- Status files: maximum 2,000.
- Changes: maximum 1,000.
- Commit body: maximum 256 KiB UTF-8 with an explicit truncation warning.
- MCP text fallback: maximum 8 KiB; structured content is authoritative.
- Patch: maximum 200 KiB and 100 selected change entries.

Commit pages preserve Git topological/date order. Changes preserve Git diff order. Every capped collection reports a warning and, where applicable, truncation fields.

## Error transport mapping

| Code | HTTP | CLI exit | MCP |
|---|---:|---:|---|
| `INVALID_ARGUMENT`, `INVALID_OID` | 400 | 2 | `isError: true` |
| `CONTENT_DISABLED`, `CONTENT_EXCLUDED` | 403 | 3 | `isError: true` |
| `NOT_FOUND`, `NOT_GIT_REPOSITORY` | 404 | 4 | `isError: true` |
| `STALE_CURSOR`, `STATE_CHANGED` | 409 | 5 | `isError: true` |
| `OUTPUT_LIMIT` | 413 | 6 | `isError: true` |
| `TIMEOUT` | 504 | 7 | `isError: true` |
| `GIT_FAILED` | 500 | 1 | `isError: true` |
| `CACHE_FAILED` | not exposed | 1 | not exposed |
| `AI_DISABLED`, `PROVIDER_MODEL_NOT_FOUND`, `PROVIDER_UNAVAILABLE` | 503 | 1 | not exposed |
| `AI_REQUEST_EXPIRED` | 409 | 1 | not exposed |
| `AI_QUEUE_FULL` | 429 | 1 | not exposed |
| `PROVIDER_TIMEOUT` | 504 | 1 | not exposed |
| `PROVIDER_OUTPUT_INVALID` | 502 | 1 | not exposed |
| `PROVIDER_OUTPUT_LIMIT` | 413 | 1 | not exposed |

HTTP errors use the normal envelope with `data: null` and `error: PublicError`. CLI JSON uses that envelope on stderr and prints nothing to stdout on failure. MCP uses the same failure envelope with `isError: true`; its text block is only `code: message`.

Before 1.0, compatible additions may add optional fields. Removing fields, changing meaning/nullability, or adding enum variants requires a `schemaVersion` change and a new HTTP API major path.

## Operation outputs

| Operation | `Envelope<T>.data` type |
|---|---|
| repository | `Repository` |
| status | `Status` |
| refs | `Page<Ref>` |
| commits | `Page<CommitSummary>` |
| commit | `Commit` |
| changes | `CommitChanges` |
| patch | `Patch` |
| worktrees | `Page<Worktree>` |
| unpushed | `Page<CommitSummary>` |
| generation | `{ generation: string }` |
| AI capabilities | provider policy plus browser-session CSRF token |
| AI explanation preview | short-lived request ID, exact evidence preview, provider and byte-count metadata |
| AI explanation | validated `AiExplanation`, cache status, and optional cache-write warning |
| official docs preview | version-neutral registry items, short-lived request ID, and fixed retrieval limits; no network access |
| official docs fetch | bounded server-owned excerpts and per-item safe failure codes |
| grounded AI preview | exact combined commit/excerpt evidence, server-owned citation targets, provider and byte-count metadata |
| grounded AI explanation | separate strict explanation schema with validated citation IDs and server-owned target mapping |
| cache status | `{ entries: number; bytes: number; oldestModifiedAt: IsoDate \| null; newestModifiedAt: IsoDate \| null }` |
| cache clear | `{ removedEntries: number; removedBytes: number }` |

Cache CLI JSON uses the normal envelope with the fixed generation marker `cache-v1`. Cache records themselves are private implementation data and are not part of the public transport schema.

Grounded output adds `citations: Array<{ citationId, supportsJa }>` to the explanation body. `citationId` must exactly match one of the at-most-two IDs in the previewed `officialDocuments`; duplicates and model-generated URLs or titles are invalid. The execution response returns `citationTargets: Array<{ citationId, title, url }>` only for cited IDs, with title and URL reconstructed from the compiled registry. Metadata-only `AiExplanation` remains unchanged.
