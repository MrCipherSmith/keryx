# A fix round needs its own review: three consecutive rounds each introduced a blocker

Version: 0.4.0
Type: lesson
Status: accepted
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

## Round five (PR #220, flow 133): the remedy worked, and three NEW shapes appeared

The flow-129 machinery did its job. Five reviewers ran with `class_scope`
required, the fix round recorded itself, and the review found **two blockers and
eight majors in a tree that was green at 2820 pass / 0 fail**. One finding was
reported independently by all five reviewers. Without that review both blockers
would have merged.

So the process fix holds. What recurred is the *authoring* side, in three shapes
this file had not named before. Each is a way of fixing the example instead of
the class that LOOKS like fixing the class.

**Shape A — the signature carries a failure the caller still ignores.**
`finishTurn` was changed from `void` to `boolean` with a docstring reading "The
boolean is the point", precisely because a silent no-op had stranded turns. Its
one caller discards the value. Behaviour unchanged; the type now asserts a
property the code does not have, which is **worse than the `void` it replaced**,
because the next reader believes it. Found by all five reviewers.

The same shape one layer out: the store gained a typed `TurnReadResult` so
`too-large` could stop masquerading as "no events". Two of the four callers
branch on it. One collapses every failure into `sessionId: ""` on an HTTP 200 —
a null record standing in for a stated failure, on the one path that reaches a
success status.

**Shape B — the test written to close "verified through a fixture" asserts only
shape.** The previous blocker was "nine of twelve criteria verified through
`handleServeRequest` with an injected runner, never against a listener the CLI
can start". The fix added a real-socket suite: real `startServeListener`, port 0,
real bearer token, real TCP. It passes — on a turn that never runs. The
production assembly omits `containmentAvailable`, the default profile requires
containment, so every submission is `refused`. And a refusal is also 202, also
emits `turn.started` then `turn.finished`, and also has a defined `outcome`. Not
one test asserted `outcome === "completed"` or that any assistant text reached
the caller. **The right layer, the wrong assertion.**

**Shape C — a selection policy changed to protect X, without asking who becomes
the victim.** The throttle evicted peers in cooldown, so a flood cleared your own
ban. The fix made eviction skip peers in cooldown. But eviction runs from
`recordFailure` right after the new peer is inserted, so once every other peer is
in cooldown the newcomer is the only candidate and evicts itself every time —
it can never accumulate to the limit. Saturate with 1024 bans and **every fresh
address guesses the token forever**. Measured: 1000 consecutive failures, never
throttled; the pre-fix rule throttled the same peer after 10. The fix made the
hole strictly larger, and the three new tests all probed the one peer that is
never evicted.

Two smaller ones worth the same shelf:

- **A justification can be false while the code is fine.** Two rank tables were
  defended in a comment as "inverses on the same field". They are not — reverse
  one and two of three values do not move. A wrong explanation is worse than
  none: the next reader re-derives the distinction *and* concludes the code
  disagrees with its doc. The real content was that the field carried two axes.
- **A guard can enumerate names where it means shapes.** The guard added for
  "only one ranking table exists" matched four identifiers. The duplicate it
  commemorates was two `switch` functions under neither name — pasted back
  verbatim, the guard stayed green. That is `allowlist-not-a-boundary` applied to
  a guard built to enforce `allowlist-not-a-boundary`.

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
- **When you widen a signature to carry a failure, the fix is not the signature.
  It is the caller.** Grep every call site in the same commit and make one of
  them observe the new value in a test, or you have shipped a type that lies.
- **When you write a test to prove a capability WORKS, assert the capability,
  not the envelope.** Ask: what does this assertion say under the failure I am
  trying to exclude? If a refusal and a success produce the same status, the
  same event kinds and the same defined field, the test proves the route is
  reachable and nothing else. Assert the outcome value and the payload.
- **When you change who survives an eviction, a cache or a queue, name the new
  victim out loud.** Every selection policy has one. Then test the victim's
  side: not "is the protected thing still there" but "can the thing this control
  exists to catch still be caught".
- **Do not defend a design with a claim you have not evaluated.** If the comment
  says two things are inverses, compute the inverse. A false justification
  survives longer than a false line of code, because nothing executes it.
- **A guard must match the SHAPE of the offence, not a list of the names it has
  worn.** Before landing one, reconstruct the actual defect from git history and
  run the guard against it. If it stays green, the guard commemorates the bug
  rather than preventing it.

## Provenance

- Source: review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133)
- Link: https://github.com/MrCipherSmith/keryx/pull/215
- Link: https://github.com/MrCipherSmith/keryx/pull/216
- Link: https://github.com/MrCipherSmith/keryx/pull/220
- Created: 2026-07-31
- Updated: 2026-08-02

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
- 0.3.0 - Promoted `draft` -> `accepted` (flow 129). Two flows, eleven rounds and
  two independent recurrences are enough evidence; and the status now has a
  mechanical consequence, because the review pipeline inlines memory filtered to
  `--status accepted`. Left as a draft, the one lesson naming this exact failure
  would have been excluded by the very mechanism built to surface it.
  Round 4 on PR #216 confirmed the pattern a fourth time and located why it kept
  recurring: nothing in the review pipeline read this file. Reviewer input
  carried no prior findings, no memory search ran, and eleven rounds produced no
  managed-review package to diff against. Flow 129 makes `class_scope` a schema
  requirement for blocker and major findings, makes `prior_findings` and
  `metaproject` required on a fix round, and makes a fix round record itself.
- 0.4.0 - Round five (PR #220, flow 133). The flow-129 machinery worked: five
  reviewers found two blockers and eight majors in a tree green at 2820 pass / 0
  fail, and one finding was reported independently by all five. What recurred was
  the authoring side, in three shapes now named here - a widened signature whose
  caller still ignores it, a test at the right layer asserting only the envelope
  so a refusal passes as a success, and an eviction policy changed to protect one
  party without asking who becomes the victim. Plus two smaller: a justification
  that is false while the code is fine, and a guard that enumerates names where it
  means shapes.
