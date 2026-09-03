# Implementation Plan

Status: ready

## Approach

Three independent fixes in one flow because they share a file and a test suite,
not because they share a cause. Each lands with its own test, and each test is
mutation-checked before the flow closes — that is the one process change round 3
demanded, and it is the whole reason these are worth doing rather than leaving
recorded.

## Steps

1. Lift `readAllBounded` out of `src/commands/orient.ts` into a module both
   entry points can use, and apply it in `src/ctx/hook.ts`. Expiry is the
   fail-open no-payload case the hook already handles. Keep the reader
   cancellation: PR #431 established that racing a timer alone leaves the process
   alive.
2. Route `ANTIGRAVITY_RUNTIME.validate` through `managedGroupsFor`, and make the
   flat-vs-nested ownership shape a per-runtime fact on `CtxRuntime` rather than
   an either/or accepted for everyone.
3. Make the escape-marker test quote-aware, reusing whatever `splitPipeline`
   already does rather than writing a second quote scanner.
4. One test per fix, each verified by reverting the fix and watching it go red.
   Record the mutation result in the flow journal, not only in the commit body.

## Risks

- **Step 1 changes a gate's failure mode.** A deadline that is too short turns a
  slow-but-legitimate harness write into a silent no-payload allow. `orient` uses
  250 ms and it opens after `buildOrientation` (~760 ms of pipe buffering); the
  hook has no such preamble, so the number needs its own justification rather
  than being copied.
- Step 2 touches every runtime's validate path. The regression question is
  whether any settings shape a previous build wrote becomes invisible to
  uninstall — PR #431's round-3 regression pass established that removal keys on
  the `_keryxManaged` sentinel and not on shape, which is what makes this safe,
  and that property has to be re-checked rather than assumed.
- Step 3 is the smallest and the least valuable; it is included because it sits
  in the same function and would otherwise be a third visit to this file.
