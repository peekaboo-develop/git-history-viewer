# Git History Viewer

A free, local-first, read-only Git history graph for the browser, CLI, and MCP clients.

> Alpha source tree. It has not been published to npm or GitHub yet.

## Development

```bash
npm install
npm test
node bin/git-history-viewer.mjs web . --port 0 --no-open
node bin/git-history-viewer.mjs mcp --repo /absolute/path --content-policy metadata
```

The default MCP policy does not expose patches, author emails, or absolute paths. The application never fetches or mutates Git state.

See `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/MCP.md`, and `docs/SECURITY.md` for the normative design.
