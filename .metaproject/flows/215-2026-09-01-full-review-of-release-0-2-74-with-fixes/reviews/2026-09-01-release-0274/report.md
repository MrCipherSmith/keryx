# Review round — release 0.2.74, full review with fixes

Target: `main` at `10741e10`, reviewing the range `v0.2.73..v0.2.74` (43 non-test
source files, 36 test files). Fixes landed as #427 and #428.

## Method

Six reviewers in parallel, assigned by area with distinct lenses rather than
split evenly: SAC integrity guarantees; harness process and subagent lifecycle
(the largest area at 535 changed lines); flow + reviewers, lensed on "a mechanism
documented as enforcement that nothing calls"; the CLI boundary, hunting the
false-clean class; the skills registry as a promise; and the ten small files
scattered across unrelated modules — the group a review focused on big diffs
stops reading, which is where the session-redaction finding came from.

All six ran **read-only**. They named mutation candidates; mutations were run
centrally, one at a time. The reason is not caution in general: they share one
worktree, and parallel agents editing the same files is precisely the defect this
programme fixed in `task-implementer`, where one agent's revert destroys a
wave-mate's uncommitted work that the wave-mate cannot observe. Reproducing it
inside our own review would have been absurd.

Alongside the fan-out, a mutation pass over every gate the release added:
delete, run, record, restore. Proved non-vacuous first — deleting the digest
comparison returned 26 pass / 2 fail — because a sweep that can only return green
proves nothing.

## Mutation pass result (14 gates)

| Outcome | Count |
|---|---|
| Guarded by a test (deletion goes red) | 4 |
| Guarded by the compiler (deletion does not build) | 3 |
| Removable with the full suite green | 5 |
| Not uniquely anchorable (multi-line throw) | 1 |

Deleting BOTH SAC truncation gates made the suite **hang** rather than fail —
an infinite loop in `digestLedgerPrefix`. A hanging suite is worse than a failing
one: CI reports a timeout, which reads as infrastructure trouble.

## Findings

Ten in total. Two security-critical, and both trace to one commit — `508f7b2d`,
"remediate validated full-project review findings" — which shipped two new guards,
neither of which fully worked.

1. **The security acknowledgement that never happened.** `consumeConfirmToken`
   refuses a `needs-approval` proposal unless the token carries
   `securityAcknowledged: true`; the only production minter passed that literal
   unconditionally. The gate could not fire while its error text promised
   "explicit human acknowledgement of the proposal security findings". Found
   independently by two reviewers from different directions. Pre-0.2.74 was a
   dead end (no `needs-approval` proposal could be accepted at all), so the
   release traded permanently-broken for silently-defeated — the worse of the two,
   because the refusal used to be visible.

2. **Redaction covering half its surface.** `redactHistory` rewrote `content` and
   let the spread carry `toolCalls` through untouched, while `writeJsonl`
   serialises them verbatim into three files. A credential the model read from one
   tool result and passed into the next call's arguments landed on disk in the
   clear — through the function written to prevent exactly that.

3. **A validator keyword ignored for the third time.** `maxItems`, declared by a
   contract registered this release, with no branch in `validateValue`.

4. **The prose-target guard on one write path of two.** Wired into the SAC wrap-up
   path; `keryx skills create` — the path agents are instructed to use — never
   called it.

5. **A false clean one section below the false clean this release fixed.**
   `renderRiskHints` printed `- none` for a shape with a file count but no rows.

6. **An escape that escaped nothing.** A character class closing at its first `]`,
   making the escape a complete no-op. Latent.

7–10. Four gates the mutation pass found unwatched: `parseCheckpoint`'s key-set
   /version check, the `tailOffset`/`tailBytes` bounds check, and the blocked-note
   refusal in BOTH the harness tool and the CLI — a guard duplicated across write
   paths, covered on only one.

## Findings dropped

The `workspace_propose` create-then-write atomicity concern was reported with the
reviewer's own caveat that the ordering predates this release; it is real but not
in scope, and is recorded rather than fixed. `realSpawner`'s absent runtime
coverage is a coverage gap with no demonstrated defect.

## Corrections to my own work

Three of my tests initially passed for the wrong reason, each caught by mutation
rather than by reading:

- one asserted the printed token instead of the stored one, so restoring the
  shipped `securityAcknowledged: true` left it green;
- one sealed a checkpoint's integrity hash over the very key it was testing, so
  the record failed its hash check instead of the gate;
- one omitted the session, so the command exited 1 with and without the guard.

All three corrected and re-proved. The guard added for finding 3 also produced a
false positive on `$ref` (implemented, but the scrape pattern missed a leading
`$`), fixed before landing.

## What is not fixed

Two truncation lines remain individually removable. They are genuinely redundant
— same refusal for the same input, with a third check now backing both — so no
test can discriminate them. Stated rather than papered over. The flow-212
disposition that called this pair "checked and cleared" is corrected: it rested
on one being redundant without checking whether the other was pinned, and neither
was. The hang is separately removed by bounding the read loop.

## Verification

typecheck clean · `bun test` 6399 pass / 18 skip / 0 fail (baseline 6386/0) ·
`test:guards` 173 pass / 0 fail · `check:doc-links` 1144 links / 0 broken ·
CI 12/12 on both #427 and #428.
