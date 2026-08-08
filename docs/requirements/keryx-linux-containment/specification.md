# Keryx Linux Containment — Specification
Version: 1.0.0

Implements [ADR-0010](../../decisions/keryx-harness/ADR-0010-linux-containment-without-privilege.md).
Read [prd.md](prd.md) first for the problem and the measurements.

## 1. Module identity

| | |
|---|---|
| Owner | `src/harness/process/sandbox/` |
| Layer | OS enforcement, beneath the policy engine (ADR-0003) and the approval gate |
| Public surface | `src/harness/process/sandbox/index.ts` |
| New runtime dependency | **none** (ADR-0005). Landlock is a kernel interface, reached through `bun:ffi`. |
| Platforms touched | Linux only. macOS (`seatbelt.ts`) is not modified. |

## 2. Inventory — what exists, what changes, what is new

Stated because the question "what do we already have, what must go, what must be
built" is the first thing an implementer asks, and because two of these files do
**not exist on `main`** (see README, *Dependency*).

### Exists and is correct — do not touch

| File | Why it stays |
|---|---|
| `sandbox/profile.ts` | `SandboxProfile` is the right shared input for a third launcher. No change. |
| `sandbox/seatbelt.ts` | macOS. Out of scope. |
| `sandbox/bwrap.ts` | A correct bubblewrap wrapper. It is demoted from default to fallback; the code is unchanged. |
| `sandbox/proxy*.ts`, `network-run.ts`, `tls-ca.ts`, `mask-resolve.ts` | The restricted-network machinery. Landlock does not reach it — allowlist stays macOS-only. |
| `sandbox/adapter.ts` | Fail-closed decoration. Behaviour preserved (N1). |

### Changes

| File | Change | Why |
|---|---|---|
| `sandbox/detect.ts` | `SandboxLauncherInfo.available: boolean` cannot express "present but non-functional". Replace with a resolved **layer choice** plus a probe outcome. Keep the injectable `existsSync`/`env`/`platform` seam. | The boolean is the root of the false green: `bwrap` on `PATH` set it to `true`. |
| `sandbox/wrap.ts` | Add the Landlock branch to the platform dispatcher. Stays pure — it returns a wrapped command, it does not spawn. | R1–R3. |
| `sandbox/capability-matrix.ts` ¹ | Add the third state and the kernel axis (§5). | R5, R6. |
| `src/commands/sandbox.ts` ¹ | `sandbox status` renders the probe result and names the selected layer. | R4. |
| `scripts/install.sh` ¹ | Same correction at install time; drop the `command -v bwrap` inference. | R7. |
| `capability-matrix.doc-sync.test.ts` ¹ | Extend to the third state so the runbook cannot drift from it. | R5. |
| `keryx-os-sandbox` package README + specification | Its platform matrix becomes wrong the moment this lands. Update in the same flow. | Iron law: no stale claims. |

¹ **not present on `main`** — arrives with `fix/benchmark-remediation-v2`.

### New

| File | Purpose |
|---|---|
| `sandbox/landlock.ts` | Pure: `SandboxProfile` → Landlock ruleset description. No syscalls, no spawn — mirrors `bwrap.ts`. |
| `sandbox/landlock-abi.ts` | Impure, injectable: query the kernel's Landlock ABI version once, cache it. |
| `sandbox/landlock-exec.ts` | The child entry point: applies the ruleset to itself, then runs the real command. §4. |
| `sandbox/probe.ts` | Impure, injectable: run one trivial contained command per layer and report what happened. §6. |
| Tests beside each | Pure modules offline-testable; probe and ABI behind injected fakes. |

### Deleted

Nothing in `src/`. Two documentation claims were already removed on this branch:
the machine-wide `sysctl` remediation in the verification runbook, and the same
advice in the operator guide's troubleshooting table. No further deletions are
part of this package — the honest answer to "what must go" is that the defect is
a *claim*, not a file.

## 3. The three layers

