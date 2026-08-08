# ADR-0010: Linux containment without privilege — Landlock first, bubblewrap fallback, container as an opt-in profile

- **Status:** Proposed (found by shell-benchmark run 3, 2026-08-08). **Delivery
  shape settled 2026-08-08** by the flow-143 spike — see *Delivery shape* below.
- **Date:** 2026-08-08
- **Relates to:** ADR-0006 (OS sandbox for real shell execution) — this replaces
  its Linux launcher choice and **corrects** its "Deferred to v1.x" framing of
  Landlock. ADR-0003 (security profiles) is unaffected: this changes the
  enforcement mechanism, not the policy above it.

## Context

ADR-0006 chose `bubblewrap` for Linux and deferred "**Landlock + seccomp**
hardening on Linux (bwrap ro-bind already enforces the FS boundary)". That
sentence treats Landlock as extra armour on a boundary that already holds. On a
current Ubuntu the boundary does not hold at all, and Landlock is not extra
armour — it is the only one of the two that needs no privilege.

**Measured on this host** (Ubuntu 24.04, kernel 6.8.0-136-generic), while
unblocking benchmark case C4:

- `bubblewrap` 0.9.0 installs from the stock repository without complaint.
- Every contained run then fails: `bwrap: setting up uid map: Permission denied`.
- Cause: `kernel.apparmor_restrict_unprivileged_userns = 1`, an Ubuntu default
  since 23.10. bubblewrap builds its boundary out of **unprivileged user
  namespaces**, which is exactly the privilege the distribution withdrew.
- Landlock needs none of that — no namespace, no privilege, no profile. Measured
  ABI on this host: **4** (kernel ≥ 6.7 → filesystem **and** TCP bind/connect).

**The defect that matters most is not the failure, it is the report.** Both
`scripts/install.sh` and `keryx sandbox status` decided containment from
`command -v bwrap`, and both printed

```
Filesystem containment and network-off are available.
```

while every contained run was dying. Presence of a binary was being reported as
a working boundary. A user who reads that line believes they are contained when
they are not — and `sandbox status` exists (flow 142 / P4) precisely to stop
keryx making claims it has not checked.

**Field evidence**, read off the two CLIs installed on this same host rather
than from their documentation:

| CLI | `landlock` | `bwrap`/`bubblewrap` | `seccomp` |
|---|---|---|---|
| Codex 0.146.0 | **31** | 20 | 16 |
| Claude Code | **0** | 22 / 18 | 56 |

keryx's mechanism choice is identical to Claude Code's, so Claude Code meets the
same wall on current Ubuntu. Codex does not, because it does not depend on user
namespaces. The survey in ADR-0006 ("Codex CLI, grok-build, Claude Code…") read
the *paradigm* correctly — kernel isolation over approval-only — and the
*mechanism* incompletely.

## Decision

Three layers, in this order, instead of one launcher:

| # | Layer | When | Gives |
|---|---|---|---|
| 1 | **Landlock (+ seccomp)** | default on Linux when the ABI can carry the profile — **≥ 3 for a write boundary**, ≥ 1 for read-only (see *What the ABI actually costs*) | filesystem containment. No privilege, no namespace, no profile — works on a stock Ubuntu 24.04 |
| 2 | **bubblewrap** | fallback: Landlock ABI 0, or FS-only ABI where network-off is required | today's behaviour, unchanged. Needs unprivileged userns (see remediation below) |
| 3 | **Container profile** | opt-in, never default | strongest isolation, reproducible toolchain, and the **only** layer on which a domain allowlist is implementable (network namespace + proxy) |

**Capability reporting becomes a probe, not a lookup.** `sandbox status`,
`install.sh` and the launcher-detection path must each run one trivial contained
command and report *its* outcome. "The mechanism is present" is not a finding
about containment, and this ADR is not implemented until no code claims
otherwise.

**Fail-closed is unchanged** (ADR-0006): no layer silently degrades into an
unsandboxed run. A host where layer 1 and layer 2 both fail reports `blocked`,
as it does today.

## Consequences

Per-command cost. The first three figures were taken while writing this ADR, in
separate short runs; the spike (below) then measured every mechanism in **one**
run at N=30, which is the more trustworthy method. Where they disagree, the
spike's column is the one to quote.

