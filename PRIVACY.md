# Privacy

Git History Viewer has no telemetry and makes no network requests by default. Repository data stays on the local machine.

MCP clients may send returned data to their configured model provider. Commit messages, branch names, and relative paths can be confidential even when patch access is disabled. Patch access is absent in the default `metadata` policy and must be enabled explicitly when the MCP process starts.

Redaction is best effort and is not a guarantee that a patch contains no secret or private information.

## Optional Web AI and result cache

Web AI is disabled by default. When explicitly started with an AI profile or legacy `--ollama-model`, the browser previews the exact commit message and relative changed paths before a second action sends them to the selected provider. Patches, file contents, identities, absolute paths, refs, remotes, and commit IDs are excluded. Secret-looking paths and common token shapes are filtered, but commit messages and filenames can still be confidential. Ollama is restricted to numeric loopback and cloud-labelled model names are rejected. OpenAI and Anthropic profiles send the displayed metadata to their fixed official API endpoint and may incur account charges.

The cache stores validated generated results plus provider, model, operation, language, and prompt-version labels. Cache metadata does not store API keys, raw prompts, diffs, absolute repository paths, or remote URLs. Generated text can still repeat confidential repository information. Use `--no-ai-cache` to bypass cache reads and writes, and `git-history-viewer cache clear` to remove recognized entries.

Cache files are placed in the operating system's discardable per-user cache directory, use private POSIX permissions where supported, and may be deleted by the operating system at any time.
