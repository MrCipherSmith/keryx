# Review round 1 — flow 265 (background task execution P1)

Both dispatched reviewers stalled before producing a line (179-byte transcripts, no
output in 29 minutes, last words "I'll start with the project hard gate"). They were
stopped and the diff was reviewed by the orchestrator instead — recorded here as
`orchestrator-self-review` rather than as a reviewer skill that never ran.

Two findings, one defect with two faces, both at the text-only finish of the agent
turn (`src/commands/agent.ts`). Each was confirmed by EXECUTION against real
subprocesses before being written down, and each was re-run after the fix: the probe
`scratchpad/p1-review-probe.ts` drives the real `runAgentTurn`, the real registry and
a real `sleep` command, and fails if the finding is real.

Deterministic guards for the same round: `keryx review floor --ref main` reported 0
findings over 28 files and 2 458 changed lines; the blast-radius record covers 40 of
85 candidate files (cap) with 18 changed files absent from the code graph.

## F-001 (blocker) — a task that finished a moment too early was reported by nobody

The hold engaged only for a task that was STILL RUNNING, and the `return` under it
drained nothing. In an unattended `--print` session the model starts a command,
answers with text, the command exits while that text is produced — and the turn ends,
the session sweep kills what is left, and the result reaches no one. That is the exact
failure this phase exists to prevent. Before the fix the probe reported `rounds=2
notifications=0 undrained_after_turn=1`; after it, `rounds=3 notifications=1
undrained_after_turn=0`.

## F-002 (major) — AC10's promise to the operator was false

The same site, in `wake` mode: a pending completion must reach the next operator turn,
but a text-only answer has no tool batch for the round-boundary drain to ride on. Both
shells print "it will be reported with your next message" when the auto-wake cap is
hit, so the promise was in the product, not just in the criteria. Before the fix:
`notifications_after_turn2=0`; after: `1`.

## Fix

Drain what is already finished first, in either delivery mode, then decide whether to
hold for what is still running. Three tests were written first and seen red against
the unfixed code (2 fail / 1 pass); the third pins that an empty drain must not buy
delivery with an extra round.

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
    "evidence": "Execution against real subprocesses before any fix (scratchpad/p1-review-probe.ts, case A, hold mode, sleep 0.4 against yieldMs 150): `[A] rounds=2 notifications=0 undrained_after_turn=1`.",
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
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Re-ran the same probe against the fixed tree: `[A] rounds=3 notifications=1 undrained_after_turn=0`, and the live hold smoke still passes (3 rounds, elapsed 2 041 ms, one notification with SMOKE_DONE). The finding no longer reproduces.",
      "verifier": "p1-review-probe (execution, scratchpad/p1-review-probe.ts)"
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
    "impact": "Both shells print 'a shell task finished; automatic wakes are capped, so it will be reported with your next message' when the cap is hit (src/commands/shell.ts, src/tui/tui-shell.ts). With this defect that promise is false whenever the operator's next turn is answered with text, which is the common case for a question.",
    "suggested_fix": "Deliver the drained completions at the text-only finish in wake mode too, then continue the turn so the model can react.",
    "evidence": "Execution against real subprocesses before any fix (scratchpad/p1-review-probe.ts, case B, wake mode): `[B] notifications_after_turn1=0 undelivered_between_turns=1 notifications_after_turn2=0`.",
    "confidence": "high",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/commands/agent.ts — the text-only return reached by an operator turn (the defect)",
        "src/commands/shell.ts — the readline cap message promising delivery on the next message",
        "src/tui/tui-shell.ts — the TUI cap message making the same promise"
      ],
      "enumeration_method": "keryx ctx rg --all \"will be reported with your next message\" src — two promise sites, both in shells; the single delivery path they depend on is the agent loop's text-only finish."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Re-ran the same probe against the fixed tree: `[B] notifications_after_turn1=1 undelivered_between_turns=0 notifications_after_turn2=1`, and the new suite test 'F-002: AC10 — a pending completion reaches the next operator turn even with no tool call' passes. The finding no longer reproduces.",
      "verifier": "p1-review-probe (execution, scratchpad/p1-review-probe.ts)"
    }
  }
]
```