| Layer | Selected when | Gives | Does not give |
|---|---|---|---|
| **1. Landlock** | Linux, ABI ≥ 1, and the profile's demands are expressible | filesystem containment; TCP network restriction at ABI ≥ 4 | anything requiring a re-rooted mount view; non-TCP network (§4.3) |
| **2. bubblewrap** | Landlock cannot satisfy the profile, and `bwrap` is present **and probes clean** | today's behaviour, unchanged | `network: "restricted"` (already fails closed) |
| **3. container** | never automatically | *deferred whole* — recorded in ADR-0010, not specified here | — |

Selection is per **profile**, not per host: a `network: "off"` profile on a
kernel with Landlock ABI 1 must select bubblewrap, because layer 1 cannot
deliver network-off there. A `read-only` profile on the same host selects
Landlock.

If no layer satisfies the profile, the result is `blocked` with the reason — the
existing fail-closed path (N1), not a new one.

## 4. Landlock mechanics

### 4.1 Model

Landlock is a restriction the process applies **to itself**. The sequence is:
create a ruleset naming the access types to handle, add allow-rules for path
hierarchies, set `PR_SET_NO_NEW_PRIVS`, then `landlock_restrict_self`. Anything
not allowed by a rule, within a handled access type, is denied. It needs no
privilege, no namespace and no LSM profile, and it **cannot be undone**.

That last property is the design constraint: rules must never be applied in the
keryx process. They are applied in a short-lived child, immediately before the
real command runs.

### 4.2 Where the rules are applied

`wrap.ts` stays pure by producing a command of the shape

```
<bun> <keryx>/sandbox/landlock-exec.ts --ruleset <fd-or-json> -- <real command>
```

mirroring how the bwrap branch produces `bwrap <args> -- <real command>`. The
child applies the ruleset to itself and then runs the command; descendants
inherit the restriction, which is what makes this safe for a shell command that
spawns further processes.

Bun is already a hard runtime requirement, so this adds **no** new dependency and
**no** per-architecture binary to distribute — deliberately unlike Codex, which
ships a compiled `codex-linux-sandbox` helper.

> **Spike required before the implementing flow is planned.** Issuing
> `landlock_create_ruleset` / `landlock_add_rule` / `landlock_restrict_self` and
> `prctl` from `bun:ffi`, and confirming the restriction survives into the
> exec'd child, is the one unproven assumption in this specification. If it does
> not hold, the fallback is a compiled helper and the distribution cost that
> comes with it. Nothing else in this package depends on the answer.

### 4.3 Where Landlock is weaker than bubblewrap

Stated, not hidden:

- **Network-off is not equivalent.** Landlock ABI 4 restricts TCP `bind` and
  `connect`. `bwrap --unshare-net` removes the network namespace entirely.
  UDP — including DNS — raw sockets and unix-domain sockets are outside
  Landlock's network access types. A Landlock "network off" that ignores this
  would be a second false green, and this specification forbids it: `network:
  "off"` may be served by layer 1 **only** in combination with a seccomp filter
  denying the remaining socket families, and until that filter exists,
  `network: "off"` selects bubblewrap.
- **No mount view.** `bwrap --ro-bind / /` presents a different filesystem;
  Landlock filters access to the real one. Profiles whose meaning depends on a
  path *not existing* rather than *not being readable* cannot be expressed.
  Translation failure is fail-closed, never approximate.
- **Irrevocable and process-wide.** See §4.1.

## 5. Capability matrix — the third state

Today (`capability-matrix.ts`, and only on the unmerged branch):

```ts
type CapabilityStatus = "supported" | "not-implemented";
```

Two states cannot say what this package exists because of. Required:

```ts
type CapabilityStatus =
  | "supported"        // implemented, and the probe confirmed it here
  | "not-implemented"  // no code path exists on this platform, ever
  | "unavailable";     // implemented, but not functional on THIS host
```

`unavailable` carries a `reason` and, where one exists, a `remediation`. The
matrix's existing comment is correct and stays true — it records the *static*
fact of whether a capability is implemented. The third state is not static, so
it is supplied by the probe (§6) and composed at report time, not stored in the
table. `sandbox status` must never present a static row as a host fact.

Linux rows are keyed on Landlock ABI, not on the string `"linux"` (R6).

## 6. The probe

