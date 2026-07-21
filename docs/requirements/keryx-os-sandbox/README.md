# Keryx OS Sandbox — Requirements Package
Version: 1.0.0

## Status

`implemented` — with an explicitly bounded platform matrix.

Filesystem containment and network-off are implemented and live-verified on
**macOS (Seatbelt)** and **Linux (bubblewrap)**. The domain allowlist, credential
masking and TLS termination are implemented on **macOS only**; on Linux a
restricted-network run **fails closed** with an explicit reason rather than
running with full host network. See [Platform matrix](#platform-matrix).

This package documents what exists in the code today. It does not describe
planned work except where a section is explicitly labelled as a gap.

## Purpose

The OS sandbox is a containment layer *underneath* keryx's policy engine. The
policy engine decides **what a command is allowed to ask for**; the OS sandbox
constrains **what the running process can actually do**, enforced by the kernel,
regardless of what the model chose to run.

Two independent entry paths use it:

- **Autonomous** — `keryx harness exec`, contained **by default**.
- **Interactive** — the agent's `shell_exec` tool, **opt-in** (each command is
  already gated behind human approval, and default-on breaks tools that write to
  global caches).

## Document index

| Document | Audience | Read it when |
|---|---|---|
| [prd.md](prd.md) | anyone | You want the problem, the goals, and why the boundaries are where they are. |
| [specification.md](specification.md) | implementer | You need the exact profile shape, CLI surface, env surface, data contracts and platform matrix. |
| [operator-guide.md](operator-guide.md) | **human** | You are running keryx and want to know which posture to use, what a denial looks like, and how to debug one. |
| [agent-protocol.md](agent-protocol.md) | **agent** | You are an agent deciding which flags to pass, how to read the result, and what to do when a run is blocked. |
| [verification.md](verification.md) | anyone | You want to know what was actually proven, how, and what remains unproven. |

Related, outside this package:

- [Linux verification runbook](../../verification/linux-sandbox-verification.md) —
  step-by-step manual validation on a real Linux host.
- [ADR-0006](../../decisions/keryx-harness/ADR-0006-os-sandbox-shell-exec.md) —
  why an OS sandbox, and why Seatbelt/bubblewrap over alternatives.
- [ADR-0007](../../decisions/keryx-harness/ADR-0007-tls-terminate-https-credential-masking.md) —
  why TLS termination is opt-in and why the CA is delivered by env var.

## Platform matrix

| Capability | macOS (Seatbelt) | Linux (bubblewrap) | Windows |
|---|---|---|---|
| Filesystem containment (`workspace-write`, `read-only`) | yes | yes | no launcher |
| Secret read-deny masking | yes | yes | no launcher |
| Network **off** | yes | yes | no launcher |
| Network **restricted** (domain allowlist) | yes | **fails closed** | no launcher |
| Credential masking (`--mask-env`) | yes | **fails closed** | no launcher |
| TLS termination (`--tls-terminate`) | yes | **fails closed** | no launcher |

"Fails closed" means the run is refused with a stated reason. It never degrades
to an unrestricted run.

Why restricted network is macOS-only: it requires "deny all network except this
one loopback socket". Seatbelt expresses that directly. bubblewrap cannot —
`--unshare-net` gives the process its *own* loopback, which is not the one the
proxy listens on, so reaching it needs a network namespace plus a relay. That
work is not done.

Windows has no launcher; with the default fail-closed posture a contained run is
refused there.

## Scope

**In scope**

- Kernel-enforced filesystem boundaries for a spawned command (workspace-write
  and read-only postures), plus deny-read masking of well-known secret paths.
- Network posture: off, on, or restricted to a domain allowlist via a loopback
  proxy.
- Credential masking: the contained process holds a per-run sentinel; the real
  value is substituted on the wire, only for named hosts.
- Reporting: which hosts the allowlist proxy allowed and denied.
- Fail-closed behaviour when a launcher is missing or a posture is unsupported.

**Out of scope**

- Replacing the policy engine, the structural command guard, the env allowlist,
  or the approval gate. The OS sandbox is an additional layer, not a substitute
  for any of them.
- Landlock/seccomp hardening on Linux (tracked separately).
- Native Windows containment (tracked separately).
- Restricting network by anything finer than hostname (no per-path or per-method
  rules).

## Related modules

| Module | Relationship |
|---|---|
| `src/harness/process/` | Owns the sandbox: profile, launchers, adapter, proxy, TLS CA. |
| `src/harness/policy/` | Produces the `PolicyProfile` that the sandbox profile is derived from. |
| `src/harness/tool/builtin/shell-exec-tool.ts` | Interactive agent entry path (opt-in). |
| `src/commands/harness.ts` | Autonomous CLI entry path (`keryx harness exec`, default-on). |
| `.metaproject/wiki/architecture/os-sandbox.md` | Wiki page pointing back at this package. |
