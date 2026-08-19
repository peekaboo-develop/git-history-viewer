# Security and privacy design

## Trust boundaries

1. The repository and every string stored in Git are untrusted input.
2. The local browser is authenticated but repository content remains untrusted.
3. The MCP host controls model invocation; the MCP server controls only bounded Git reads.
4. Every enabled AI profile is a separate recipient. Loopback Ollama can itself use cloud models; OpenAI, Anthropic, and Google send the previewed metadata to their official APIs. Official-document retrieval requires a separate explicit consent action and reveals the inferred technology to the selected official site even though repository identifiers and content are omitted.

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
| remote provider credential leak or endpoint substitution | fixed provider endpoints and fixed `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`; no key, endpoint, or env-name fields in config/HTTP | parent-process environment remains trusted |
| cached model output leaks repository context | cache metadata omits raw input/path/URL/key, private cache permissions, bounded entries, explicit clear | generated output itself may repeat confidential text |
| cache path or symlink redirection | fixed OS cache root, content-addressed filenames, reject symlinked cache root/shards, no request-supplied paths | malware running as the same user |
| cache corruption or concurrent writes | same-directory temporary file and rename, schema validation, per-key in-process coalescing | cross-process last-writer wins |
| SSRF in official docs resolver | compiled exact HTTPS URLs, reject any private/reserved DNS answer, pin TLS connection to an approved IP, verify remote address, reject redirects and arbitrary URLs | compromised official site or public DNS |
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

Before any provider request, show provider, endpoint origin, model, commit OID, parent comparison, included/excluded files, and exact byte count. Require an explicit user action for every analysis. Do not send in the background or persist keys in localStorage. Cache only the validated structured result after explicit generation; never cache the raw prompt, raw diff, credentials, absolute paths, or remote URLs. `--no-ai-cache` bypasses both cache reads and writes.

Ollama accepts only a numeric loopback URL configured at process startup. The application does not pull, create, or delete models. OpenAI, Anthropic, and Google accept no configurable base URL and read only their fixed credential environment. Google additionally accepts only a bare model ID so a profile cannot alter the request path. Arbitrary compatible base URLs are not implemented.

## Official document consent

Path detection and link display perform no network access. A separate same-origin, CSRF-protected POST with a short-lived server-owned request ID is required before retrieval. The pinned HTTPS transport ignores proxy environment variables, sends no cookies, authorization, or referrer, rejects redirects and compression, and caps DNS answers, connection time, total time, raw bytes, pages, and extracted text. HTML is parsed locally; active and navigational elements are excluded. Retrieved excerpts remain untrusted data.

Successful excerpts are placed in a bounded five-minute in-memory document set bound to the full commit OID and repository generation. The browser cannot submit excerpt text, titles, URLs, citation IDs, or a document set in an AI POST. A separate grounded-preview GET resolves the server-owned set and displays the exact combined evidence; a second request-ID-only POST is required to contact the selected provider. The model receives excerpt text and stable citation IDs only. Model-returned IDs are allowlist-validated, and clickable titles and URLs are reconstructed from the compiled registry rather than model output. Grounded and metadata-only schemas, prompts, endpoints, and cache keys remain separate.

Canonical AI evidence is capped at 16 KiB and provider wire JSON at 48 KiB to account for structured-output schemas and JSON escaping. All enabled profiles and both metadata/grounded operations share one process-wide queue with one active request and at most four waiting requests.

## Release security gates

- Cross-platform tests on Node 22 and 24.
- MCP conformance and stdout-purity tests.
- Packed-tarball installation plus CLI, authenticated Web, and metadata MCP smoke tests.
- Dependency vulnerability and production-license allowlist audits.
- No personal paths, session tokens, keys, or repository samples in artifacts.
- Checksums and rollback instructions for releases.
