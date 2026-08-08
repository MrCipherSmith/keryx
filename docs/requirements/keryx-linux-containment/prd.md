# Keryx Linux Containment — PRD
Version: 1.0.0

## 1. Problem

keryx contains a spawned command with a kernel-enforced boundary (ADR-0006). On
Linux that boundary is `bubblewrap`, and `bubblewrap` builds it out of
**unprivileged user namespaces**.

Ubuntu withdrew unprivileged user namespaces by default in 23.10, and 24.04 —
the current LTS, and therefore the most likely machine a new user is on — ships
`kernel.apparmor_restrict_unprivileged_userns=1`. On such a host:

- `bubblewrap` installs from the stock repository without complaint;
- launcher detection finds it and reports the launcher available;
- and every contained run dies with `bwrap: setting up uid map: Permission denied`.

The second problem is worse than the first. keryx does not merely fail to
contain — **it reports that it contains.** A user who reads

```
Filesystem containment and network-off are available.
```

has been told they have a boundary they do not have. `keryx sandbox status`
exists (flow 142 / P4) precisely to stop keryx claiming untested capability, and
it is making exactly that claim.

## 2. What was measured

All figures are from one host — Ubuntu 24.04, kernel 6.8.0-136-generic — taken
while unblocking benchmark case C4 on 2026-08-08. They are recorded in
[ADR-0010](../../decisions/keryx-harness/ADR-0010-linux-containment-without-privilege.md).

| Fact | Measurement |
|---|---|
| bubblewrap on a stock 24.04 | installs (0.9.0); every contained run exits 1 with `setting up uid map: Permission denied` |
| Cause | `kernel.apparmor_restrict_unprivileged_userns = 1` |
| Landlock on the same host | ABI **4** — filesystem *and* TCP bind/connect restrictions, no privilege required |
| After an AppArmor profile scoped to `/usr/bin/bwrap` | `harness exec` returns `exitCode 0`; containment works |
| Cost per contained command, no containment | ~1.8 ms |
| Cost per contained command, bubblewrap | ~17 ms |
| Cost per contained command, `docker run --rm --network none` | ~409 ms |

Field evidence, read off the two agent CLIs installed on the same host rather
than off their documentation:

| CLI | `landlock` strings | `bwrap`/`bubblewrap` | `seccomp` |
|---|---|---|---|
| Codex 0.146.0 | **31** | 20 | 16 |
| Claude Code | **0** | 22 / 18 | 56 |

keryx's mechanism choice is identical to Claude Code's, so Claude Code meets the
same wall. Codex does not, because it never depended on user namespaces.

## 3. Goal

1. A user who installs keryx on a current Ubuntu gets **working containment with
   no `sudo`, no package to install and no security policy to author.**
2. Every statement keryx makes about its own containment is the result of a
   probe, on this host, at this moment.
3. Where a capability genuinely is unavailable, the reason names the kernel, not
   the operating system — because on Linux it is the kernel that decides.

## 4. Users

| User | What changes for them |
|---|---|
| **A new Linux user** | Containment works out of the box instead of silently not working. This is the whole point. |
| **An operator on Ubuntu 22.04** (kernel 5.15) | Landlock gives filesystem containment but not network-off. They are told exactly that, and told bubblewrap plus an AppArmor profile is the way to get the rest. Today they are told everything works. |
| **An agent** deciding whether to run something contained | `sandbox status` and the run result become trustworthy inputs. An agent that reads "available" today may be reasoning from a false premise. |
| **A macOS user** | Nothing changes. |

## 5. Requirements

### Functional

| # | Requirement |
|---|---|
| R1 | A Landlock launcher enforces filesystem containment for a spawned command, using the same `SandboxProfile` the other launchers consume. |
| R2 | Landlock's TCP restriction (ABI ≥ 4) is implemented, but **`network: "off"` is not served by Landlock alone** — its access types do not cover UDP, raw or unix sockets, so that profile keeps selecting bubblewrap until a seccomp filter closes the gap. See [specification §4.3](specification.md#43-where-landlock-is-weaker-than-bubblewrap). |
| R3 | Layer selection at run time: Landlock when usable; otherwise bubblewrap; otherwise fail closed. The selected layer is named in the run result. |
| R4 | Capability reporting is a **probe**: one trivial contained command is run and its outcome reported. No capability is reported as available on the strength of a binary existing. |
| R5 | The capability matrix carries a third state for "implemented, but not functional on this host", with the reason. |
| R6 | Linux capability reporting is keyed on kernel/ABI, not on the string `"linux"`. |
| R7 | `scripts/install.sh` reports the probe result, not a `PATH` lookup. |
| R8 | Where a probe fails and a remediation exists (the AppArmor profile for bubblewrap), the output names it — and never names the machine-wide sysctl. |

