# Review round — flow 212, SAC ledger content commitment

Target: PR #422 head `6b1c05d9`, merged as `fe0431fc`. Round run after merge,
because the flow was completed through the gate only afterwards; findings were
therefore landed as a follow-up PR (#423) rather than as fix commits on #422.

## Method

`review-testing-practices` led with a **mutation pass** rather than a checklist,
which is what produced every finding here. Each gate the change added was deleted
one at a time, `bun test src/sac/fwk-service.test.ts` was run, red/green recorded,
and the file restored from a byte-identical backup. The pass was proved
non-vacuous first: deleting the digest comparison turned the suite red (26 pass /
2 fail), so a green result under mutation means the gate is genuinely unwatched.

Four gates were mutated. Three came back green.

| Gate | Mutated result | Verdict |
|---|---|---|
| `digest.copy().digest("hex") !== checkpoint.contentDigest` | **26 pass / 2 fail** | guarded |
| `ledgerBytes !== checkpoint.ledgerBytes` | 28 pass / 0 fail | **F1 — unguarded** |
| post-append `ledgerByteLength(ledger) !== ledgerBytes` | 28 pass / 0 fail | **F2 — unguarded** |
| `ledgerBytes < checkpoint.ledgerBytes` | 28 pass / 0 fail | F3 — redundant, cleared |

## Findings

**F1 — a stale checkpoint over a grown ledger breaks the chain it is meant to
protect.** Without the length comparison, `fastCheckpointState` reads the tail
record at the stale `tailOffset`, validates it (it is a real record), and returns
the stale `headHash`. The next append then chains from a record that is no longer
last. The result is a silently broken integrity chain produced by the code whose
job is to keep it intact — worse than the tampering the flow set out to detect,
because nothing refuses. The state is reachable, not theoretical: the ledger
append is the commit point and its checkpoint refresh is explicitly allowed to
fail, which is exactly a stale checkpoint over a longer ledger.

**F2 — the post-append size check is what keeps the digest fold honest.**
`state.digest` carries the audited pre-append bytes, and the checkpoint folds the
written line into it without re-reading the file. That is sound only while the
file is exactly the audited prefix plus that line. Delete the check and the
checkpoint commits to a byte sequence that was never on disk — the flow's own
defect, one layer down. Reached in test through `verifyReceiptLedger`, which runs
inside the audit between the read and the append.

**F3 — `ledgerBytes < checkpoint.ledgerBytes` — checked and cleared.** Its removal
is invisible for a good reason rather than a bad one: `digestLedgerPrefix` returns
`undefined` on the short read and the caller throws the identical
`truncated-ledger`. Redundant by construction. Recorded so the next mutation pass
does not re-open it as a gap.

## What this says about the flow's own criteria

The flow claimed mutation proof, and that claim was true — of the digest
comparison specifically. It did not extend to the gates around it. The claim was
accurate and the coverage was not; that gap is the finding worth carrying
forward, not the two tests.

## Verification

Fixes landed in #423 (tests only, no production change). Each proved by deleting
its guard and watching the new test go red **3/3 in isolation**, then restoring
and re-verifying green.

typecheck clean · `bun test` 6337 pass / 18 skip / 0 fail · `test:guards` 173 pass
/ 0 fail · `check:doc-links` 1144 links / 0 broken · CI on #423 12/12.
