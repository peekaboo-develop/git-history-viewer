# Git History Viewer

A free, local-first, read-only Git history graph for the browser, CLI, and MCP clients.

> Alpha source tree. It has not been published to npm or GitHub yet.

## Development

```bash
npm install
npm test
node bin/git-history-viewer.mjs web . --port 0 --no-open
node bin/git-history-viewer.mjs mcp --repo /absolute/path --content-policy metadata
node bin/git-history-viewer.mjs cache status
```

The default MCP policy does not expose patches, author emails, or absolute paths. The application never fetches or mutates Git state.

The optional AI-result cache uses bounded, sharded JSON files in the operating system's user cache directory. Cache metadata stores no API keys, raw prompts, diffs, repository paths, or remote URLs; generated results may still repeat sensitive source text. `cache clear` removes only recognized cache-entry files.

See `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/MCP.md`, and `docs/SECURITY.md` for the normative design.
