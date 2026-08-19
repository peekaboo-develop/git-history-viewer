# Roadmap

This roadmap separates local Git history, remote development machines, and Git-hosting services. They have different trust boundaries and must not be combined behind one vague “remote repository” feature.

## v0.1: local-first public alpha

Status: implemented; release readiness in progress.

- Read one explicitly selected local working copy.
- Show locally available branches, tags, worktrees, remote-tracking refs, and unpushed commits.
- Never fetch, pull, push, clone, or mutate Git state.
- Run the Web server on authenticated loopback only.
- Expose local stdio MCP with metadata-only defaults.

Remote-tracking refs represent the last state fetched by the user's existing Git workflow. The viewer does not claim they are current on the hosting service.

## v0.2: documented remote-machine operation

Goal: support repositories whose authoritative working copy is on a VM, development server, or remote workstation without adding credential management to the application.

- Document running the exact viewer version on the remote machine.
- Document manual SSH local-port forwarding to the remote loopback listener.
- Test session bootstrap, Host/Origin checks, disconnect behavior, and clean shutdown through the tunnel.
- Evaluate MCP over `ssh -T` with no pseudo-terminal, no interactive prompt, and no stdout banners.
- Keep SSH configuration, keys, agents, `known_hosts`, bastions, and user authentication under the system OpenSSH client.

This phase adds guidance and compatibility tests, not an application-managed SSH connection.

## v0.3: managed SSH connection profiles

Goal: reduce repetitive terminal setup only if v0.2 usage demonstrates demand.

Candidate profile fields are a display name, an existing SSH config alias, and an absolute remote repository path. Profiles must not contain passwords, private keys, tokens, arbitrary SSH options, arbitrary commands, or shell fragments.

Required security gates:

- Use the system SSH client and preserve strict host-key verification.
- Accept only a constrained SSH config alias and validated repository path.
- Do not interpolate browser input into a remote shell command.
- Pin a compatible remote `git-history-viewer` version before exposing data.
- Keep the remote listener on loopback and forward only one explicitly owned local port.
- Reject port conflicts; never stop unrelated listeners or silently choose a different target.
- Track SSH and remote viewer processes and clean them up after disconnect or application exit.
- Keep MCP stdout free of login banners and diagnostics.
- Add hostile alias/path, disconnect, timeout, version mismatch, port collision, and orphan-process tests.
- Complete a separate security review before implementation and again before release.

Automatic Git fetch remains excluded. Users continue to control when remote-tracking refs are updated.

## Later: Git-hosting service integration

Direct GitHub, GitLab, or other hosting APIs are not part of the SSH phases. Consider them only after a concrete use case cannot be satisfied by a local clone or remote-machine viewer.

Any proposal requires a separate design for OAuth or token scope, secret storage, organization policy, rate limits, private-repository consent, API data retention, endpoint allowlisting, and revocation. Clone, fetch, pull, push, hosted multi-user service, and remote HTTP MCP remain out of scope until explicitly approved.
