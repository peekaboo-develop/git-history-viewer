# Git History Viewer

A free, local-first, read-only Git history graph for the browser, CLI, and MCP clients.

> Alpha source tree. It has not been published to npm or GitHub yet.

## Development

```bash
npm install
npm test
node bin/git-history-viewer.mjs web . --port 0 --no-open
node bin/git-history-viewer.mjs web . --port 0 --no-open --ollama-model qwen3:4b
node bin/git-history-viewer.mjs mcp --repo /absolute/path --content-policy metadata
node bin/git-history-viewer.mjs cache status
```

The default MCP policy does not expose patches, author emails, or absolute paths. The application never fetches or mutates Git state.

The Web header includes an **AI接続** guide for verified Codex, Claude Code, and Cursor MCP setup templates. It never edits a client configuration or exposes the repository's absolute path. A selected commit can produce a short MCP prompt containing only its OID.

The optional Web AI flow is disabled unless `--ollama-model` is supplied. It connects only to numeric loopback Ollama (`http://127.0.0.1:11434` by default), rejects cloud-labelled models, previews the exact metadata payload, and requires a second click before generation. Loopback does not by itself prove where Ollama executes a model. Patches, file contents, identities, absolute paths, refs, remotes, and commit IDs are not sent.

The AI-result cache uses bounded, sharded JSON files in the operating system's user cache directory. Cache metadata stores no API keys, raw prompts, diffs, repository paths, or remote URLs; generated results may still repeat sensitive source text. `--no-ai-cache` bypasses reads and writes. `cache clear` removes only recognized cache-entry files.

See `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/MCP.md`, and `docs/SECURITY.md` for the normative design.
