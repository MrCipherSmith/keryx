# A fix round needs its own review: three consecutive rounds each introduced a blocker

Version: 0.2.0
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

## It recurred on the next flow, and one remedy did work

Flow 128 (PR #216, `keryx serve`) ran three review rounds after the same lesson
had been written and read. Rounds 1 and 2 each shipped a defect inside the fix
they were named for, and both were the *same* failure mode as above — the fix
applied where the finding pointed rather than everywhere the class lived:

- Round 1 was told the shared config directory was left group-writable. It
  tightened **one writer of five**, so on any install that never ran
  `keryx serve token issue` the directory stayed 0775 and `auth.json` — plaintext
  provider API keys — stayed replaceable by any member of the operator's group.
- Round 2 was told an error message instructed the operator to run a command
  that would destroy their configuration. It corrected **one message of four**
  — and the correction (making `config init` refuse to clobber) silently broke
  the other three, none of which anyone looked for. Its second attempt then
  added `--force` to make an instruction work again, which made it succeed *by*
  resetting bind, port and profile: the exact damage the round was raised over.
- Round 3 also found a comment claiming enforcement no code performs, in code
  written one round after this file named that failure.

What broke the pattern was not more care. It was changing the SHAPE of the
guard, from per-site to per-class:

- `config-dir.permissions.test.ts` drives **every** writer of the shared
  directory under `umask 002` against an already-widened directory. Tightening
  four writers of five leaves it red.
- `serve.recovery.test.ts` enumerates **every** refusal state the CLI can reach
  with a configuration on disk, and executes the instruction each one prints.
  Fixing three messages of four leaves it red.

Neither could pass while a sibling was broken, which is the property a
per-site test does not have. Round 3's fixes were mutation-checked before being
claimed and introduced no new defect.

## How to apply

- Write the failing test **before** the fix, and confirm it fails for the stated
  reason. A test added after a green fix has never been observed to fail.
- Mutation-check every guard: remove it, confirm the suite goes red, restore.
  This caught the decorative coverage guard in flow 087 and would have caught
  all three rounds here.
- When a finding names one call site, grep the class. Ask "where else does this
  shape occur" before declaring the fix complete. Then go further and make the
  TEST the class: one guard that enumerates every member and fails while any one
  of them is wrong. "I checked the others" is a claim; a guard over the whole set
  is a measurement, and it is the only thing that stopped this recurring.
- Ask what the fix itself breaks. A guard that refuses an operation makes every
  instruction that recommends that operation wrong, and those instructions live
  somewhere else. Grep for what NAMES the thing you just changed, not only for
  what resembles it.
- Never make a broken instruction work by adding a destructive flag to it. If
  following the instruction now costs the operator their configuration, the
  instruction is still wrong.
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

- Source: review rounds on PR #215 (flow 127) and PR #216 (flow 128)
- Link: https://github.com/MrCipherSmith/keryx/pull/215
- Link: https://github.com/MrCipherSmith/keryx/pull/216
- Created: 2026-07-31
- Updated: 2026-08-01

## Related Scopes

- Module: core
- Entity: project-registry
- Files: src/lib/project-registry.ts, src/commands/projects.ts, src/lib/config-dir.ts, src/commands/serve.ts
- Guards: src/lib/config-dir.permissions.test.ts, src/commands/serve.recovery.test.ts
- Skills: review-logic, review-security-code, flow-orchestrator

## Tags

review, testing, mutation-testing, data-loss, process

## Changelog

- 0.1.0 - Initial version.
- 0.2.0 - Recurred on flow 128 (PR #216) with the same root cause. Records what
  actually broke the pattern: a guard shaped per-class rather than per-site, so
  fixing four members of five leaves it red.
