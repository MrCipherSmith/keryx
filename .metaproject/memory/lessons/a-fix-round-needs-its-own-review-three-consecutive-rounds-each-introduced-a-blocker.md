# A fix round needs its own review: three consecutive rounds each introduced a blocker

Version: 0.1.0
Type: lesson
Status: draft
Confidence: high

## Summary

On PR #215 (flow 127, project registry) three consecutive review-fix rounds each
introduced a new blocker while closing the previous one. The defect was not in
any single fix; it was in treating a fix as finished once it addressed the
reported symptom.

## Details

What happened, in order:

1. **Round 1** shipped a concurrency test that wrapped a *synchronous* call in
   `Promise.resolve` and asserted `length > 0`. Nothing ran concurrently and the
   assertion was a tautology, so it passed while the implementation
   reproducibly lost registrations (8 subprocesses → 4, 3, 2 entries).
2. **Round 2**, fixing that, patched a control-character regex with a script
   that doubled the backslashes. The class became literal characters: it
   stripped digits and capitals (`Project-42_ABC` → `roject-_`) and stripped no
   control character at all — so the finding it existed for stayed open and a
   new corruption shipped beside it. The same round left the stale-lock branch
   without a deadline check, hanging `keryx init` forever at full CPU.
3. **Round 3**, fixing *that*, added a quarantine to `forgetProject` that
   renamed the live registry aside and then returned `not-found` without
   writing. One mistyped id destroyed every valid registration. A data-loss fix
   that caused data loss.

Three failure modes, one root cause each time:

- **The fix was not tested, only written.** The regex had zero tests; the
  quarantine's supposed test never reached its branch; the concurrency test
  could not fail.
- **The fix was applied where the finding pointed, not everywhere the class
  lived.** `registerProject` got the warn-and-quarantine treatment and
  `forgetProject` did not. The display sanitizer was applied at one call site
  while the error path printed the same untrusted value raw.
- **A comment asserted a control that did not exist.** The module header named
  an `assertNoSecrets` that was never written, and the real check was
  exact-name, case-sensitive, top-level and called nowhere outside tests.

## How to apply

- Write the failing test **before** the fix, and confirm it fails for the stated
  reason. A test added after a green fix has never been observed to fail.
- Mutation-check every guard: remove it, confirm the suite goes red, restore.
  This caught the decorative coverage guard in flow 087 and would have caught
  all three rounds here.
- When a finding names one call site, grep the class. Ask "where else does this
  shape occur" before declaring the fix complete.
- Fix at the source, not the call site, when the value is untrusted — sanitizing
  per-caller leaves the next caller open.
- Never let a comment describe enforcement that no code performs. If the
  comment says "X enforces this", `X` must exist and be called on the path that
  matters.
- Treat a fix round as new code deserving a full review, not as a correction
  exempt from one. The empirical prior on "this fix is correct" was low enough
  that the third review was instructed to assume the fixes were wrong until
  executed — and it was right to.

## Provenance

- Source: review rounds on PR #215 (flow 127)
- Link: https://github.com/MrCipherSmith/keryx/pull/215
- Created: 2026-07-31
- Updated: 2026-07-31

## Related Scopes

- Module: core
- Entity: project-registry
- Files: src/lib/project-registry.ts, src/commands/projects.ts
- Skills: review-logic, review-security-code, flow-orchestrator

## Tags

review, testing, mutation-testing, data-loss, process

## Changelog

- 0.1.0 - Initial version.
