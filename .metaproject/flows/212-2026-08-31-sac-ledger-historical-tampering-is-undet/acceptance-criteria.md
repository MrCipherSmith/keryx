# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Tampering with any historical record in the access-receipt ledger is detected, including a same-size rewrite that leaves `mtimeNs` and `ctimeNs` unchanged. Measured on this machine, an in-place same-size rewrite left both timestamps identical in **189 of 200** attempts, so the timestamp is not a signal that can carry this.
- AC2: Detection does not rest on `stat` metadata. `fastCheckpointState` trusts the checkpoint whenever `identityMatches` holds — `ledgerBytes`, `device`, `inode`, `modifiedNs`, `changedNs` — and then verifies only the tail record. Whatever replaces that must derive its confidence from **content**, not from the filesystem's opinion about when the file changed.
- AC3: The existing test `same-size historical receipt corruption invalidates the checkpoint and refuses append` passes **deterministically**. It is currently nondeterministic — 3 of 6 isolated runs — because it is a correct test of a property the code only sometimes has. It must not be quarantined, weakened, or made to pass by loosening its assertion.
- AC4: The fix is proved by a mutation: break the new detection, watch that test go red, restore it. A security check whose absence no test notices is the defect being fixed, reintroduced.
- AC5: The fast path may remain fast. This is not licence to re-verify the whole ledger on every append if a cheaper sound method exists, but correctness wins over speed where they conflict, and any retained optimisation states what it assumes and why that assumption holds.
- AC6: Whatever the checkpoint stores is enough to detect tampering **anywhere** in history, not only in the tail. If the chosen design cannot detect a mid-ledger edit, it does not satisfy this criterion regardless of how fast it is.
- AC7: Existing on-disk ledgers keep working. A checkpoint written by the current code must not be silently trusted under the new rule if it cannot support the new guarantee — an old checkpoint that cannot be verified is re-audited, never assumed valid.
- AC8: The failure mode is stated in the record. When verification cannot run — a missing file, an unreadable checkpoint, a truncated ledger — the result is a refusal, never a pass. Absence of a detected problem is not evidence of integrity.
- AC9: `bun run typecheck` clean; `bun test` has no new failures against the baseline recorded in this flow's journal, and the previously nondeterministic SAC test is green across at least five consecutive isolated runs; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