```ts
export interface ProbeResult {
  layer: "landlock" | "bwrap" | "seatbelt" | "none";
  ok: boolean;
  /** Verbatim launcher stderr when ok === false — this is the evidence. */
  detail?: string;
  remediation?: string;
}
```

Contract:

- Runs **one** trivial contained command (`/bin/true`-class) under the layer
  being reported.
- Impure, and therefore injectable, exactly as `detect.ts` injects `existsSync`.
- **At most one probe per process, cached** (N4). Never invoked on a path that is
  not reporting capability — a normal contained run does not pre-probe, it runs
  and reports its own outcome.
- On failure it reports the launcher's own words. `bwrap: setting up uid map:
  Permission denied` is a better diagnostic than any sentence keryx could
  compose, and it is what the AppArmor remediation is keyed on.

## 7. CLI surface

No new command. `keryx sandbox status` changes what it prints:

- the selected layer, named;
- per capability: state, and for `unavailable` the reason and remediation;
- the kernel's Landlock ABI on Linux;
- unchanged: it is a report, exits 0, and gates nothing.

`scripts/install.sh` prints the same, from the same source.

## 8. Data contracts

| Contract | Change |
|---|---|
| `SandboxProfile` | unchanged |
| `SandboxLauncherInfo` | `available: boolean` → layer choice + `ProbeResult` |
| `WrapResult` | unchanged shape; the Linux branch may now produce a Landlock command |
| Run result / receipt | `sandbox.launcher` already records `"bwrap"`; it must now record `"landlock"` where that layer ran |
| `CapabilityStatus` | third state (§5) |

No JSON schema file is added: none of these cross a process boundary. The run
receipt's `sandbox` field is already published by the harness contracts and only
gains a value, not a shape.

## 9. Integration points

| Point | Effect |
|---|---|
| `resolveSandboxAdapter` (`detect.ts`) | Layer selection happens here; callers are unchanged. |
| `SandboxedProcessAdapter` | Unchanged. Fail-closed semantics preserved (N1). |
| `keryx harness exec` | Contained by default; gains Landlock without a flag change. |
| `shell_exec` tool | Opt-in via `KERYX_SANDBOX_SHELL`; unchanged, but the opt-in now works on stock Ubuntu. |
| `keryx sandbox status`, `install.sh` | §7. |
| `keryx-os-sandbox` package | Platform matrix updated in the same flow. |
| Verification runbook | Gains a Landlock section and the measured overhead (S6). |

## 10. Acceptance criteria

| # | Criterion | Test |
|---|---|---|
| AC1 | `landlock.ts` converts a `SandboxProfile` into a ruleset description deterministically, offline, with no syscall. | unit |
| AC2 | A profile that cannot be expressed in Landlock terms yields an explicit failure, never a partial ruleset. | unit |
| AC3 | Layer selection: Landlock chosen for an expressible profile; bubblewrap chosen when `network: "off"` is required and Landlock cannot serve it; `blocked` when neither can. | unit, ABI injected |
| AC4 | The probe reports failure with the launcher's verbatim stderr, and success without it. | unit, fake spawn |
| AC5 | Probe runs at most once per process. | unit |
| AC6 | `sandbox status` prints no capability as available unless a probe confirmed it on this host, and a Linux `unavailable` row names the **kernel/ABI** as the reason rather than the platform string (R6). | unit over the render function, ABI injected |
| AC7 | The doc-sync test covers the third state, so the runbook and the matrix cannot disagree. | existing test, extended |
| AC8 | Fail-closed is unchanged: no layer, no probe result and no ABI value causes an unsandboxed spawn. Existing escape hatches behave exactly as before. | existing fail-closed tests, unchanged and still green |
| AC9 | macOS path untouched — `seatbelt.ts` and its tests unmodified. | diff review + existing tests |
| AC10 | **Live**: on a stock Ubuntu 24.04 with no `sudo`, no `bubblewrap` and no AppArmor profile, a contained command runs, a write outside the workspace is refused, and `sandbox status` says `landlock`. | manual, recorded in the verification runbook |
| AC11 | **Live**: with Landlock forced off, the same host reports `unavailable` with the bwrap diagnostic and the AppArmor remediation, and a contained run is `blocked`. | manual, recorded |
