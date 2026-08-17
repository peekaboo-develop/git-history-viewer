# Git History Viewer product specification

Status: implementation baseline  
Version: 0.1  
Date: 2026-08-14

## Product promise

Git History Viewer is a free, local-first, read-only Git history viewer for people who want to understand repository history without opening an IDE. It provides the same repository model to a browser UI, a CLI, and local MCP clients.

The product does not mutate a repository, contact remotes, or send repository content over the network by default.

## Target users

- Developers who want a compact commit graph outside an IDE.
- Japanese-speaking users who want AI-assisted explanations of unfamiliar commits and terms.
- Agent users who need a constrained Git history MCP server.
- Teams that cannot send private source code to an operator-hosted service.

## Product boundaries

### Version 0.1

- Topological commit graph with branches, remote-tracking refs, tags, merges, and unpushed state.
- A separate horizontal topology view that folds linear runs and emphasizes branch tips, tags, worktrees, roots, and merges.
- Current checkout status and metadata for linked worktrees.
- Commit metadata and first-parent file-change summaries.
- Loopback-only authenticated Web UI and versioned HTTP API.
- CLI inspection commands with JSON output.
- Local stdio MCP server with metadata-only defaults.
- Opt-in redacted or full commit patch access for MCP.
- MCP prompts for Japanese commit explanation and evidence-based risk review.
- Light and dark themes. With no saved manual choice, the operating-system preference is followed.

### Later versions

- Optional Web UI AI adapters for user-owned cloud keys and loopback Ollama.
- A curated official-document resolver with verified primary domains and citations.
- Standalone binaries and native packaging after Node/npm adoption is validated.

### Non-goals

- Git writes: checkout, commit, merge, rebase, reset, stash, clean, or file editing.
- Remote operations: fetch, pull, push, GitHub OAuth, or PAT storage.
- Hosted multi-user service or remote HTTP MCP.
- Operator-funded cloud LLM usage.
- Working-tree patch content, recursive submodule content, or binary patch content.
- Numeric commit scores, author rankings, or assertions that a person wrote a “good” or “bad” commit.
- Arbitrary file reads, Git arguments, revisions, paths, or URL fetching.

## Distribution

- Working package name: `@peekaboo-develop/git-history-viewer`.
- CLI binary: `git-history-viewer`.
- Runtime: Node.js 22 or later and Git 2.40 or later.
- Initial channels: public npm package and GitHub source/releases.
- License: Apache-2.0. The legal copyright holder must be named before public release.
- No telemetry.

The existing personal Codex skill remains installed until package parity is proven. The public package becomes the implementation source of truth; the skill becomes a thin launcher and never downloads `latest` automatically.

## Public CLI

```text
git-history-viewer web [repo] [--port 0|PORT] [--limit 20..500] [--no-open]
git-history-viewer mcp --repo PATH [--content-policy metadata|redacted|full] [--exclude-path PREFIX]...
git-history-viewer inspect repository|status|refs|commits [--repo PATH] [--json]
git-history-viewer inspect commit OID [--repo PATH] [--json]
git-history-viewer inspect changes OID [--repo PATH] [--parent-index N] [--json]
git-history-viewer cache status|clear [--json]
git-history-viewer doctor [repo] [--json]
git-history-viewer version
```

`mcp` requires an explicit repository path because an MCP client's process working directory and roots are not authorization boundaries. MCP stdout is reserved for JSON-RPC; diagnostics use stderr.

`inspect` and `doctor` use cwd unless `--repo` is supplied. Human output is concise UTF-8 terminal text; `--json` emits only the normative schema envelope to stdout. `web` opens the system browser by default; integrations use `--no-open` and open the printed bootstrap URL themselves.

## Commit semantics

- Object IDs must be complete lowercase SHA-1 or SHA-256 values.
- Root commits compare against the empty tree.
- Normal commits compare against their only parent.
- Merge commits compare against the first parent by default.
- `parentIndex` is zero-based when supplied. `null` selects the empty tree for a root commit and the first parent otherwise.
- Commit reads are authorized only for objects reachable from local branches, remote-tracking refs, tags, or current checkout HEAD in the same generation; dangling objects are hidden.
- Annotated tag object IDs and peeled target commit IDs remain distinct.
- Remote refs represent the last local fetch. The viewer never fetches.

## AI experience

AI output evaluates change metadata, not authors. The Web adapter requires and validates this result shape:

```json
{
  "schemaVersion": "1",
  "summaryJa": "",
  "changes": [{ "titleJa": "", "detailJa": "", "evidencePaths": [] }],
  "terms": [{ "term": "", "explanationJa": "" }],
  "risks": [{
    "level": "low|medium|high|unknown",
    "rationaleJa": "",
    "evidencePaths": []
  }],
  "testObservations": [],
  "limitations": []
}
```

MCP prompts let the connected host supply a model; the MCP server itself never calls an LLM. Separately, the optional Web adapter can call an explicitly enabled loopback Ollama or OpenAI profile. It is disabled by default, sends metadata only, and requires payload preview plus per-request confirmation. Other cloud providers, arbitrary compatible endpoints, and official-document lookup remain out of scope.

The local AI-result cache is content-addressed, bounded, dependency-free, and stored outside repositories in the operating system's discardable user-cache directory. Its metadata never stores raw prompts, diffs, API keys, absolute paths, or remote URLs; generated results can still repeat confidential source text. `--no-ai-cache` bypasses it, while `cache status` and `cache clear` keep storage inspectable and removable.

## Release blockers

- Incorrect merge-parent change semantics.
- Repository writes or remote access from any code path.
- Absolute paths, author emails, or patches in default MCP results.
- Host, Origin, session, traversal, or XSS bypasses.
- MCP protocol/conformance failure or stdout contamination.
- Secrets or personal absolute paths in the packed npm artifact.
- Packed-package CLI/Web/MCP smoke test failure.

Public release additionally requires confirmation that the npm scope is controlled, the legal copyright holder is named, and a provenance audit confirms that third-party code or assets preserve their required notices.
