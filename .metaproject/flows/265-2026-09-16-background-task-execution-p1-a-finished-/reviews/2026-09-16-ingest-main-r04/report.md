# Review round 4 — flow 265, re-run against the head that merged

This round exists for one reason, and it is worth stating plainly rather than
burying: round 3 ran against `50d12cf`, the commit that fixed its own findings,
but the pull request's head was `c42d4a3` — three bookkeeping commits later. The
completion gate refused, and it was right to: a clean round against a stale SHA
proves nothing about what merges.

What moved between the two commits is recorded, not asserted:
`git diff 50d12cf..c42d4a3 -- src scripts docs` reports **0 changed files**. The
delta is the review package itself, the health and testing artifacts, the rebuilt
graph and the flow journal. No source, no test, no documentation.

So the findings below are the same two, re-verified at `c42d4a3`:

- The probe (`scratchpad/p1-review-probe.ts`) was re-run against this head and
  reports `[A] rounds=3 notifications=1 undrained_after_turn=0` and
  `[B] notifications_after_turn1=1 undelivered_between_turns=0
  notifications_after_turn2=1`. Both cases fail if the defect is present.
- CI ran the full matrix on `c42d4a3`: 18 checks passed, 0 failed, including
  `typecheck-and-tests` — which also settles the one local suite failure
  (`scripts/install-global.test.ts`, a 120 s hook timeout under local load;
  3/3 in isolation, green on a clean runner).

The findings themselves, their impact and their class scope are unchanged from
round 3; both were already fixed in `50d12cf` and carry `acted-on` dispositions
citing it.

## F-001 (blocker) — a task that finished a moment too early was reported by nobody

The hold engaged only for a task that was still RUNNING, and the return under it
drained nothing, so a task that reached a terminal status between the last
round-boundary drain and the text-only finish was delivered by nobody. In an
unattended `--print` session that is the failure the whole phase exists to
prevent.

## F-002 (major) — AC10's promise to the operator was false

The same site in `wake` mode: a pending completion must reach the next operator
turn, but a text-only answer has no tool batch for the round-boundary drain to
ride on, while both shells promise the operator "it will be reported with your
next message".

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "orchestrator-self-review",
    "severity": "blocker",
    "file": "src/commands/agent.ts",
    "quote": "return {}; // error, or a text-only finish → turn complete",
    "symbol": "runAgentTurnCore",
    "problem": "At the text-only finish the loop held only when a task was STILL RUNNING, and the return under it drained nothing, so a task that reached a terminal status between the last round-boundary drain and this finish was delivered by nobody.",
    "impact": "In hold mode this is the phase's own headline failure: an unattended --print session starts a command, answers with text, the command exits while that text is produced, the turn returns, the session sweep kills what is left, and the command's result is reported to nobody.",
    "suggested_fix": "Drain what is already finished FIRST, in either delivery mode, and only then decide whether to hold for something still running.",
    "evidence": "Execution against real subprocesses before the fix (scratchpad/p1-review-probe.ts, case A, hold mode, sleep 0.4 against yieldMs 150): `[A] rounds=2 notifications=0 undrained_after_turn=1`.",
    "confidence": "high",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/commands/agent.ts — the text-only return (the defect)",
        "src/commands/agent.ts — the hold's own drain after a completion or a hold-timeout kill (correct)",
        "src/commands/agent.ts — the round-boundary drain after a tool batch (correct)",
        "src/commands/agent.ts — the notification-origin drain at turn start (correct)"
      ],
      "enumeration_method": "keryx ctx rg --all \"drainUndelivered\" src/commands/agent.ts, then read every exit out of the round loop and classify it as draining or not: four sites can end a turn with a registry attached; three drained, one did not."
    }
  },
  {
    "id": "F-002",
    "reviewer": "orchestrator-self-review",
    "severity": "major",
    "file": "src/commands/agent.ts",
    "quote": "const stillRunning =",
    "symbol": "runAgentTurnCore",
    "problem": "The same site breaks AC10's second half in wake mode: a completion left undelivered must reach the next operator turn, but a text-only answer has no tool batch, so the round-boundary drain never runs and the pending notification is not handed over.",
    "impact": "Both shells print 'a shell task finished; automatic wakes are capped, so it will be reported with your next message' when the cap is hit. With this defect that promise is false whenever the operator's next turn is answered with text, which is the common case for a question.",
    "suggested_fix": "Deliver the drained completions at the text-only finish in wake mode too, then continue the turn so the model can react.",
    "evidence": "Execution against real subprocesses before the fix (scratchpad/p1-review-probe.ts, case B, wake mode): `[B] notifications_after_turn1=0 undelivered_between_turns=1 notifications_after_turn2=0`.",
    "confidence": "high",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/commands/agent.ts — the text-only return reached by an operator turn (the defect)",
        "src/commands/shell.ts — the readline cap message promising delivery on the next message",
        "src/tui/tui-shell.ts — the TUI cap message making the same promise"
      ],
      "enumeration_method": "keryx ctx rg --all \"will be reported with your next message\" src — two promise sites, both in shells; the single delivery path they depend on is the agent loop's text-only finish."
    }
  }
]
```
