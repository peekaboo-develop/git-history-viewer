# Security and privacy design

## Trust boundaries

1. The repository and every string stored in Git are untrusted input.
2. The local browser is authenticated but repository content remains untrusted.
3. The MCP host controls model invocation; the MCP server controls only bounded Git reads.
4. Loopback Ollama is a separate recipient and can itself use cloud models; cloud LLMs and official-document sites require separate future consent.

## Threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Browser-to-localhost request forgery | loopback bind, exact Host/Origin, random session secret, strict cookie, no CORS | malware running as the same user |
| XSS from refs, messages, and filenames | DOM `textContent`, CSP, JSON serialization | browser/runtime vulnerabilities |
| Git argument injection | fixed operation builders, complete OIDs, `--` before paths, no shell | Git vulnerabilities |
| executable Git helpers | disable fsmonitor, pager, prompt, lazy fetch, ext-diff, textconv | regression when adding commands |
| resource exhaustion | serialized commands, time/byte/file/commit caps, process cleanup | very large repositories are partial |
| data leakage to an MCP model | metadata-only default, no email/absolute paths, content policy at startup | messages and relative paths may be sensitive |
| patch leakage | patch tool absent by default, explicit startup policy and request | redaction misses secrets |
| prompt injection from source text | mark evidence untrusted; prompts forbid obeying repository instructions | model behavior cannot be guaranteed |
| localhost AI request forgery | strict session, mandatory exact Origin and CSRF for POST, 1 KiB body, short-lived server-owned request ID | malware running as the same user |
| AI provider SSRF or redirection | numeric loopback origin fixed at startup, fixed paths, redirects rejected | compromised local Ollama service |
| unintended Ollama cloud execution | reject cloud-labelled model names and warn that loopback is not an execution-location guarantee | aliases or future naming can evade detection |
| cached model output leaks repository context | cache metadata omits raw input/path/URL/key, private cache permissions, bounded entries, explicit clear | generated output itself may repeat confidential text |
| cache path or symlink redirection | fixed OS cache root, content-addressed filenames, reject symlinked cache root/shards, no request-supplied paths | malware running as the same user |
| cache corruption or concurrent writes | same-directory temporary file and rename, schema validation, per-key in-process coalescing | cross-process last-writer wins |
| SSRF in future docs resolver | HTTPS official-domain registry, DNS/IP checks, redirect revalidation, no arbitrary URL | compromised official site |
| supply-chain compromise | minimal dependencies, exact lockfile, CI audit, OIDC/provenance releases | signed provenance is not a code audit |

## Read-only enforcement

An allowlist test records every Git operation name, fixed argv prefix, and permitted dynamic slot. Unknown operations fail and no generic Git executor is reachable from a public adapter. A mutator/network denylist is defense in depth, not the primary control. `GIT_OPTIONAL_LOCKS=0` prevents optional index locks, and the project never calls fetch or credential helpers. Read-only means “the program intentionally issues no repository or Git-state writes.” Optional AI-result cache writes occur only in the operating system's discardable user-cache directory and never inside the repository.

## Content exclusions

Redacted patch mode omits matching paths before content is read. Built-in matching is fixed and separate from user literal-prefix exclusions:

```text
basename prefix `.env` or `id_rsa` (case-sensitive)
basename suffix `.pem` or `.key` (case-sensitive)
basename exact `.npmrc`, `.pypirc`, or `.netrc` (case-sensitive)
path segment exact `.aws` or `.ssh` (case-sensitive)
basename substring `credential` or `secret` (ASCII case-insensitive)
```

It also replaces common private-key and token-shaped values. The UI and CLI must state that this is a convenience filter, not a security guarantee.

Full patch mode does not apply the default exclusions or value replacement. Both patch modes always omit binary/submodule content and honor literal startup exclusion prefixes.

## Web AI consent

Before an Ollama request, show provider, endpoint origin, model, commit OID, parent comparison, included/excluded files, and exact byte count. Require an explicit user action for every analysis. Do not send in the background or persist keys in localStorage. Cache only the validated structured result after explicit generation; never cache the raw prompt, raw diff, credentials, absolute paths, or remote URLs. `--no-ai-cache` bypasses both cache reads and writes.

Ollama accepts only a numeric loopback URL configured at process startup. The application does not pull, create, or delete models. BYOK cloud base URLs are not implemented.

## Release security gates

- Cross-platform tests on Node 22 and 24.
- MCP conformance and stdout-purity tests.
- Packed-tarball inspection and smoke tests.
- Dependency/license audit.
- No personal paths, session tokens, keys, or repository samples in artifacts.
- Checksums and rollback instructions for releases.
