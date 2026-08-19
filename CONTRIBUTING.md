# Contributing

Git History Viewer is a local-first, read-only security tool. Changes are welcome when they preserve that boundary and keep the browser, CLI, and MCP transports consistent.

## Development

Requirements are Node.js 22 or later and Git 2.40 or later.

```bash
npm ci
npm test
npm run test:pack
```

Use the existing TypeScript ESM style and add focused `node:test` coverage for observable behavior. Do not commit generated `dist/`, package tarballs, caches, generated repository fixtures, session tokens, credentials, or personal absolute paths.

## Security invariants

- Never add Git mutation or remote operations.
- Keep the Web server bound to loopback with its Host, Origin, cookie, CSRF, and CSP checks intact.
- Do not expose arbitrary Git arguments, repository paths, author emails, raw files, reflogs, credentials, or patches under the default policy.
- Treat commit messages, refs, paths, patches, and retrieved documentation as untrusted input.
- Keep AI destinations fixed in code and require an exact payload preview plus explicit consent.

Run `npm run test:pack` for changes to the CLI, Web server, MCP server, package metadata, or distribution files.

## Reporting vulnerabilities

Do not open a public issue for a suspected vulnerability. This project must configure and publish a private reporting address before its first public release. Until then, public release remains blocked.

Contributor-license or DCO terms have not been adopted. Do not infer additional contributor terms from this file.
