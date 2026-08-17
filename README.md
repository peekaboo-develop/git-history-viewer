# Git History Viewer

A free, local-first, read-only Git history graph for the browser, CLI, and MCP clients.

> Alpha source tree. It has not been published to npm or GitHub yet.

## Development

```bash
npm install
npm test
node bin/git-history-viewer.mjs web . --port 0 --no-open
node bin/git-history-viewer.mjs web . --port 0 --no-open --ollama-model qwen3:4b
node bin/git-history-viewer.mjs config path
node bin/git-history-viewer.mjs config validate
node bin/git-history-viewer.mjs profiles list
node bin/git-history-viewer.mjs web . --ai-profile local-fast --ai-profile local-deep
node bin/git-history-viewer.mjs mcp --repo /absolute/path --content-policy metadata
node bin/git-history-viewer.mjs cache status
```

The default MCP policy does not expose patches, author emails, or absolute paths. The application never fetches or mutates Git state.

The Web header includes an **AI接続** guide for verified Codex, Claude Code, and Cursor MCP setup templates. It never edits a client configuration or exposes the repository's absolute path. A selected commit can produce a short MCP prompt containing only its OID.

The optional Web AI flow is disabled unless an `--ai-profile` or the legacy `--ollama-model` option is supplied. Profiles support numeric-loopback Ollama and the official OpenAI Responses API. Both preview the exact metadata payload and require a second click before generation. When multiple profiles are enabled, the detail pane provides a model selector. OpenAI uses only the fixed `https://api.openai.com/v1/responses` endpoint and reads `OPENAI_API_KEY` at process startup; the key is never accepted from the browser or config file. Loopback does not by itself prove where Ollama executes a model. Patches, file contents, identities, absolute paths, refs, remotes, and commit IDs are not sent.

The config path is OS-specific and printed by `config path`. The strict JSON format stores no credentials, arbitrary endpoints, prompts, or environment-variable names:

```json
{
  "schemaVersion": "1",
  "defaultProfileId": "local-fast",
  "profiles": [
    {
      "id": "local-fast",
      "label": "Local fast",
      "provider": "ollama",
      "model": "qwen3:4b",
      "ollamaPort": 11434,
      "maxOutputTokens": 1536
    },
    {
      "id": "openai-fast",
      "label": "OpenAI fast",
      "provider": "openai",
      "model": "gpt-5.4-mini",
      "maxOutputTokens": 1536
    }
  ]
}
```

Config changes require a restart. `--ai-profile` is repeatable and is the explicit allowlist for that Web session. Export `OPENAI_API_KEY` before startup only when selecting an OpenAI profile.

The AI-result cache uses bounded, sharded JSON files in the operating system's user cache directory. Cache metadata stores no API keys, raw prompts, diffs, repository paths, or remote URLs; generated results may still repeat sensitive source text. `--no-ai-cache` bypasses reads and writes. `cache clear` removes only recognized cache-entry files.

See `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/MCP.md`, and `docs/SECURITY.md` for the normative design.
