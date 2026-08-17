# Privacy

Git History Viewer has no telemetry and makes no network requests by default. Repository data stays on the local machine.

MCP clients may send returned data to their configured model provider. Commit messages, branch names, and relative paths can be confidential even when patch access is disabled. Patch access is absent in the default `metadata` policy and must be enabled explicitly when the MCP process starts.

Redaction is best effort and is not a guarantee that a patch contains no secret or private information.

## Optional AI-result cache

The cache foundation is local and inactive until an AI adapter explicitly uses it. It stores generated results plus provider, model, operation, language, and prompt-version labels. Cache metadata does not store API keys, raw prompts, diffs, absolute repository paths, or remote URLs. Generated text can still repeat confidential repository information, so users can disable caching in future AI adapters and can remove all recognized entries with `git-history-viewer cache clear`.

Cache files are placed in the operating system's discardable per-user cache directory, use private POSIX permissions where supported, and may be deleted by the operating system at any time.
