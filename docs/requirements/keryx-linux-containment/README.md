# Keryx Linux Containment — Requirements Package
Version: 1.0.0

## Status

`specification ready (future)` — **nothing in this package is implemented.**

The problem it addresses is not future: on a stock Ubuntu 23.10 or newer,
keryx's Linux containment does not work, and keryx reports that it does. That is
measured, not predicted — see [prd.md §2](prd.md#2-what-was-measured).

**Dependency, stated up front.** This package modifies `keryx sandbox status`,
`src/harness/process/sandbox/capability-matrix.ts` and `scripts/install.sh`.
None of those exist on `main` — they arrived with the shell-remediation-v2 work
(flow 142 / P4) on `fix/benchmark-remediation-v2`, which is **not merged**. This
branch is cut from `main`, so the first implementation flow either waits for
that merge or rebases onto it. Nothing here can land before it.

## Purpose

Make kernel-enforced containment work on Linux **without asking the user for a
privilege**, and make keryx's report of its own containment a measurement rather
than an inference.

Two separate failures, one package, because the second is what makes the first
dangerous:

1. **The boundary does not hold.** `bubblewrap` builds its boundary from
   unprivileged user namespaces. Ubuntu withdrew those by default in 23.10
   (`kernel.apparmor_restrict_unprivileged_userns=1`), so every contained run
   fails with `bwrap: setting up uid map: Permission denied`.
2. **keryx says it holds anyway.** Launcher detection is a `PATH` lookup
   (`detect.ts`), the capability matrix is a static table, and `sandbox status`
   composes the two into "available" — a claim neither of them checked.

The fix for (1) is a mechanism that needs no privilege: **Landlock**. The fix
for (2) is to probe rather than infer, and it is worth landing even alone.

## Document index

| Document | Read it when |
|---|---|
| [prd.md](prd.md) | You want the problem, what was measured, the users affected, and why Landlock over the alternatives. |
| [specification.md](specification.md) | You are implementing: the three layers, the probe contract, the inventory of what exists / changes / is added, module boundaries and acceptance criteria. |
| [implementation-plan.md](implementation-plan.md) | You are sequencing the work into flows and want the order, the dependencies and what each flow must prove. |
| [spike/README.md](spike/README.md) | You are implementing Step 3 (the Landlock launcher). The Step 2 spike result: `bun:ffi` **does** carry Landlock, with 21 executable assertions, the measured per-command overhead, and the syscall/struct details that fail silently if you get them wrong. |

Related, outside this package:

- [ADR-0010](../../decisions/keryx-harness/ADR-0010-linux-containment-without-privilege.md)
  — the decision this package implements, with the measurements behind it.
- [ADR-0006](../../decisions/keryx-harness/ADR-0006-os-sandbox-shell-exec.md)
  — the OS sandbox itself; its Linux launcher choice is superseded by ADR-0010.
- [Keryx OS Sandbox package](../keryx-os-sandbox/README.md) — the containment
  layer this one changes the Linux half of. Its platform matrix becomes wrong
  when this lands and must be updated in the same flow.
- [Linux verification runbook](../../verification/linux-sandbox-verification.md)
  — manual validation on a real host; already corrected to stop recommending a
  machine-wide sysctl.

## Scope

**In scope**

- A **Landlock** launcher for Linux: filesystem containment, plus the TCP
  restriction the kernel's Landlock ABI offers. Note that this is **not** the
  same as network-off, and the package says so rather than rounding up — see
  [specification §4.3](specification.md#43-where-landlock-is-weaker-than-bubblewrap).
- **Layer selection** at run time: Landlock, else bubblewrap, else fail closed —
  with the chosen layer named in the result.
- **Capability reporting by probe.** `sandbox status`, launcher resolution and
  `install.sh` must report what a trial containment actually did, not what a
  binary's presence implies.
- A third capability state — *implemented but non-functional on this host* —
  which the current two-state matrix (`supported` / `not-implemented`) cannot
  express, and which is exactly the state this whole package exists because of.
- Reporting keyed on **kernel version**, not on platform name, because Landlock's
  capabilities differ across kernels on the same distribution.

**Out of scope**

- The container layer (layer 3 of ADR-0010) beyond recording its interface.
  It is the only path to a Linux domain allowlist, and it is deferred whole.
- Domain allowlist and credential masking on Linux. Landlock gates TCP by port,
  not by name; this package does not move them from `not-implemented`.
- macOS. Seatbelt is unaffected — no file under `sandbox/seatbelt.ts` changes.
- The policy engine, the approval gate, the structural command guard. This is
  the enforcement layer beneath them, per ADR-0003 and ADR-0006.
- Windows.

## Related modules

| Module | Relationship |
|---|---|
| `src/harness/process/sandbox/detect.ts` | Launcher detection today; gains a probe and a layer choice. |
| `src/harness/process/sandbox/wrap.ts` | Platform dispatcher; gains the Landlock branch. |
| `src/harness/process/sandbox/bwrap.ts` | Unchanged as a wrapper; demoted from default to fallback. |
| `src/harness/process/sandbox/capability-matrix.ts` | Static two-state matrix; gains the third state and a kernel axis. **Not on `main` yet.** |
| `src/commands/sandbox.ts` | `keryx sandbox status`; becomes a probe report. **Not on `main` yet.** |
| `scripts/install.sh` | Prints the same claim at install time; same correction. **Not on `main` yet.** |
