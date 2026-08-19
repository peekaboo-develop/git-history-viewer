# Release process

Releases are deliberate external actions. Preparing and testing an artifact does not authorize publishing it to npm or GitHub.

## Preconditions

- The worktree is clean and the release commit is reviewed.
- The legal copyright holder and private vulnerability-reporting address are configured.
- The npm scope and GitHub destination are controlled by the intended publisher.
- `npm audit --omit=dev`, the cross-platform CI matrix, and manual browser QA pass.

## Build and verify

```bash
npm ci
npm test
npm run test:pack
node -e "require('node:fs').mkdirSync('release-artifacts',{recursive:true})"
npm pack --pack-destination ./release-artifacts
node -e "const fs=require('node:fs');const crypto=require('node:crypto');for(const file of fs.readdirSync('release-artifacts').filter(x=>x.endsWith('.tgz'))){const sum=crypto.createHash('sha256').update(fs.readFileSync('release-artifacts/'+file)).digest('hex');console.log(sum+'  '+file)}"
```

Record the exact commit, package version, tarball filename, SHA-256 digest, Node/npm versions, and successful CI run. Inspect the tarball before any publish step and confirm it contains no personal paths, secrets, fixtures, or stale generated code.

Publishing, tagging, and creating a GitHub release require separate explicit approval. Never publish with a floating version or overwrite an existing release.

## Rollback

npm releases are immutable. Do not treat unpublishing as the normal rollback mechanism.

1. Stop recommending or installing the affected exact version.
2. Deprecate it with an accurate warning after explicit approval.
3. Direct users to a previously verified exact version.
4. Fix forward with a new version, rerun all release gates, and publish only after approval.
5. Preserve the affected artifact, checksum, and incident notes for investigation.

For the local Codex integration, keep the previously validated installed skill and CLI available until the new exact package version passes a forward launch and rollback rehearsal.