### Non-functional

| # | Requirement |
|---|---|
| N1 | **Fail-closed is preserved.** No layer may degrade into an unsandboxed run. Existing escape hatches (`KERYX_DANGEROUSLY_DISABLE_SANDBOX`, `KERYX_SANDBOX_ALLOW_UNSANDBOXED`) keep their current semantics and nothing new bypasses containment. |
| N2 | **No new npm dependency** (ADR-0005). Landlock is reached through the kernel, not through a package. |
| N3 | The pure modules stay pure. `wrap.ts`, `profile.ts`, `bwrap.ts` and the matrix must remain spawn-free and offline-testable; the probe is impure and lives behind an injectable seam, as `detect.ts` already does for the filesystem. |
| N4 | Probing must not make startup feel slow: at most one probe per process, cached, and never on a path that does not report capability. |
| N5 | No regression in the macOS path. |

## 6. Success criteria

| # | Criterion | How it is proven |
|---|---|---|
| S1 | On a stock Ubuntu 24.04 with no `sudo` and no `bubblewrap`, a contained command runs and is contained. | Live check on such a host; a write outside the workspace is refused. |
| S2 | On the same host, `keryx sandbox status` reports containment as working, and says which layer. | Command output. |
| S3 | On a host where **no** layer works, `sandbox status` says so, and a contained run is `blocked` rather than unsandboxed. | Forced-unavailable test plus the existing fail-closed tests. |
| S4 | On kernel 5.15 with no working bubblewrap, filesystem containment reports available (Landlock ABI 1) and network-off reports unavailable **with the kernel as the reason**, not the operating system. | Probe on a 5.15 host, or an ABI-injected test with the bubblewrap layer forced absent. |
| S5 | No output anywhere claims a capability that a probe did not confirm. | Grep the reporting paths; the doc-sync test extended to the third state. |
| S6 | The measured overhead of the Landlock layer is recorded, as bubblewrap's ~17 ms was. | Benchmark in the verification runbook. |

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Landlock's filesystem model is a *restriction* of the calling process, not a re-rooted view like bwrap's `--ro-bind`. The two boundaries are not expressible in exactly the same terms. | **high** — it is the core implementation risk | Keep `SandboxProfile` as the shared input, and treat translation into Landlock rules as this package's real work. Where a profile cannot be expressed, fail closed rather than approximate. |
| Landlock cannot be undone but also cannot be *narrowed per exec* the way a wrapper program can — rules apply to the calling process and its children. | medium | The launcher applies rules in a forked child immediately before `exec`, never in the keryx process. Any design that would restrict keryx itself is rejected. |
| Landlock's network restriction is TCP-only, so a naive "network off" through it would be a second false green. | **high** | R2: `network: "off"` selects bubblewrap until a seccomp filter covers the remaining socket families. Stated in the spec as non-negotiable in review, not left to the implementer. |
| The probe adds a spawn to a previously spawn-free path. | low | N3/N4: injectable seam, one cached probe per process. |
| Users on 22.04 read "filesystem only" as "broken". | low | R8: the message names the remediation. |
| This package cannot land before the unmerged remediation-v2 work. | medium | Stated in the README and in the plan's step 0; the first flow rebases or waits. |

## 8. Recommendation

Adopt the three layers of ADR-0010, and **implement them in the order the risk
demands, not the order the architecture suggests**.

The probe (R4–R7) is a smaller change than the Landlock launcher, it is
independent of it, and it is the part that removes an active false statement
from a shipped product. It should land first and alone. A user who is told
"containment is not working, here is why" is strictly better off than one told
"available", even before a single line of Landlock exists.

Landlock (R1–R3) follows, and turns that honest negative into a positive on the
majority of current Linux hosts.

The container layer stays deferred. It is the only path to a Linux domain
allowlist, and that is a reason to keep its interface in mind, not a reason to
build it now: it costs ~409 ms per command and depends on a daemon whose group
membership is equivalent to root on the host being protected.
