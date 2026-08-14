# Security and privacy design

## Trust boundaries

1. The repository and every string stored in Git are untrusted input.
2. The local browser is authenticated but repository content remains untrusted.
3. The MCP host controls model invocation; the MCP server controls only bounded Git reads.
4. Cloud LLMs and official-document sites are external recipients and require separate consent.

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
| SSRF in future docs resolver | HTTPS official-domain registry, DNS/IP checks, redirect revalidation, no arbitrary URL | compromised official site |
| supply-chain compromise | minimal dependencies, exact lockfile, CI audit, OIDC/provenance releases | signed provenance is not a code audit |

## Read-only enforcement

An allowlist test records every Git operation name, fixed argv prefix, and permitted dynamic slot. Unknown operations fail and no generic Git executor is reachable from a public adapter. A mutator/network denylist is defense in depth, not the primary control. `GIT_OPTIONAL_LOCKS=0` prevents optional index locks, and the project never calls fetch or credential helpers. Read-only means “the program intentionally issues no Git or filesystem writes”; it cannot prevent Git itself or third-party malware from changing files.

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

## Future Web AI consent

Before a cloud request, show provider, endpoint origin, model, commit OID, parent comparison, included/excluded files, and exact byte count. Require an explicit user action for every analysis. Do not send in the background, persist keys in localStorage, or cache raw prompts/responses by default.

Ollama defaults to a loopback URL. Cloud base URLs must use HTTPS and are configured at process startup, never supplied by a browser request.

## Release security gates

- Cross-platform tests on Node 22 and 24.
- MCP conformance and stdout-purity tests.
- Packed-tarball inspection and smoke tests.
- Dependency/license audit.
- No personal paths, session tokens, keys, or repository samples in artifacts.
- Checksums and rollback instructions for releases.
