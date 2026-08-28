# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `sandbox/landlock-exec.ts` exists and is the child entry point. It reads a serialized `LandlockRuleset` (the output of `buildLandlockRuleset`), applies it to itself via `bun:ffi` in the documented order (`landlock_create_ruleset` → `landlock_add_rule` per granted path → `prctl(PR_SET_NO_NEW_PRIVS)` → `landlock_restrict_self`), then runs the real command. If the ruleset cannot be applied, the command never runs and the child exits 125 (fail-closed, spec N1).
- AC2: The FFI mechanism lives in `landlock-exec.ts` or a module only the child imports. The pure modules `landlock.ts` and `landlock-abi.ts` keep their no-mechanism source guards green (no new import, no forbidden global, no `Bun.spawnSync`/`ffi`/`Dlopen` reference added); the flow-145 mutation tests for those guards still pass.
- AC3: The child resolves the program through `PATH` explicitly before `execve` (raw `execve` performs no `PATH` search) and never falls back to running a bare name as a workspace file. The FFI ABI reader declares a **signed** return type, so a kernel error `-1` does not arrive as `4294967295`. Verified by code review and a unit test over the PATH-resolution helper.
- AC4: Layer selection: an expressible profile on Linux with sufficient ABI selects Landlock; `network: "off"` selects bubblewrap on every host (Landlock cannot serve it without seccomp — spec §4.3); a profile neither layer can serve is `blocked` (fail-closed). Selection is per-profile, ABI-injected in tests. `detect.ts` exposes a layer choice, not a boolean.
- AC5: `wrap.ts` gains a pure Landlock arm: given a landlock-selected profile and serialized ruleset, it returns a command of the shape `<bun> <bundled-landlock-exec> --ruleset <json> -- <cmd>` and performs no spawn and no fs read. The bwrap and seatbelt arms and the `danger-full-access` pass-through are unchanged.
- AC6: Grant list (spec §4.4): the landlock layer grants read to the workspace, the session temp directory, and the system roots; it does **not** grant `$HOME`. The benign `$HOME` grant set is measured against real commands and recorded in this flow package; every grant entry is a reviewed widening, and none was added to make a test pass.
- AC7: Run receipt: `sandbox.launcher` records `"landlock"` where the landlock layer ran (spec §8). Verified by a unit test over the receipt/receipt-builder.
- AC8: Fail-closed is unchanged (spec AC8): no missing layer, probe result, or ABI value produces an unsandboxed spawn. The existing fail-closed and escape-hatch tests (`adapter.restricted-fail-closed.test.ts`, etc.) are unmodified and still green.
- AC9: macOS is untouched (spec AC9): `seatbelt.ts` and its tests are unmodified. Confirmed by `git diff` over the range.
- AC10: Prebundle: `landlock-exec` is built to a single JS artifact by the project's bundling script, and `wrap.ts` invokes that artifact (not the `.ts` source). The artifact exists in the build output and is covered by a smoke check.
- AC11: Quality gate green: `tsc --noEmit` clean; `bun test src/harness/process/sandbox` green against the flow-145 baseline (243 pass / 5 skip / 0 fail) or better; `bun run test:guards` 0 fail; `scripts/check-doc-links.ts` 0 broken; `keryx health run` stable with no new WARN introduced by this flow.
