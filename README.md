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

The optional Web AI flow is disabled unless an `--ai-profile` or the legacy `--ollama-model` option is supplied. Profiles support numeric-loopback Ollama and the official OpenAI, Anthropic, and Google APIs. Every provider previews the exact metadata payload and requires a second click before generation. When multiple profiles are enabled, the detail pane provides a model selector. Remote endpoints and credential names are fixed in code: OpenAI reads `OPENAI_API_KEY`, Anthropic reads `ANTHROPIC_API_KEY`, and Google reads `GEMINI_API_KEY`. Keys are never accepted from the browser or config file. Loopback does not by itself prove where Ollama executes a model. Patches, file contents, identities, absolute paths, refs, remotes, and commit IDs are not sent.

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
    },
    {
      "id": "claude-balanced",
      "label": "Claude balanced",
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "maxOutputTokens": 1536
    },
    {
      "id": "gemini-fast",
      "label": "Gemini fast",
      "provider": "google",
      "model": "gemini-2.5-flash",
      "maxOutputTokens": 1536
    }
  ]
}
```

Config changes require a restart. `--ai-profile` is repeatable and is the explicit allowlist for that Web session. Export the corresponding fixed key only when selecting a remote profile.

The AI-result cache uses bounded, sharded JSON files in the operating system's user cache directory. Cache metadata stores no API keys, raw prompts, diffs, repository paths, or remote URLs; generated results may still repeat sensitive source text. `--no-ai-cache` bypasses reads and writes. `cache clear` removes only recognized cache-entry files.

The commit detail pane can recommend up to two version-neutral links from a compiled registry of official documentation for strong path markers such as GitHub Actions workflows, Docker/Compose files, TSConfig, Vite config, and Vue SFCs. Link display performs no network access. A separate button can fetch bounded excerpts directly from those fixed official URLs through a DNS-rebinding-resistant, pinned-IP HTTPS transport. The destination can infer the detected technology, but repository names, paths, commits, messages, cookies, credentials, and referrers are not sent. Redirects are rejected. When AI is enabled, another separate preview and confirmation can send the displayed excerpts plus opaque citation IDs to the selected provider; official URLs and titles are never sent to the model and are mapped back only by the server. Version detection remains unavailable.

See `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/MCP.md`, and `docs/SECURITY.md` for the normative design.
