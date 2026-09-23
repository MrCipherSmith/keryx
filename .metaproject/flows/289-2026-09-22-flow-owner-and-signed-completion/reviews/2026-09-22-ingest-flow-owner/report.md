# Review — flow 289, flow owner and signed completion (PR #649)

One review round ran over `src/flow/identity.ts`, `src/flow/service.ts`,
`src/flow/types.ts`, `src/flow/schema.ts`, `src/commands/flow.ts`, and the new
and touched test files under `src/flow/`, plus the docs and decision record
that describe the owner, the signatures, and the owner gate. The round found
no blocking defect: the owner field, its history, the identity/basis/source
model, the append-only signatures, the opt-in owner gate, backward
compatibility, `flow status`'s new lines, and the docs were all present and
tested. It raised five minor gaps — a real-shape test hole, a missing
invariant test, a cross-command inconsistency, a stale test title, and
imprecise wording about what a recorded head commit proves. All five were
fixed on the branch before merge. PR #649 merged as `4606181f` with 18/18
checks green at head `23b5023f`.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (flow)",
    "severity": "minor",
    "file": "src/flow/owner-gate.test.ts",
    "quote": "!flow.gates?.owner",
    "problem": "The owner gate's backward-compatibility read (`!flow.gates?.owner`) was exercised only against a fixture with `gates` absent entirely, not against the real shape every flow written between flow 201 (task gate) and this change carries on disk: `gates` present, `tasks` and `review` both `true`, and simply no `owner` key.",
    "impact": "A future regression that read gate opt-in as `!flow.gates` rather than `!flow.gates?.owner` would pass every existing test while breaking the owner gate for every pre-existing on-disk flow package, since none of them carry the coarser 'no gates object at all' shape.",
    "suggested_fix": "Add a test using the real flow-201/204 shape (`gates: { tasks: true, review: true }`, no `owner` key) and assert the owner gate reports skipped.",
    "evidence": "Before the fix, owner-gate.test.ts's only legacy-shape coverage used a fixture with `gates` entirely absent, not the on-disk shape flow-201/204 packages actually carry.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "bun test src/flow/owner-gate.test.ts runs the new test at line 162, 'AC5: the REAL flow-201/204 legacy shape — `gates: { tasks: true, review: true }`, no `owner` key at all — skips the owner gate too', which asserts the raw on-disk shape and that the gate reports skipped; bun test src/flow/ 261/261 pass, 0 fail. Verified on the tree merged to main in 4606181f via PR #649.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "merged to main in 4606181f via PR #649"
    }
  },
  {
    "id": "F-002",
    "reviewer": "code-reviewer (flow)",
    "severity": "minor",
    "file": "src/flow/signatures.test.ts",
    "quote": "leaves signatures and the owner (and its history) untouched",
    "problem": "No test asserted that `flow ac update` — which clears `acConfirmed` when a criterion's text changes — leaves `signatures` and `owner`/its history alone.",
    "impact": "A regression that wiped signatures or owner history on `ac update` would have passed every existing test, defeating the append-only guarantee AC2 and AC4 depend on.",
    "suggested_fix": "Add a test that confirms an AC, sets an owner, runs `ac update`, and asserts signatures and owner/history are unchanged while acConfirmed clears.",
    "evidence": "signatures.test.ts covered signature append on confirm/complete but had no test naming `ac update`.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "bun test src/flow/signatures.test.ts runs the new test at line 132, '`flow ac update` clears acConfirmed but leaves signatures and the owner (and its history) untouched'; bun test src/flow/ 261/261 pass, 0 fail. Verified on the tree merged to main in 4606181f via PR #649.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "merged to main in 4606181f via PR #649"
    }
  },
  {
    "id": "F-003",
    "reviewer": "code-reviewer (flow)",
    "severity": "minor",
    "file": "src/flow/service.ts",
    "quote": "BLANK_OWNER_MESSAGE",
    "problem": "`flow owner set --owner \"   \"` correctly refused a blank owner, but `flow init --owner \"   \"` silently treated it as absent and reported `owner: not set` instead of refusing — the same input produced two different outcomes depending on which command set it.",
    "impact": "An agent or script passing a blank/whitespace owner through `init` got silent success and a flow that looks unowned, while the identical value through `owner set` failed loudly — an inconsistency that could mask a missing owner as 'nobody ever tried'.",
    "suggested_fix": "Share the blank-owner guard between `init` and `owner set` so both throw the identical message.",
    "evidence": "init's owner-handling path had no guard mirroring the one already in `ownerSet`.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "bun test src/flow/owner.test.ts runs the new tests at lines 81 and 92: `flow init --owner \"   \"` now throws BLANK_OWNER_MESSAGE, asserted byte-identical to `flow owner set`'s message; bun test src/flow/ 261/261 pass, 0 fail. Verified on the tree merged to main in 4606181f via PR #649.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "merged to main in 4606181f via PR #649"
    }
  },
  {
    "id": "F-004",
    "reviewer": "code-reviewer (flow)",
    "severity": "minor",
    "file": "src/flow/review-gate.test.ts",
    "quote": "seventh, after owner",
    "problem": "A review-gate ordering test's title still read 'sixth, after tasks', left over from before the owner gate was inserted between tasks and review, and its assertion checked only that review ran after tasks, not that it also ran after owner.",
    "impact": "The stale title misdescribed the gate's actual position to any future reader, and the weaker assertion would not have caught a regression letting review run before owner while still running after tasks.",
    "suggested_fix": "Rename the test to its actual position (seventh, after owner) and strengthen the assertion to also check review runs after owner.",
    "evidence": "The test predates the owner gate's insertion into the gate sequence and was never updated when the sequence changed.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "site-check",
      "evidence": "src/flow/review-gate.test.ts line 1334 now reads 'the gate runs where the specification puts it: seventh, after owner', and its body asserts review runs after both tasks and owner; bun test src/flow/ 261/261 pass, 0 fail. Verified on the tree merged to main in 4606181f via PR #649.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "merged to main in 4606181f via PR #649"
    }
  },
  {
    "id": "F-005",
    "reviewer": "code-reviewer (flow)",
    "severity": "minor",
    "file": "src/flow/types.ts",
    "quote": "pull-request gate observed",
    "problem": "`headCommit`'s doc comment (and the matching comment in service.ts, and its description in the CLI reference and the TM-02 decision doc) described it as the head commit 'the completion gates evaluated' — implying every gate confirmed the same commit — when only the pull-request gate's own `prStatus()` fetch is actually captured into it; other gates such as review re-fetch the head independently.",
    "impact": "A reader could believe a signature's recorded headCommit is a cross-gate guarantee that every gate saw that exact tree, when a push mid-`complete()` could let review observe a different head than the one the signature records — the prior wording overstated what the field proves.",
    "suggested_fix": "Reword every occurrence to say precisely that headCommit is the head the pull-request gate observed via its own fetch, and note that other gates re-fetch independently.",
    "evidence": "The prior wording in types.ts's doc comment and service.ts's evaluatedHeadCommit comment both said 'the completion gates evaluated' rather than naming the single gate whose observation is captured.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "site-check",
      "evidence": "src/flow/types.ts line 169 now reads 'head commit the pull-request gate observed via its own `prStatus()` call', with the same correction carried into service.ts's evaluatedHeadCommit comment, docs/docs/cli-reference.md, and the TM-02 decision doc's §3, plus an explicit note that base-branch/review gates re-fetch independently. Verified on the tree merged to main in 4606181f via PR #649.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "merged to main in 4606181f via PR #649"
    }
  }
]
```

## Coverage

Reviewed: `src/flow/identity.ts` (Identity/IdentityBasis, resolveSignerIdentity,
ownerIdentity, describeIdentity); `FlowState.owner`/`FlowState.signatures`,
`FlowGates.owner`, and the `GateOutcome` "owner" member in
`src/flow/types.ts`; the `ownerGate` and owner/signature writes in
`init`/`acConfirm`/`complete` in `src/flow/service.ts`; the additive-only
`owner`/`signatures`/`identity`/`flowSignature` schema definitions in
`src/flow/schema.ts` and the regenerated JSON Schema copy; the
`flow init --owner`, `flow owner set`, `--signed-by`, and `flow status`
wiring in `src/commands/flow.ts`; every new and touched test file
(`identity.test.ts`, `owner.test.ts`, `owner-gate.test.ts`,
`signatures.test.ts`, `owner-backward-compat.test.ts`,
`owner-status-cli.test.ts`, and the pre-existing `src/flow/*.test.ts` files
whose gate-list/count assertions needed updating); and the docs
(`docs/docs/cli-reference.md`, `README.md`,
`docs/decisions/keryx-harness/TM-02-flow-owner-and-signed-completion.md`).
Not reviewed: the rest of the repository, unchanged by this flow.

## Outcome

Five findings, all minor, all acted on and re-verified; none dismissed. No
blocking defect was found in the owner field, its history, the
identity/basis/source model, the append-only signatures, the opt-in owner
gate, backward compatibility, or `flow status`'s new lines. `bun test
src/flow/` is 261/261 pass, 0 fail on the merged tree; CI is 18/18 green on
PR #649 at head `23b5023f`, merged as `4606181f`.
