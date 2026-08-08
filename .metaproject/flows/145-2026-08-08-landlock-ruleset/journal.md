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

1. **`LANDLOCK_RESIDUAL_ACTIONS` has no consumer.** (Round 3 replaced the two
   earlier lists, `LANDLOCK_UNRESTRICTABLE_ACTIONS` and
   `LANDLOCK_UNHANDLED_ACTIONS`, with this one; the obligation is unchanged.) It
   exists so `sandbox status` and `capability-matrix.ts` can state the
   layer-1/layer-2 boundary asymmetry from a value, per entry, including which
   entries bubblewrap actually refuses. Until one of them renders it, the
   asymmetry is still only in a comment — the defect is relocated, not closed.
   Both files are out of this lane; step 4 must wire it.
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

## 2026-08-08 — rounds 3-8, and where the defects actually lived

Eight review rounds. **Not one found a defect in the translation.** Every finding
after round 1 was in a *claim* or a *guard* — and rounds 1 through 6 each found
that the previous round's fix had carried a new one. Round 7 was the first that
introduced nothing; round 8 confirmed it and returned `STATUS: DONE`, no blocker,
no major, four nits.

The recurring shapes, recorded because they are the transferable part:

- **A claim one step past the measurement.** "Closes the first-order version of
  all three gaps" (closed one). "Verbatim from CAVEATS" (it was a subset).
  "The mutating entries" (two entries cross no write boundary). Each was written
  in good faith and each was read by the next round instead of being re-derived.
- **A guard that enumerates names where it means shapes.** The purity guard was
  written four times: twice over text, twice over the AST. Text lost to
  single quotes, then to `process["platform"]`, a destructured shadow, an
  interpolation and a regex literal. The AST version lost to a concatenated
  specifier (which produces *no* entry, so an allowlist is satisfied rather
  than violated), `import.meta.require`, `Function` beside an unnamed `eval`,
  and `Math.random` matched by shape inside an identifier-matching guard.
- **A fix applied where the finding pointed, not across the class.** `ioctl`
  moved wholesale between two lists, losing the half that fits neither. The
  guard covered `landlock.ts` and not `landlock-abi.ts`, so a `defaultReader`
  calling `globalThis.Bun.spawnSync` on a compiled helper — verbatim what AC5
  forbids — passed every check. Both are now closed by enumeration: the residue
  is one structured list with per-entry facts, and the guard reads the directory
  and fails if a `landlock*.{ts,mts,cts}` module is not on its list.
- **The one finding that was not about a guard, and mattered most.**
  `WRITE_ACCESS_RIGHTS` and `DEVICE_WRITE_PATHS` decide what the ruleset
  restricts and what it grants back, and nothing pinned their contents. Dropping
  `remove_file`, `remove_dir`, `make_reg` or `make_sym` left the suite fully
  green while `unlink`, `rmdir`, `creat` and `symlink` went unrestricted
  anywhere on the filesystem — a right absent from `handled_access_fs` is not
  narrowed, it is unbounded — and the ruleset still reported itself complete.
  Adding `/dev/sda` to the carve-out was green too. Both are pinned as literals
  now, in the same shape as the UAPI tables.

Every fix in rounds 3-8 was verified by mutation before and after, in an
isolated worktree. The final matrices: 21 evasions red / 14 pure shapes green
for the purity guard, plus the content pins, the nesting guarantees and the
cross-module closure.

## 2026-08-08 — the step-2 spike landed, and one thing it found reaches this lane

Flow 143 / PR #258 settled §4.2: `bun:ffi` carries Landlock, the restriction
survives `execve` and is inherited by descendants, and the measured ABI on this
host is 4. The compiled-helper fallback is not needed. `landlock-abi.ts` did not
have to change — the property it was written for — so only its comments moved.

The finding that did reach this module: a too-narrow grant must be fixed with a
**nested** rule, never a wider ancestor. The spike hit it on `/dev`, where
widening the directory to make `/dev/shm` writable also bought the ability to
unlink device nodes. Rights accumulate downwards, so a builder that merged,
sorted or dropped nested paths would leave the applier no way to express the
correct shape. Nothing here did merge them — but nothing said so and nothing
tested it, which is the same thing one refactor later. `pathRules` now documents
it and four tests pin it; folding a nested root, widening `/dev`, and sorting by
path are all red.

