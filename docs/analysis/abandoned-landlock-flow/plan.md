# Implementation Plan

Status: draft (flow-init skill fills this after context and brainstorm)

## Approach

**Deliver the launcher as a self-restricting child, with the FFI confined to the
child module, and layer selection as a pure choice.** The approach is fixed by
the specification, not open — the spike (flow 143) already resolved the one
design question (can `bun:ffi` apply Landlock → yes) and left three corrections
this flow carries:

1. **`execve` via FFI, not `Bun.spawnSync`.** Otherwise a Bun process stays
   resident as the parent of every contained command. Raw `execve` does no `PATH`
   search, so the child resolves the program through `PATH` explicitly — a
   bare-name fallback would run a file from the workspace.
2. **The FFI ABI reader declares a signed return type.** `-1` arrives as
   `4294967295` unsigned and reads as a new kernel.
3. **Prebundle the child to one `.js`.** The spike measured ~13 ms transpile per
   run; the bundled artifact is what `wrap.ts` invokes.

The pure/impure split is load-bearing and enforced: `landlock.ts` and
`landlock-abi.ts` must keep their no-mechanism source guards green (flow 145
AC1/AC5). The FFI syscalls therefore live in `landlock-exec.ts` (or a sibling
module **only** the child imports) — never in the translator or the ABI reader.
`buildLandlockRuleset` produces a serializable description; the child
deserializes it and applies it. The grant list (§4.4) is realized by what the
description grants — workspace, session temp, system roots — and the conspicuous
absence of `$HOME`.

`wrap.ts` stays pure: it builds the `<bun> <bundled-child> --ruleset <json> --
<cmd>` command string. It does not read the ABI or spawn; layer selection is
`detect.ts`'s job, and the choice is fed in.

`detect.ts` gains a layer resolver: given a profile, a probe outcome, and an
injected ABI, it returns `landlock` | `bwrap` | `blocked`. The existing
injectable `existsSync`/`env`/`platform` seam is preserved and extended with an
injected ABI reader so selection is offline-testable.

## Steps

1. **FFI in the child.** Port the spike's `landlock-ffi.ts` mechanism into
   `src/harness/process/sandbox/` as a child-only module (or inline in
   `landlock-exec.ts`): `landlock_create_ruleset`, `landlock_add_rule`,
   `landlock_restrict_self`, `prctl(PR_SET_NO_NEW_PRIVS)`, `execve`. Signed
   return types throughout. Confirm the pure-module source guards still pass.
2. **`landlock-exec.ts`.** Consume a serialized `LandlockRuleset`, apply it to
   self, then `execve` the command with explicit `PATH` resolution. Fail-closed
   exit 125 if the ruleset cannot be applied (command never runs). Map
   `signalCode` → 128+N (the spike's `signalNumber` via `node:os`). Verbose
   stderr under `--verbose`; abi-clamp warning always.
3. **`wrap.ts` Landlock arm.** Pure: given a profile that selected landlock +
   the serialized ruleset, return the wrapped command. Mirror the bwrap branch's
   shape. network-off / restricted never take this arm.
4. **`detect.ts` layer choice.** `available: boolean` → `{ layer, probe }`.
   Selection rules per spec §3. Preserve the seam; add injected ABI.
5. **Run receipt.** Where the launcher is recorded, emit `"landlock"` when the
   landlock layer ran. Unit-test the receipt builder.
6. **Prebundle.** Build `landlock-exec` to a single JS artifact via the existing
   bundling script; `wrap.ts` points at the artifact, not the `.ts`.
7. **Benign `$HOME` grant measurement.** Build a small harness that runs real
   commands (git status, etc.) under the landlock layer and records which
   `$HOME` paths had to be granted. Record the measured set; each entry is a
   reviewed widening. If this host cannot run Landlock cleanly, ship the harness
   and defer the numbers to Step 5.
8. **Quality gate + review.** tsc, sandbox suite, test:guards, check-doc-links,
   health; then the review orchestrator.

## Risks

- **ABI 1 never run.** The spike exercised ABI 4 only; the ABI 1 path (kernel
  5.15 / Ubuntu 22.04) is inferred from headers. Spec calls this out and Step 3
  inherits it as risk. Mitigation: the translator already fails closed below the
  write floor (ABI 3); the child must not assume an ABI the translator rejected.
- **Grant set under-grants and breaks real commands.** §4.4 consequence 2. The
  failure mode is visible (a tool reports it cannot read a file), which is the
  preferred direction — but the measured set must be real, not optimistic.
- **Live ACs unprovable here.** AC10/AC11 need a clean Ubuntu host (Step 5).
  This flow must not claim live containment; it claims the code and unit proof.
- **Pure-guard regression.** Adding FFI risks dragging a mechanism reference
  into a pure module. The source guards from flow 145 are the tripwire; they
  must stay green, mutation-verified.