| Mechanism | This ADR, separate runs | Spike, one run, N=30 |
|---|---|---|
| none | ~1.8 ms | 2.1 ms |
| bubblewrap (`--ro-bind / / --dev /dev --unshare-net`) | ~17 ms | **10.9 ms** |
| Landlock via `bun:ffi`, the §4.2 shape | not yet measured | **40.2 ms** |
| Landlock via a compiled C helper | not yet measured | **2.3 ms** |
| `docker run --rm --network none alpine:3` | ~409 ms | not re-run |

- **Positive:** containment works on a stock Ubuntu 24.04 with no `sudo`, no
  AppArmor profile and no weakened sysctl. That is the single biggest gap
  between what keryx promises a new Linux user and what they get.
- **Positive:** the false-green disappears, because the matrix reports a probe.
- **Negative — older kernels lose network-off.** Ubuntu 22.04 ships kernel 5.15
  → Landlock ABI 1 → filesystem only. There the choice is bubblewrap (needs the
  userns remediation) or filesystem-only containment, and the matrix must say
  which, per kernel, rather than per platform.
- **Negative — Landlock cannot express a domain allowlist either.** It gates TCP
  by port, not by name. `--allowed-domains` and `--mask-env` stay unimplemented
  on Linux until the container layer lands; this ADR does not change that, it
  only stops layer 1 and 2 from pretending otherwise.
- **Negative — the container layer carries a privilege irony.** Membership in
  the `docker` group is equivalent to root on the host, so an isolation feature
  would depend on a capability stronger than the one being isolated. That is one
  reason it is opt-in and not the default; a rootless runtime (podman) is the
  obvious way out and is deferred with it.
- ~230× (bare → container) is not a rounding error for a tool that gates every
  shell command. It is the reason the container is a profile and not the base.

## Delivery shape

Settled after measurement, 2026-08-08. This ADR left open *how* Landlock rules
get applied. The flow-143 spike answered
it with a running proof (29 assertions, every denial paired with a control that
differs only in the ruleset, and asserting the denial's cause rather than its
symptom): `bun:ffi` reaches the syscalls, the restriction survives `execve`, and
it is inherited by a grandchild and a great-grandchild — with no privilege, no
namespace and no AppArmor profile.

**Decision: ship the `bun:ffi` shape. The compiled helper is deferred, not
rejected.**

The cost is real and is recorded above: ~40 ms per contained command, roughly 4×
bubblewrap, where a compiled helper would cost ~2.3 ms. Only ~1 ms of that is
Landlock; the rest is a second Bun cold start plus transpile. It is structural,
not sloppiness — rules may never be applied in the keryx process itself (that
would restrict keryx), so a second process is mandatory, and its floor is Bun's
startup. Prebundling recovers ~2 ms of it.

It is accepted anyway, for three reasons in this order:

1. **Nothing perceives it.** Both entry paths are dominated by something orders
   of magnitude slower — `shell_exec` waits on a human approving each command,
   and `harness exec` waits on a model round-trip before each one. 40 ms is
   noise inside noise.
2. **The helper's real cost is correctness, not build complexity.** Per-arch
   binaries, a C toolchain in CI and the end of a platform-neutral npm package
   are the visible price (and precisely what ADR-0005 exists to limit). The
   expensive part is a **second implementation of the ruleset logic** to keep in
   sync with the pure `landlock.ts`. Two implementations of one security
   boundary, drifting apart over time, is a worse risk than latency — and this
   whole ADR exists because a boundary misreported itself.
3. **It is reversible.** The helper drops in behind the same interface later;
   the spike already wrote and measured the C.

**Revisit trigger, stated as a number so it is not re-argued from taste.**
Measure the containment overhead as a *fraction of a real `harness exec` run*,
not in isolation. Above **5%** of run wall-clock, take the compiled helper.

**Not settled by the spike:** only ABI 4 on kernel 6.8 was exercised. The ABI 1
path (Ubuntu 22.04 / kernel 5.15) — the size-8 `ruleset_attr` and the ABI-1
filesystem mask — is inferred from headers and has never run. The TCP axis was
proven reachable and enforcing, and remains TCP-only: §4.3 of the package
specification stands.

## Grant list, not deny list

