# Plan

Implements step 3 of `docs/requirements/keryx-linux-containment/implementation-plan.md`.
Delivers PRD R1–R3 and specification AC1, AC2, AC3, AC8, AC9. AC10/AC11 (live,
on an unremediated host) belong to step 5 and are explicitly not claimed here.

## Approach

Four units, built in this order, each with its tests written first.

### 1. `landlock.ts` — invert the translation (specification §4.4)

The merged translator handles write rights only and refuses every profile that
carries a `readDenyList`. Both change:

- **Handle read rights too.** Reads are unrestricted today because no read-ish
  right is in `handledFs`. Under the grant model, read rights are handled and
  granted per hierarchy.
- **Grant, do not deny.** Rules: `rw` on `writableRoots` and the session temp
  directory; `ro` on the system roots a command needs to *start*
  (`/usr /bin /sbin /lib /lib64 /etc /proc /sys` plus the Bun install directory);
  the existing narrow device carve-out on `/dev`, with `/dev/shm` as a **nested
  `rw` rule** rather than a widened `/dev`. `$HOME` is granted by nothing.
- **`readDenyList` is checked, not translated.** Every entry must be unreachable
  under the grant set. An entry that lies beneath a granted root fails the
  translation (AC2) instead of being quietly left readable — that is the one case
  the "it is under `$HOME`, so it was never granted" argument does not cover.
- **Missing paths:** `fail` for writable roots (their absence means the workspace
  is not there), `skip` for system roots (`/lib64` does not exist on aarch64, and
  skipping can only over-restrict).

`minimumAbi` rises to 3 and stays there: `truncate` is ABI 3. Dropping it to
reach Ubuntu 22.04 was rejected twice in flow 145's review and is rejected here —
without `truncate`, truncation is unrestricted everywhere.

### 2. `landlock-exec.ts` — the child that restricts itself

Ported from `spike/landlock-ffi.ts` with the spike's own corrections applied, not
copied as-is. Shape: `<bun> <…>/landlock-exec.js --ruleset <json> -- <argv…>`.

- syscall arity 7; `path_beneath_attr` 12 bytes packed; `ruleset_attr` 8 bytes
  below ABI 4 and 16 from ABI 4; rule paths `O_PATH | O_CLOEXEC`; every rule
  masked with the handled set; `PR_SET_NO_NEW_PRIVS` before `restrict_self`.
- **`execve` via FFI**, so the Bun process is replaced rather than left resident.
- **PATH resolution refuses, never falls back.** Raw `execve` resolves a
  slash-free name against the *current directory*, which for a contained command
  is attacker-influenced workspace. A PATH miss is an error, and a candidate must
  be a **regular** file with `X_OK` — `access(X_OK)` is satisfied by a directory.
- **Apply failure exits 125 with the command never started.** Never degrade,
  never approximate: an axis the kernel cannot serve is a refusal.
- Signal fidelity: with `execve` the kernel owns the exit status, so the launcher
  must be shown *not* to interpose. Where a status is synthesised, `128+N` comes
  from `node:os` `constants.signals`, never a hand-written table.
- The ruleset travels as argv JSON. It is paths, not secrets, and argv is the
  only channel a pure `wrap.ts` can produce.

### 3. `wrap.ts` — the layer choice, still pure

Linux branch becomes: translate the profile; on `ok` produce the Landlock
command; on failure route by `LandlockInexpressibleCode` — the fallback-able
codes (`network-off-requires-seccomp`, `abi-too-low`, `landlock-unavailable`,
`abi-unreadable`) go to bubblewrap when `bwrap` is available, and everything else
fails closed with the translator's own `detail` as the reason.

`wrap.ts` stays spawn-free and fs-free: the ABI value, the Bun path and the
bundled child's path are **injected** through `WrapOptions`. The existing purity
guard is extended to cover the new imports.

### 4. `detect.ts` — a resolved layer, without moving the callers

`SandboxLauncherInfo` gains `layer: SandboxLayer` and the Landlock ABI; the
`available` boolean stays as a derived field. Specification §9 says callers are
unchanged, and six call sites (`harness.ts`, `shell-exec-tool.ts`,
`serve-runner.ts`, `sandbox.ts`, the stress script, `adapter.ts`) would otherwise
move for no boundary gain. Layer selection is per **profile**, not per host: the
same host serves a `read-only` profile with Landlock and a `network: "off"`
profile with bubblewrap.

## Decisions this flow must make explicitly, not by default

Recorded here so review can see them, and tracked as tasks so they cannot be
skipped (T14, T15):

1. **The benign `$HOME` grant set must be measured, not guessed.** Withholding
   `$HOME` breaks git config and tool caches. Each entry added back is a
   reviewed widening of the boundary, justified by a real command that fails
   without it — the specification demands measurement here and the spike warns
   against copying its own grants blindly.
2. **A kernel newer than the access table.** The ABI clamp is asymmetric: a newer
   kernel leaves its new access classes unhandled and therefore unrestricted.
   Proposed position — surface it (as `LANDLOCK_RESIDUAL_ACTIONS` surfaces the
   constant residuals) rather than refuse to run, since refusing would break
   every future kernel. Review owns the final call.
3. **Environment forwarding.** The launcher forwards the parent environment
   verbatim; ADR-0010 records `--mask-env` as unimplemented on Linux, so API keys
   are in that environment today. Proposed position — parity with the existing
   bwrap path plus an explicit statement in the guide, no new masking mechanism
   in this flow. Review owns the final call.

## Trade-offs accepted

| Trade | Why |
|---|---|
| ~40 ms per contained command (≈4× bwrap) | Structural: rules may never be applied in the keryx process, so a second Bun cold start is unavoidable. ADR-0010 records the revisit trigger (>5% of a real `harness exec` run) and the compiled helper as the known optimisation. |
| A read boundary where there was none | The grant model is strictly stronger than the fifteen-path deny list — it also covers the credential file nobody listed. The cost is that a benign `$HOME` read fails visibly until granted, which the specification prefers to a silently unenforced boundary. |
| `network: "off"` still selects bubblewrap | Landlock's network rights are TCP-only; UDP, raw and unix sockets are outside them. Serving network-off with Landlock would be a second false green. |

## Verification

Unit and offline for the translator and the dispatcher (ABI injected, no
kernel). **Live on this host** for the applier: kernel 6.8, Landlock ABI 4,
`landlock` present in `/sys/kernel/security/lsm`. Every enforcement assertion
carries a negative control — the spike published three greens that proved
nothing, and this flow inherits the lesson, not just the code.
