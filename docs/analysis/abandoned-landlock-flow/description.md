# Linux containment Step 3 — Landlock launcher

Status: draft (flow-init skill formalizes this)
Source: `docs/requirements/keryx-linux-containment` specification.md §4, §4.4, §8, §9; implementation-plan.md Step 3.

## Problem

Flow 145 (PR #260) delivered the **pure** half of the Landlock layer:
`buildLandlockRuleset(profile, abi)` in `landlock.ts` and the injectable ABI
reader in `landlock-abi.ts`. Its AC7 records explicitly that it did **not**
touch `wrap.ts`, `detect.ts`, or any launcher — those were left for this flow.

So today the Landlock layer cannot run. `wrap.ts` still dispatches Linux to
bubblewrap only; `detect.ts` still returns a boolean `available` keyed on
`bwrap` presence. The ruleset translator exists, but nothing applies it to a
process, nothing selects it as a layer, and no run receipt records when it ran.
The boundary the specification describes is, on Linux, still entirely bubblewrap
— including the profiles Landlock is meant to serve (read-only / workspace-write
on a host where bubblewrap is blocked by AppArmor but Landlock is reachable).

## Expected Outcome

The Landlock layer is **live and selected**:

- `sandbox/landlock-exec.ts` — the child entry point. It consumes a serialized
  `LandlockRuleset`, applies it to **itself** via `bun:ffi`
  (`landlock_create_ruleset` → `add_rule` per granted path →
  `prctl(PR_SET_NO_NEW_PRIVS)` → `landlock_restrict_self`), then `execve`s the
  real command. The FFI mechanism lives in the child only; the pure modules
  `landlock.ts` and `landlock-abi.ts` keep their no-mechanism source guards green.
- `wrap.ts` — the Linux branch gains a Landlock arm. It stays pure: it returns a
  command of the shape `<bun> <bundled-landlock-exec> --ruleset <json> -- <cmd>`,
  mirroring the bwrap branch. It does not spawn.
- `detect.ts` — `available: boolean` is replaced by a resolved **layer choice**
  (landlock | bwrap | blocked) plus the probe outcome, per spec §2/§8.
- Run receipt — `sandbox.launcher` records `"landlock"` where that layer ran.
- Benign `$HOME` grant set — **measured** against real commands (git config,
  tool caches), each entry a reviewed widening of the boundary; never guessed,
  never widened to make a test pass (spec §4.4).
- `landlock-exec` is **prebundled** to one JS artifact so no transpile happens
  at runtime (the spike measured ~13 ms of transpile per run).

Layer selection is per **profile**, not per host: a `network: "off"` profile
selects bubblewrap even on a Landlock host (Landlock cannot serve network-off
without a seccomp filter — spec §4.3); a `read-only` profile on the same host
selects Landlock.

## Out of Scope

- **Live verification on a clean Ubuntu host (spec AC10/AC11).** That is Step 5.
  This host had an AppArmor profile for `bwrap` installed on 2026-08-08 and no
  longer qualifies for the AC11 false-path; a clean host is required. This flow
  ships the code and the unit-level proof; the live run is recorded later.
- **seccomp filter for non-TCP sockets.** Needed before Landlock can serve
  `network: "off"`; deliberately its own later flow (implementation-plan.md,
  Deferred).
- **Container layer (ADR-0010 layer 3).** Deferred whole.
- **keryx-os-sandbox doc-package matrix update.** That is Step 4, after this
  layer lands.
