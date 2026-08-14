# Architecture

## Component model

```text
RepositoryReader core
├── CLI inspector
├── Web server and /api/v1
├── stdio MCP server
└── prompt/context builders

Optional future adapters
├── BYOK cloud LLM
├── loopback Ollama
└── official-document resolver
```

The core owns all Git subprocesses, parsing, output limits, repository state generation, and shared data schemas. It has no browser, HTTP-client, MCP, or LLM dependency.

## Source layout

```text
bin/git-history-viewer.mjs
src/
  cli/
  core/
  mcp/
  schema/
  web/
public/
integrations/codex-skill/
docs/
test/
```

Start as one npm package. Split packages only if independent consumers need the core API in practice.

## Public Node API

Version 0.1 exposes no supported Node library API. Package exports contain only the CLI entry point. This avoids freezing reader methods before CLI, HTTP, and MCP interoperability is proven. The Git executor and arbitrary argument arrays are never exported.

## Git execution boundary

Every operation maps a named internal operation to a fixed argument builder. Use `spawn('git', argv, { shell: false })` only. Set:

```text
GIT_OPTIONAL_LOCKS=0
GIT_TERMINAL_PROMPT=0
GIT_NO_LAZY_FETCH=1
GIT_PAGER=cat
LC_ALL=C
```

Every command also receives:

```text
-c core.fsmonitor=false
-c color.ui=false
-c core.pager=cat
```

Diff commands add:

```text
--no-ext-diff
--no-textconv
--no-binary
--submodule=short
```

Commands are serialized per reader. Default timeout is five seconds and total stdout is capped at eight MiB. A killed process must be reaped before the operation settles.

The only version 0.1 operations are `repoInfo`, `head`, `refs`, `status`, `worktrees`, `graph`, `unpushed`, `authorizeCommit`, `commitMeta`, `commitChanges`, and `commitPatch`. Snapshot tests fix each argv prefix and permitted dynamic slot. Unknown operations fail closed. OIDs enter validated OID slots; selected patch paths enter only after `--` and exact changed-path membership checks.

## Repository consistency

`generation` is a SHA-256 digest of HEAD, refs, current porcelain status, and worktree metadata. A multi-command read checks generation before and after. On mismatch, retry once; if it changes again, return `STATE_CHANGED`.

If untracked status alone would exceed the fingerprint cap, generation falls back to porcelain status with `--untracked-files=no` and emits `UNTRACKED_FINGERPRINT_OMITTED`. Pure untracked-file changes may then miss a generation update, while explicit status reads still return a bounded/truncated result.

Pagination is over a materialized topological result for one generation. The cursor contains a version, generation, operation, and numeric next offset, authenticated with a process-local secret. A last OID alone is not a valid topological resume point. A cursor from another state returns `STALE_CURSOR`.

## Shared response envelope

```json
{
  "schemaVersion": "1",
  "generation": "opaque-state-id",
  "data": {},
  "warnings": []
}
```

Dates use ISO 8601. Paths are repository-relative with `/` separators. Truncation always supplies `truncated`, `omittedCount`, and `nextCursor` when known.

Detailed field contracts are normative in [SCHEMAS.md](SCHEMAS.md). HTTP, MCP structured content, and CLI JSON use those same shapes; transport wrappers must not invent variants.

Stable errors:

```text
INVALID_ARGUMENT
INVALID_OID
NOT_FOUND
STALE_CURSOR
STATE_CHANGED
CONTENT_DISABLED
CONTENT_EXCLUDED
OUTPUT_LIMIT
TIMEOUT
NOT_GIT_REPOSITORY
GIT_FAILED
```

## Web boundary

- Bind only to `127.0.0.1`.
- Use a 256-bit process-lifetime session secret.
- Bootstrap with `/?token=...`, set an HttpOnly SameSite=Strict cookie, then redirect to a clean URL.
- Validate exact Host and same-origin Origin.
- Do not enable CORS.
- Serve only an explicit asset and API route allowlist.
- Apply CSP, `no-store`, `nosniff`, referrer denial, and frame denial.
- Use `textContent` for all repository-derived content.
- Preserve selection and scroll anchor across generation updates.

The token is a browser-session bootstrap token, not a one-time token. Version 0.1 exposes no Bearer-token automation contract; authenticated API access uses the browser's strict cookie only.

## Object authorization

A syntactically valid full OID is not sufficient authority. Before commit metadata, changes, or patch content is read, the core verifies that the commit is reachable from at least one local branch, remote-tracking ref, tag, or the current checkout HEAD in the same checked generation. Use fixed `for-each-ref --contains=<oid>` roots plus a current detached-HEAD ancestry check. Dangling and otherwise unreachable commits return `NOT_FOUND`.

This check occurs in the core, so Web, CLI, and MCP cannot bypass it.

## Process environment

Do not spread the parent process environment into Git. Build an allowlist containing only executable discovery and temporary-directory variables required on the current platform. Remove every inherited `GIT_*` variable first, then add only the fixed Git variables defined by this design. This prevents repository, object store, namespace, replace-ref, and configuration overrides from escaping the startup repository authority.

## HTTP API v1

```text
GET /api/v1/repository
GET /api/v1/status
GET /api/v1/refs
GET /api/v1/commits
GET /api/v1/commits/{oid}
GET /api/v1/commits/{oid}/changes
GET /api/v1/worktrees
GET /api/v1/unpushed
GET /api/v1/generation
```

Query contracts:

- `/commits?limit=1..200&cursor=<opaque>`; absent limit is 50.
- `/commits/{oid}/changes?parentIndex=<integer>`; absence uses the parent-selection rules.
- `/refs?kind=local&kind=remote&kind=tag`; absence means all kinds.
- `/unpushed?limit=1..200&cursor=<opaque>`; it has no branch selector in version 0.1.
- Unknown, repeated singleton, malformed, or unsupported parameters return `INVALID_ARGUMENT`.

With `--port 0`, Host and Origin allowlists are constructed only after the operating system reports the actual bound port.

Patch HTTP endpoints are absent in version 0.1. This keeps browser display and external-content disclosure as separate capabilities.

## Worktrees

Only the current checkout receives periodic `git status`. Other worktrees expose an opaque session ID, basename display label, HEAD, branch, locked, and prunable metadata. Absolute paths are not part of any public output, including Web UI. Running status across every linked worktree is intentionally unsupported because repositories may contain dozens of worktrees.
