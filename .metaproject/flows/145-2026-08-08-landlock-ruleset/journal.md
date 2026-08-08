# Journal

## 2026-08-08 — translation built, and what it refuses

`buildLandlockRuleset(profile, abi)` lands as a pure translation with a
two-branch result: a ruleset that covers the whole profile, or the list of
reasons it cannot be covered. No third shape.

### Findings worth carrying into step 3

1. **The write boundary needs Landlock ABI 3, not ABI 1.** Specification §3 and
   ADR-0010 both key layer 1 on "ABI ≥ 1". A faithful write boundary needs
   `LANDLOCK_ACCESS_FS_TRUNCATE`, which first exists at ABI 3 (kernel 6.2), and
   `LANDLOCK_ACCESS_FS_REFER` at ABI 2. Below that a contained command can empty
   a file outside the writable roots. Masking the request down to the kernel's
   ABI is the usual workaround and is precisely the approximation AC2 forbids,
   so ABI 1 and 2 are an explicit `abi-too-low` failure instead. Ubuntu 24.04
   (ABI 4) is unaffected; Ubuntu 22.04 (ABI 1) now falls to bubblewrap for the
   filesystem boundary too, not only for network-off. **The layer table in
   specification §3 and the ADR-0010 consequences list should be corrected in
   step 4.**

2. **`readDenyList` is the binding constraint, ahead of network-off.** The
   spec's headline weakness is network-off, but every policy-derived profile
   with a known `home` also carries a non-empty `readDenyList`
   (`defaultReadDenyList`), and a deny-exception under a broad read default has
   no Landlock representation at all: rules are allow-only and cumulative along
   the path, and `landlock_add_rule` rejects an empty `allowed_access`
   (`ENOMSG`), so no deeper rule can narrow a shallower one. Expressing it would
   mean enumerating every sibling on the path to each secret — `readdir`, which
   is impure, racy, and silently denies entries created later. Left unbuilt and
   out of this lane; recorded as the future path.

   Consequence for step 3's layer selection: with today's `SandboxProfile`
   shape, the profiles Landlock can serve are `read-only`/`workspace-write` with
   `network: "on"` **and** an empty read-deny list. That is narrower than the
   package assumed and should be measured before the seccomp flow is scoped.

3. **No profile emits a network rule**, and a test asserts it at every ABI
   including 6. `handledNet`/`netRules` exist on the type only so the
   seccomp-paired future has somewhere to land.

### Deliberately not done

- `landlock-exec.ts` and the `wrap.ts` branch — gated on the step-2 `bun:ffi`
  spike (specification §4.2). `landlock-abi.ts` therefore holds an injected
  reader and a cache and no mechanism at all, so a compiled-helper outcome
  changes an implementation and not this interface.
- `detect.ts` layer selection, `capability-matrix.ts`, `src/commands/sandbox.ts`,
  `scripts/install.sh` — other agents' lanes in this package.

## 2026-08-08 — review round 1 (PR #260), and what it changed

Six reviewers in four parallel dispatches (logic, security-code, architecture +
core-boundaries, testing-practices + clean-code). 1 blocker, 8 major, 17
minor/info. Two structural claims the design rests on were independently
confirmed correct: Landlock allow-rules are cumulative along the path, and all 18
UAPI constants match the kernel (checked against `man 7 landlock` on this host).

**The blocker was real and I had missed it.** Landlock has no access right for
`chmod`, `chown`, `setxattr`, `utime`, `ioctl`, `fcntl` or `flock` at any ABI —
`landlock(7)` CAVEATS — so a `read-only` ruleset that returned `ok: true` still
permitted `chmod -R 000 ~` outside the writable roots, which bubblewrap refuses
with `EROFS`. The type said such a value "enforces the whole profile".

Fixed as a claim correction, not a refusal: refusing would make every
write-bounded profile inexpressible and delete the Landlock layer. The residue is
now `LANDLOCK_UNRESTRICTABLE_ACTIONS`, an exported frozen constant, so the
reporting layer reads it from a value instead of from a comment. The distinction
that keeps AC2 intact: a *constant fact about the mechanism* is not a
*per-translation escape hatch*, and the second is still forbidden and now
enforced at compile time.

