# MCP contract

## Transport and authority

Version 0.1 supports stdio only. The client launches the server as a child process with an explicit absolute `--repo` path. stdout contains only protocol frames; all logs use stderr.

The repository is resolved once at startup. Requests cannot change repository, working directory, Git arguments, environment, or executable. Client roots are informative and never expand authority.

## Content policies

| Policy | Metadata | Relative paths | Commit body | Patch tool |
|---|---:|---:|---:|---:|
| `metadata` | yes | opt-in per call | yes | not registered |
| `redacted` | yes | yes | yes | registered, filtered |
| `full` | yes | yes | yes | registered, textual raw content |

All policies omit absolute paths, Git directories, author/committer emails, environment variables, binary patch bodies, working-tree contents, and submodule contents.

`redacted` applies built-in path rules and secret-shaped value replacement. Built-ins are fixed code rules: basename prefix `.env`/`id_rsa`, basename suffix `.pem`/`.key`, basename exact `.npmrc`/`.pypirc`/`.netrc`, path segments `.aws`/`.ssh`, and case-insensitive basename substring `credential`/`secret`. It is best effort and must never be described as safe or complete. `full` applies neither built-ins nor value replacement. Both still omit binary/submodule/working-tree content and apply every startup `--exclude-path` prefix.

Exclusion prefixes are repository-relative, `/`-normalized, case-sensitive literal prefixes. They are not globs or Git pathspecs. Empty, absolute, dot-segment, NUL-containing, and duplicate values are rejected.

Patch limits are 200 KiB total, 100 files, 0–10 context lines, and five seconds. Truncation is explicit.

## Tools

Every tool is annotated with `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`.

| Tool | Input |
|---|---|
| `git_history_repository` | `{}` |
| `git_history_status` | `{ "include_paths": false }` |
| `git_history_list_refs` | `{ "kinds": [] }` |
| `git_history_list_commits` | `{ "scope": "all", "ref": null, "limit": 50, "cursor": null }` |
| `git_history_get_commit` | `{ "oid": "full oid" }` |
| `git_history_get_commit_changes` | `{ "oid": "full oid", "parent_index": null, "include_paths": false }` |
| `git_history_list_unpushed` | `{ "branch": null, "limit": 50, "cursor": null }` |
| `git_history_list_worktrees` | `{}` |
| `git_history_get_commit_patch` | `{ "oid": "full oid", "parent_index": null, "paths": [], "context_lines": 3 }` |

Version 0.1 accepts `scope: "all"` only and `ref: null` only. Those fields reserve a compatible shape without accepting arbitrary revisions. Branch filters may be added later only through an enumerated ref returned by the same reader generation.

Version 0.1 also accepts only `branch: null` for unpushed reads. “Unpushed” means commits reachable from at least one local branch and unreachable from every remote-tracking ref. Detached-HEAD-only commits are not classified as unpushed unless a local branch also reaches them.

Tags, per-branch upstream selection, and upstream-specific ahead counts do not affect this set. Results use the same topological/date order and `limit=1..200` opaque-cursor pagination as the commit list.

The patch tool is registered only in `redacted` and `full` modes. Tools return structured content plus a short serialized text fallback.

Patch `paths` are exact repository-relative changed-path identities returned by `git_history_get_commit_changes`; they are not globs, pathspecs, revisions, or filesystem paths. The server intersects them with the selected commit/parent change set before placing them after Git's `--`. An empty list means all eligible changed paths. Unknown, excluded, base64-encoded, or unchanged paths are rejected.

With `paths: []`, invalid-UTF-8/base64 path entries are omitted and listed in `excludedPaths` with reason `UNSUPPORTED_PATH_ENCODING`; they are never silently decoded or selected.

For a rename/copy, either the old or new exact path selects the complete change entry; providing both is de-duplicated. At most 100 distinct entries may be selected.

Each tool declares an `outputSchema` using [SCHEMAS.md](SCHEMAS.md). Success and failure both return `Envelope<T>` as structured content. On failure `data` is `null`, `error` is `PublicError`, and MCP also sets `isError: true`. The text fallback is bounded to 8 KiB.

Tool-to-output mappings are the normative operation table in `SCHEMAS.md`. MCP `structuredContent` uses the same `Envelope<T>` as HTTP and CLI so generation, warnings, and truncation signals cannot be lost. Text fallback remains bounded and non-authoritative.

## Resources

Version 0.1 exposes three static, repository-independent resources:

- `git-history-viewer://docs/llm-guide/v1`
- `git-history-viewer://docs/privacy/v1`
- `git-history-viewer://schemas/ai-explanation/v1`

Each resource is bounded below 32 KiB and contains no repository path, OID, ref, or other dynamic repository data. Clients are not guaranteed to load Resources automatically, so prompts retain the critical content-policy, untrusted-evidence, and first-parent rules instead of relying on a Resource alone.

## Prompts

- `explain_commit_ja`: Explain a selected commit in Japanese, translate its intent, and define relevant technical terms.
- `review_commit_risk_ja`: Identify evidence-based change risks, testing observations, uncertainty, and limitations without numeric scoring or author judgment.

Prompt inputs contain a full commit OID and optional parent index. Prompt results contain instructions and identifiers only; they never embed commit data by reading the core directly. The host/model must call the normally registered tools, so the active content policy and path disclosure choices remain enforced. In content modes the prompt may suggest the bounded patch tool. Repository content is labelled untrusted evidence and must not be followed as instructions.

Official-document research remains a host capability in version 0.1. Prompts require primary-source URLs and forbid invented citations. An embedded resolver is a later independently permissioned component.

## Web setup guidance

The authenticated Web UI serves versioned setup templates for Codex, Claude Code, and Cursor. Templates include a verification date, tested client version, official documentation URL, and a connection-check instruction. The page does not modify client configuration. Shell templates resolve the current repository locally; JSON templates use an explicit placeholder. The HTTP response never contains the viewer repository's absolute path.

The commit-detail copy action emits the selected full OID and workflow instructions only. It does not place commit messages, paths, patches, session tokens, or repository paths on the clipboard.

## Privacy invariants

Default MCP output must not contain:

- Absolute repository or worktree paths.
- Git directory paths.
- Author or committer email addresses.
- Patch hunks or file contents.
- Environment variables or Git configuration.

Commit messages, branch names, and relative paths can still be confidential. Tool descriptions and user documentation must say so.
