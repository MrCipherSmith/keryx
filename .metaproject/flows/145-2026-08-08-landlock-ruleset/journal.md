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

### Gate

- `bunx tsc --noEmit`: clean.
- `bun test src/harness/process/sandbox`: 193 pass / 5 skip / 0 fail
  (baseline on this branch: 147 pass / 5 skip / 0 fail).
- `bun test src/capability`: 27 pass / 0 fail.
- `bun scripts/check-doc-links.ts`: 698 links, 0 broken.
- `keryx health run`: score 93, trend stable, one pre-existing WARN
  ("required source unavailable: typescript") unrelated to this change.
