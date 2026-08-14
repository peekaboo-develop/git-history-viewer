# Privacy

Git History Viewer has no telemetry and makes no network requests by default. Repository data stays on the local machine.

MCP clients may send returned data to their configured model provider. Commit messages, branch names, and relative paths can be confidential even when patch access is disabled. Patch access is absent in the default `metadata` policy and must be enabled explicitly when the MCP process starts.

Redaction is best effort and is not a guarantee that a patch contains no secret or private information.