Settled 2026-08-08, after flow 145 built the translator and found that the
layer as first specified would serve **no real profile at all**.

Two facts, both verified in the code rather than reasoned about:

1. **`SandboxProfile.readDenyList` is never empty in practice.** Both
   `sandboxProfileFromPolicy` and `defaultSandboxProfile` populate it from
   `defaultReadDenyList(home)` — SSH and GPG keys, cloud credentials, registry
   tokens, and keryx's own `auth.json` and `permissions.json`. Only
   `danger-full-access`, which is by definition uncontained, has an empty one.
2. **Landlock cannot deny.** A nested rule can add rights to a subtree; it can
   never remove them. So a "read everything except these fifteen paths" profile
   is not expressible, and the first specification's Landlock layer would have
   refused every profile the product actually builds.

**Decision: for the Landlock layer, invert the model.** Do not translate the
deny list. Grant read to what a contained command needs — the workspace, the
session temp dir, the system roots — and do not grant `$HOME` at all. The secret
paths are then unreachable because they were never granted, not because they
were denied.

This is not a workaround; it is the posture Landlock is built for. The deny list
exists because bubblewrap starts from `--ro-bind / /`, where everything is
readable and holes must be punched. Landlock starts from nothing.

**It is also strictly stronger.** The deny list enumerates fifteen known secret
paths. Withholding `$HOME` covers those *and* every credential file nobody
thought to list. The cost is the mirror image: tools that read benign config
from `$HOME` — git config, caches — must be granted explicitly, and until they
are, they fail. That failure is a visible "cannot read this file", not a silent
hole in a boundary, and this ADR prefers it in that direction.

Which benign paths need granting is an empirical question, to be **measured**
rather than guessed, in the flow that builds the launcher.

### What the ABI actually costs

Also from flow 145, and it corrects this ADR's own layer table: a sound **write**
boundary needs **ABI 3**, not ABI 1. Handling write access without also handling
`truncate` (ABI 3) leaves truncation unrestricted everywhere, and `refer` is ABI
2. Review twice rejected the tempting fix — dropping `truncate` from the handled
set — because that is exactly the best-effort masking this package refuses.

So the honest per-kernel picture:

| Kernel | Landlock | Result |
|---|---|---|
| ≥ 6.2 (Ubuntu 24.04, kernel 6.8 here) | ABI 3–4 | full filesystem containment, **zero setup** |
| 5.13–6.1 (Ubuntu 22.04, kernel 5.15) | ABI 1–2 | read-only containment only; a write profile falls back to bubblewrap |

The fallback is clean rather than another wall: the AppArmor userns restriction
that makes bubblewrap fail is an Ubuntu 23.10+ default, and those older
distributions do not have it. Where Landlock cannot serve, bubblewrap works with
an `apt install` and no security policy to author.

## Alternatives considered

- **Keep bubblewrap and document the AppArmor profile.** This is what was done
  on this host, and it works: a profile naming `/usr/bin/bwrap` with `userns,`
  (the same shape Ubuntu ships for Chrome, Brave and ~40 others), after which
  `harness exec` returns `exitCode 0`. Rejected **as the default**, because it
  asks every user to author a system security policy before the advertised
  default posture functions. Kept as the documented remediation for layer 2.
- **`sysctl kernel.apparmor_restrict_unprivileged_userns=0`.** Rejected
  outright: it disables the restriction for every process on the machine to fix
  one program. `docs/verification/linux-sandbox-verification.md` recommended
  exactly this and is corrected by this ADR.
- **Container as the default** (the "just run everything in Docker" option).
  Rejected on the measurement above plus the daemon dependency and host/image
  toolchain drift — but adopted as layer 3, because it is the only path to the
  deferred allowlist.
- **`@anthropic-ai/sandbox-runtime`.** Unchanged from ADR-0006: still a viable
  fallback, still an npm dependency under ADR-0005.

## Deferred

- Domain allowlist + credential masking via layer 3 (container + proxy) — the
  v1.x item ADR-0006 already deferred, now with a mechanism that can carry it.
- Rootless container runtime (podman) so layer 3 stops requiring `docker`-group
  membership.
- seccomp filter beyond what the layer-1 implementation needs.
- TLS inspection; native Windows (use WSL2).
