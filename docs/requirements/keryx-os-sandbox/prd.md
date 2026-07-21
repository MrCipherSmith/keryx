# Keryx OS Sandbox — PRD
Version: 1.0.0

## Problem

Before this work, every gate protecting a keryx command execution was a
**decision-time** gate: the structural guard rejected shell metacharacters, the
env allowlist limited which variables were forwarded, the policy engine decided
allow/ask/deny, and the interactive agent asked a human for approval.

All of those decide *what gets started*. None of them constrain the process
**once it is running**. An approved `bun install` could write anywhere the user
could write, read `~/.ssh`, and open any socket. For the autonomous path
(`keryx harness exec`), where no human sees each command, that gap is the whole
risk surface: one wrong command from a model is unbounded.

A second, subtler problem: a contained process that needs network usually needs
network to *one* place. Giving it the whole internet to reach one API is a large
grant for a small need — and if that API needs a token, the token has to sit in
the contained process's environment, where any code in that process can read and
exfiltrate it.

A third problem, discovered during this work: enforcement without reporting is
nearly useless. When the allowlist proxy denies a host it answers `403`, and
`curl` treats a `403` as a perfectly successful HTTP transaction. A blocked
request came back with `exitCode: 0` — indistinguishable from a successful one.

## Goal

Add a kernel-enforced containment layer under the existing gates such that:

1. A contained command can write only to the workspace roots it was granted.
2. A contained command reaches only the network it was granted — nothing, all, or
   a named set of hosts.
3. A credential can be *used* by a contained command without being *held* by it.
4. Every containment decision is either enforced or loudly refused — never
   silently downgraded.
5. Callers can see what the network layer actually did.

## Users

| User | Need |
|---|---|
| **Autonomous runner** (`keryx harness exec`, CI, agents-without-humans) | Containment on by default, with no configuration, and a hard refusal if containment is unavailable. |
| **Interactive operator** (agent `shell_exec`) | Containment available but not imposed — a human already approves each command, and default-on breaks tools writing to global caches. |
| **Agent** (the model choosing the flags) | An unambiguous rule for which posture to request, and a machine-readable answer about what happened. |
| **Security reviewer** | A written, honest boundary: what is enforced, on which platform, and what is not. |

## Requirements

### Functional

| # | Requirement |
|---|---|
| F1 | Project the policy profile onto an OS-sandbox profile: filesystem mode, network posture, writable roots, secret read-deny list, and whether containment is mandatory. |
| F2 | Enforce the filesystem boundary through the platform launcher: macOS Seatbelt (`sandbox-exec`), Linux bubblewrap (`bwrap`). |
| F3 | Support three network postures: `off`, `on`, `restricted`. |
| F4 | In `restricted`, deny all direct network and permit only a loopback allowlist proxy; enforce the allowlist per hostname, with `*.domain` covering the apex. |
| F5 | Support credential masking: the contained process receives a per-run sentinel; the proxy substitutes the real value on requests to named hosts only. |
| F6 | Support opt-in TLS termination so masking works over HTTPS, with the run CA delivered through CA-trust environment variables — never the system trust store. |
| F7 | Report every allow/deny ruling to the caller. |
| F8 | Fail closed: when the launcher is missing or the requested posture is unsupported on the platform, refuse the run with a stated reason. |

### Non-functional

| # | Requirement |
|---|---|
| N1 | Zero new npm dependencies. Containment uses system binaries (`sandbox-exec`, `bwrap`, `openssl`) already present on the platform. |
| N2 | The profile builders are pure — no clock, randomness, filesystem or network — so they are unit-testable without spawning anything. (Exception: bubblewrap mask-target classification must consult the filesystem; see specification.) |
| N3 | Real-process tests are capability-gated behind `KERYX_ALLOW_REAL_SUBPROCESS=1`, so a normal `bun test` spawns nothing. |
| N4 | Secret values never appear in logs, receipts, hashes, or decision reports. |
| N5 | The proxy must keep serving while the main thread is blocked inside `spawnSync`, therefore it runs in a worker thread. |

## Success criteria

| # | Criterion | Status |
|---|---|---|
| S1 | A write outside the workspace is denied while a write inside succeeds — verified as a *pair*, on a real kernel. | met (macOS + Linux CI) |
| S2 | A contained command with network off cannot reach the internet, verified against an unsandboxed control on the same host. | met (macOS + Linux CI) |
| S3 | An allowlisted host is reachable and a non-allowlisted host is not, against the real internet. | met (macOS) |
| S4 | A masked credential reaches the upstream server while the contained process holds only a sentinel. | met (macOS) |
| S5 | A denied host is visible to the caller as a denial, not as a successful run. | met |
| S6 | An unavailable launcher or unsupported posture refuses the run rather than running uncontained. | met, asserted by test on Linux |

## Risks

| # | Risk | Mitigation | Residual |
|---|---|---|---|
| R1 | A launcher that fails to start blocks everything, which is indistinguishable from perfect containment — so a broken sandbox can look like a working one. | Every network and filesystem check is specified as a **pair** with a control; the verification runbook names the false-pass for each check. | Requires discipline when verifying manually. |
| R2 | TLS termination is a MITM. A run-scoped CA in the system trust store would be a host-wide trust decision. | The CA is delivered only through environment variables scoped to the run, and the private key never leaves the proxy worker. | Go-based tools ignore those variables and break under termination. Documented, not fixed. |
| R3 | Credential masking over HTTPS silently does nothing without TLS termination — the sentinel would leave the sandbox unchanged and auth would fail confusingly. | `--mask-env` without `--tls-terminate` is rejected outright. | None. |
| R4 | Restricted network is unavailable on Linux, which is where most servers run. | Fails closed with an explicit reason; asserted by a Linux CI test. | Real capability gap; see Gaps. |
| R5 | Masking substitutes a sentinel string anywhere it appears in request headers, so a sentinel colliding with unrelated content would corrupt a request. | Sentinels are `keryx-sentinel-<uuid>`, per run. | Negligible. |

## Recommendation

Keep the current split: **default-on for the autonomous path, opt-in for the
interactive path.** The autonomous path has no human in the loop and must be
contained by default; the interactive path already has a human approving each
command, and forcing containment there breaks ordinary tooling in a way that
trains users to disable the sandbox entirely — a worse outcome than not having it
on by default.

Keep fail-closed as the default. The alternative — falling back to an
uncontained run when a launcher is missing — converts a loud, fixable
configuration problem into a silent loss of the entire boundary.

## Gaps

| Gap | Impact | Tracked |
|---|---|---|
| Restricted network / masking / TLS termination unavailable on Linux. | The allowlist and credential masking cannot be used on Linux servers. | Needs a network namespace plus a relay. |
| No Landlock/seccomp hardening on Linux. | Containment relies on mount namespaces only. | flow 099 |
| No native Windows containment. | Contained runs are refused on Windows. | flow 100 |
| Six `KERYX_SANDBOX_*` environment variables with no config-file equivalent. | Configuration is per-invocation only. | Deferred deliberately: the verification runbook is written against these variables. |