The asymmetry is the whole model in one line: **nesting can add rights to a
subtree and can never remove them.** That is why the writable roots work and why
`readDenyList` remains inexpressible.

### Gate

- `bunx tsc --noEmit`: clean.
- `bun test src/harness/process/sandbox`: 243 pass / 5 skip / 0 fail after round 8
  (baseline on this branch: 147 pass / 5 skip / 0 fail).
- `bun run test:guards`: 257 pass / 0 fail.
- `bun test` (whole repo): 3330 pass / 14 skip / 2 fail — both failures are
  `scripts/install-global.test.ts` ("AC1: … bubblewrap … PATH"), pre-existing on
  this host, owned by the parallel probe flow and untouched by this branch.
- `bun test src/capability`: 27 pass / 0 fail.
- `bun scripts/check-doc-links.ts`: 698 links, 0 broken.
- `keryx health run`: score 93, trend stable, one pre-existing WARN
  ("required source unavailable: typescript") unrelated to this change.
- 2026-08-08T20:08:16.075Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-08T20:08:16.167Z - task-done: T10: quality gate and review orchestrator until green
- 2026-08-08T20:08:50.821Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/260
- 2026-08-08T20:08:58.460Z - ac-confirmed: AC1: buildLandlockRuleset(profile, abi) is pure: ABI injected, no syscall/FFI/spawn/fs/process.platform. Held structurally by an AST source guard over both modules (import allowlist + forbidden-global identifier scan), mutation-verified: 21 evasions red incl. concatenated specifier + live readFile, import.meta.require, Function(), Math["random"], declare const process, class extends globalThis.Object; 14 pure shapes green.
- 2026-08-08T20:08:59.941Z - ac-confirmed: AC2: An inexpressible profile returns {ok:false, failures} and never a ruleset. Ten machine-readable codes; unit tests cover network off, network restricted, non-empty readDenyList, danger-full-access, non-absolute/NUL/non-canonical paths, ABI 0, malformed ABI and ABI below the floor. Failures accumulate in a fixed order; a failed translation has no ruleset property.
- 2026-08-08T20:09:05.781Z - ac-confirmed: AC3: Every rule's allow is a non-empty subset of handledFs; minimumAbi is the max first-ABI over handled rights (pinned at 3); LandlockRuleset has exactly five fields, held by a runtime key assertion over seven shapes x four ABIs AND a compile-time Record<keyof LandlockRuleset,true> guard. Mutation-verified: adding or removing a field fails tsc. What the mechanism cannot reach is a constant (LANDLOCK_RESIDUAL_ACTIONS), not a per-translation field.
- 2026-08-08T20:09:07.184Z - ac-confirmed: AC4: handledNet and netRules are typed readonly never[] and always frozen empties; a network rule is a tsc error, not a convention. Asserted over every profile shape at ABI 3-6, and for network on/off/restricted with the specific refusal code required in the failure branch.
- 2026-08-08T20:09:12.674Z - ac-confirmed: AC5: landlock-abi.ts exposes an injected LandlockAbiReader, a per-call cache and LandlockAbiReaderError, and nothing else; it imports nothing (empty specifier allowlist, exact). Cache proven to call the reader exactly once including for cached throws and cached rejections. The no-mechanism property is now held by the shared source guard: a defaultReader using globalThis.Bun.spawnSync on a compiled helper is red.
- 2026-08-08T20:09:15.126Z - ac-confirmed: AC6: tsc --noEmit clean; bun test src/harness/process/sandbox 243 pass/5 skip/0 fail (branch baseline 147/5/0); bun run test:guards 257 pass/0 fail; bun scripts/check-doc-links.ts 698 links 0 broken; keryx health run score 93 trend stable with one pre-existing WARN. Whole-repo bun test 3330/14/2, both failures pre-existing in scripts/install-global.test.ts and owned by the parallel probe flow.
- 2026-08-08T20:09:22.726Z - ac-confirmed: AC7: git diff --stat over the whole range touches in src/ only landlock.ts, landlock.test.ts, landlock-abi.ts, landlock-abi.test.ts and the appended export block of sandbox/index.ts. Outside src/: one line in package.json (test:guards) and the flow package. detect.ts, capability-matrix.ts, src/commands/sandbox.ts, scripts/install.sh, wrap.ts, seatbelt.ts, profile.ts, bwrap.ts, adapter.ts and proxy/TLS are untouched.
