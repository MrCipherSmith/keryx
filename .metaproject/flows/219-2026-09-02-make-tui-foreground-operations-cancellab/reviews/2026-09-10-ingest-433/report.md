# Review Report - MrCipherSmith/keryx#433

## Verdict: APPROVE_WITH_SUGGESTIONS

## Summary

Retrospective review of a diff merged on 2026-09-03. One finding, major, and it
is about the evidence rather than the behaviour: the Force-handoff wiring was
covered by a test that reads the shell as TEXT, and a guard deleted from
between two matched lines is invisible to that.

The reviewer did not argue this; it deleted the guard and watched all four
assertions pass and the whole file stay green. The guard prevents a
double-dispatch whose failure mode is an exception out of a floating promise,
and the flow's own history records that regression found and fixed in review
twice.

Fixed in 1f5bb43e by moving the rules into a seam a test can call, and
independently re-checked there.

## Findings

### R1-TEST-001 - a guard covered only by a text match

Fixed in 1f5bb43e: `forceForegroundQueueItem` holds the rules, three behavioural
tests drive two overlapping presses, and the audit keeps only the claim
execution cannot make from there - that the shell calls the seam and has not
reimplemented it inline. `refuted` at 1f5bb43e: deleting the guard now fails two
behavioural tests with the real exception.

## Verification

Independent verifier, method `execution`, at 1f5bb43e, neither the raiser nor the
fixer. It also checked something the fix did not claim: whether the behavioural
test's model matches production, since the test relies on `run` re-opening the
operation. It traced `runLine` in tui-shell.ts to its own `begin()` call and
confirmed the prior turn's finalizer settles synchronously before the
continuation resumes. The test is not manufacturing its own failure.

## Recorded as still open, narrower than the finding

The same verification found two shell-wiring regressions that remain invisible,
because the boundary "the shell calls the seam in the right shape" is still
asserted by text:

  - dropping the `void` before the call, leaving a rejection unhandled;
  - reordering `paintMainQueue()` relative to the dispatch.

Both are narrower and less severe than the original - the double-dispatch guard
itself is now protected - and both are recorded rather than closed, because
closing them needs a headless seam for `launchTuiAgentShell` that this flow is
not the place to build.

## The structured findings

```json keryx:findings
[
  {
    "id": "R1-TEST-001",
    "reviewer": "review-pr433",
    "severity": "major",
    "problem": "The Force-handoff wiring in forceMainQueue was covered only by a source-text audit that reads tui-shell.ts as text and regex-matches windows around anchor strings. Deleting the guard `if (!waitsForSettlement) return;` left all four audit assertions passing and the whole 101-test file green.",
    "impact": "That guard is what stops a second Force press, arriving while the first is still settling, from awaiting settlement too and dispatching a second item into the operation the first has re-opened - `begin()` throwing 'a foreground operation is already active' out of a floating promise. The flow's own history records that exact regression found and fixed in review twice. A rule deleted from BETWEEN two matched lines is invisible to a text audit, so the class of regression this flow already suffered twice could ship green.",
    "suggested_fix": "Extract the handoff logic into a directly-callable seam the way runAfterForegroundSettlement and ForegroundForceHandoff already were, and drive it with two overlapping presses.",
    "evidence": "Removed the guard from forceMainQueue and ran the suite: `bun test src/tui/tui-shell.test.ts -t \"flow 219\"` gave 5 pass, 0 fail, and the full file gave 101 pass, 0 fail. Reverted; git status clean.",
    "confidence": "high",
    "file": "src/tui/tui-shell.test.ts",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/tui/tui-shell.test.ts - the four tests in the 'flow 219 ... (source-text audit)' describe block"
      ],
      "enumeration_method": "Read the whole describe block and confirmed every test shares the readFileSync + indexOf/toMatch pattern, then checked project-wide that no other test drives launchTuiAgentShell end to end."
    },
    "global_id": "2026-09-10-ingest-433#R1-TEST-001",
    "source": "internal"
  }
]
```
