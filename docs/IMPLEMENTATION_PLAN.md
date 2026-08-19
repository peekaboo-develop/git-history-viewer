# Implementation plan

## Phase 1: public core and parity

1. Freeze checksums of the current personal skill.
2. Scaffold an npm-managed TypeScript ESM package with a committed npm lockfile, `tsc` build, Node 22 support, and macOS/Linux/Windows CI for Node 22/24.
3. Extract Git parsing and fixed operations into the core.
4. Add consistent-generation reads, reachable-object authorization, typed errors, and the normative shared schemas in `SCHEMAS.md`.
5. Correct root, merge-parent, annotated-tag, binary, rename, and submodule semantics.
6. Port the local Web UI and `/api/v1` server.
7. Add the public CLI and JSON inspectors.

Gate: existing viewer parity plus core, Web security, merge, package, and cross-platform tests.

## Phase 2: MCP

1. Add the official TypeScript MCP SDK with a locked dependency graph.
2. Implement stdio lifecycle and metadata tools.
3. Verify stdout purity and structured output.
4. Add redacted/full patch policies and path/content caps.
5. Add Japanese explanation and risk-review prompts.

Gate: default privacy invariants, policy-based tool registration, conformance, prompt-injection labelling, and packed-package MCP smoke tests.

## Phase 3: integration and release readiness

Completed implementation work:

- Added the public README, privacy policy, security policy, and thin Codex launcher integration.
- Added cross-platform CI for Node 22/24 and deterministic package contents.

Remaining release gates:

1. Run the packed-tarball CLI, Web, and MCP smoke test on every supported CI platform.
2. Complete the dependency/license, personal-path, and generated-checksum audits.
3. Run manual browser QA, install-from-tarball QA, and rollback rehearsal.
4. Confirm the legal copyright holder, private vulnerability-reporting address, npm scope control, and public GitHub destination.
5. Prepare an alpha release without publishing it automatically.

Gate: manual browser QA, install-from-tarball QA, rollback test, and user approval for public GitHub/npm publication.

## Phase 4: optional embedded AI

Implemented:

- Use the existing content-addressed `AiCache` boundary; do not couple providers to its file layout.
- Support fixed-endpoint, environment-variable BYOK profiles for OpenAI, Anthropic, and Google after provider-specific security review.
- Keep the implemented preflight payload preview and per-request consent contract.
- Keep strict response schema and output caps.
- Do not depend on MCP client sampling; MCP remains the evidence/tool integration.
- Separate fact/evidence and model-opinion presentation.

Optional follow-up: add a browser preference if per-request no-cache behavior proves necessary; startup `--no-ai-cache` already bypasses storage.

## Phase 5: official documents

- 5A implemented: detect a small fixed set of technologies from strong changed-path markers and show compiled official links without network access.
- Keep version `unknown` until a future, separately consented manifest-reading design exists; never infer it from commit messages.
- 5B retrieval implemented: a separate same-origin/CSRF consent action fetches at most two bounded excerpts through a pinned-IP HTTPS transport and stores a five-minute in-memory document set.
- Resolve only through a curated official-domain registry.
- Reject redirects and any destination with a private/reserved DNS answer; pin TLS to an approved address and recheck the connected peer.
- Grounded AI implemented as a separate preview/execute API: excerpts and server-owned citation IDs are sent only after a second confirmation; model citations are validated and mapped back to compiled-registry links.
- Do not crawl automatically or accept arbitrary URLs.

## Rollback

Keep the current skill and its running server unchanged during implementation. Test the package on another port. If parity fails, stop only the new server and continue using the existing skill. Do not overwrite the skill until the packaged launcher passes its own forward test.
