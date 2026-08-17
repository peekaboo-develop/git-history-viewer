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

1. Replace the personal Codex skill implementation with a thin installed-CLI launcher only after parity QA.
2. Add public README, contribution, privacy, and security reporting documents.
3. Audit `npm pack`, licenses, dependencies, and generated checksums.
4. Prepare an alpha release without publishing it automatically.

Gate: manual browser QA, install-from-tarball QA, rollback test, and user approval for public GitHub/npm publication.

## Phase 4: optional embedded AI

Loopback Ollama metadata-only MVP implemented; remaining work:

- Use the existing content-addressed `AiCache` boundary; do not couple providers to its file layout.
- Add environment-variable BYOK only after provider-specific security review.
- Keep the implemented preflight payload preview and per-request consent contract.
- Keep strict response schema and output caps.
- Add a browser preference if per-request no-cache behavior proves necessary; startup `--no-ai-cache` already bypasses storage.
- Do not depend on MCP client sampling; MCP remains the evidence/tool integration.
- Separate fact/evidence and model-opinion presentation.

## Phase 5: official documents

- Detect technology and version from changed paths and manifests.
- Resolve only through a curated official-domain registry.
- Revalidate redirects and reject private/local addresses.
- Store citation metadata and allow AI to cite retrieved IDs only.
- Do not crawl automatically or accept arbitrary URLs.

## Rollback

Keep the current skill and its running server unchanged during implementation. Test the package on another port. If parity fails, stop only the new server and continue using the existing skill. Do not overwrite the skill until the packaged launcher passes its own forward test.