Four guards were proved green against deliberately broken code by the reviewers
and are now real: AC1 purity (an import allowlist; `node:fs` + a
`process.platform` branch used to pass), AC3's no-partial-boundary field (an
optional `notEnforced` populated only on `read-only` used to pass — now fails
both `tsc` and the runtime key assertion, re-verified by repeating the mutation),
AC4's network cases (two of three were vacuous), and the first-ABI table (`refer:
1`, `ioctl_dev: 99` used to pass).

Also fixed: an `abi-too-low` message that told an Ubuntu 22.04 operator the
kernel leaves cross-directory rename unrestricted when the kernel denies it
outright; the missing stdio device carve-out both sibling launchers carry; the
speculative network surface (deleted — `handledNet`/`netRules` are now
`readonly never[]`, so a network rule is a type error); unfrozen shared arrays;
`abi-unreadable` split from `landlock-unavailable`; `..`-segment paths;
`onMissing` on `LandlockPathRule`; and a 108-line function split into one
accumulator per concern.

Two findings recorded and **not** fixed, both out of lane and both documentation:
PRD S4 / §4 / specification §3 / ADR-0010's layer table promise ABI-1 filesystem
containment that the truncate floor makes unreachable, and PRD R2 claims the TCP
restriction "is implemented". Both reviewers warned explicitly that the tempting
fix — dropping `truncate` below ABI 3 — is the best-effort masking this design
rejects. Step 4 owns those documents.

## 2026-08-08 — review round 2, which found that round 1 had introduced its own

Two dispatches (logic + security-code; testing-practices + clean-code +
architecture), both told to review the whole merge-base range rather than the fix
commit, and both told to assume this fix round had introduced a blocker — the
recorded lesson says three consecutive ones did. It had.

**The round-1 fix reproduced the round-1 blocker one ABI up.**
`LANDLOCK_UNRESTRICTABLE_ACTIONS` was documented as actions Landlock cannot
restrict "at any ABI" and contained `ioctl` — while the module's own table says
`ioctl_dev` exists from ABI 5 and its own header says not handling it is a keryx
deferral. On a 6.10 kernel the constant reported a decision as a kernel
limitation, in the value written so `sandbox status` would stop doing exactly
that. Split into `LANDLOCK_UNRESTRICTABLE_ACTIONS` (six, never restrictable) and
`LANDLOCK_UNHANDLED_ACTIONS` (`ioctl`, restrictable from ABI 5, with the reason).

**Two of the new guards were themselves hollow**, both proved by mutation:

- The AC1 purity allowlist matched only `from "…"` with double quotes, so
  `import { readFileSync } from 'fs'` doing a real `/proc/version` read passed,
  as did a bare side-effect import, a dynamic import, and `Bun.file` with no
  import at all. Now matches every specifier form in both quote styles and names
  the impure globals, with string literals blanked so operator prose cannot trip
  it. Re-verified: eight evasions red, a prose-only change green.
- The `LANDLOCK_UNRESTRICTABLE_ACTIONS` assertion was a tautology (none of its
  entries is a `LandlockFsAccess` value, so `not.toContain` could never fail),
  and four of seven entries were unpinned. Now a full literal, like the two UAPI
  tables.

Also fixed: `//` was normalised to the empty string and then reported as "writable
root ''" — a diagnostic naming a value nobody supplied, because dedupe had moved
ahead of validation; `/work//repo` produced two rules for one hierarchy;
`JSON.stringify(NaN)` printed `null` in the one message whose purpose is to be
true about the reader; the `abi-too-low` text named `truncate` twice at ABI 2 and
had a latent subject-less sentence; AC4's guard was still per-fixture while
AC3's had been widened; the ruleset and its `pathRules` were not frozen; and
`abiFailures` was still doing three jobs.

### Obligations this flow cannot discharge, recorded so they survive it

1. **`LANDLOCK_UNRESTRICTABLE_ACTIONS` and `LANDLOCK_UNHANDLED_ACTIONS` have no
   consumer.** They exist so `sandbox status` and `capability-matrix.ts` can state
   the layer-1/layer-2 boundary asymmetry from a value. Until one of them renders
   it, the asymmetry is still only in a comment — the defect is relocated, not
   closed. Both files are out of this lane; step 4 must wire it.
2. **The Landlock ABI reader must declare a signed return type.**
   `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` returns
   `-1` on failure; declared `u32` in `bun:ffi` that becomes `4294967295`, which
   no validator downstream can distinguish from a very new kernel, and no
   defensible ceiling exists. `cacheLandlockAbi` rejects negatives and
   non-integers — the half a seam can check. The spike's reader needs its own
   test asserting the declaration is signed.
3. **Specification §4.3 "Stated, not hidden" lists three ways Landlock is weaker
   than bubblewrap.** The metadata-mutation residue is the fourth and is absent.
   Documentation, owned by step 4.

### Gate

- `bunx tsc --noEmit`: clean.
- `bun test src/harness/process/sandbox`: 233 pass / 5 skip / 0 fail after round 2
  (baseline on this branch: 147 pass / 5 skip / 0 fail).
- `bun test src/capability`: 27 pass / 0 fail.
- `bun scripts/check-doc-links.ts`: 698 links, 0 broken.
- `keryx health run`: score 93, trend stable, one pre-existing WARN
  ("required source unavailable: typescript") unrelated to this change.
