# Flow 272 review record, rounds r1–r3

PR https://github.com/MrCipherSmith/keryx/pull/611.

| Round | Head | Result |
|---|---|---|
| r1 | 3cf09b6d | F1 (major), F2–F5 (minor), F6 (info) |
| r2 | e9aec174 | F1–F6 refuted; new N1 and N2 (minor) |
| r3 | 9740c068 | N1 and N2 refuted; clean |

Fix commits: c74f5a39 fixes F1–F6; 0d27d6d3 fixes N1 and N2.

```json keryx:findings
[
 {
  "id": "F1",
  "reviewer": "review-orchestrator",
  "severity": "major",
  "file": "src/bus/log.ts",
  "line": 408,
  "problem": "A rotation between listing the rotated segments and reading events.jsonl loses a segment",
  "impact": "The cursor is on segment S. The reader lists the segments up to S. A writer then rotates S+1 and appends the first line of S+2. Step 3 reads S+2, seq jumps past S+1, and S+1 is never delivered.",
  "suggested_fix": "Open events.jsonl and keep the fd (inode X) before listing the rotated segments. Skip the rotated segment whose inode is X. Take the cursor's segment from where X actually is.",
  "evidence": "src/bus/log.ts:408 at the round's head; The cursor is on segment S. The reader lists the segments up to S. A writer then rotates S+1 and appends the first line of S+2. Step 3 reads S+2, seq jumps past S+1, and S+1 is never delivered.",
  "confidence": "high",
  "source": "internal",
  "class_scope": {
   "sites": [
    "src/bus/log.ts:readEvents moved branch (401-421)",
    "src/bus/log.ts:cursorAtEnd (425-432) same path-then-list order"
   ],
   "enumeration_method": "Read every function in log.ts that combines listRotatedSegments with a path-based read of eventsPath."
  }
 },
 {
  "id": "F2",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/bus/log.ts",
  "line": 259,
  "problem": "A complete but unterminated fragment is revived as a duplicate seq",
  "impact": "A short write ends just before the newline. The next writer's newline prefix turns the fragment into a valid seq-N line, then that writer appends its own seq N.",
  "suggested_fix": "Under the lock, truncate the segment to completeEnd, or count the fragment's seq in lastSeq.",
  "evidence": "src/bus/log.ts:259 at the round's head; A short write ends just before the newline. The next writer's newline prefix turns the fragment into a valid seq-N line, then that writer appends its own seq N.",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F3",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/lib/fs.ts",
  "line": 156,
  "problem": "The removeStaleLock check-then-rename race can remove a fresh live lock",
  "impact": "Two waiters both try to reclaim a dead holder's lock. The second renames away the first's new lock, and both write.",
  "suggested_fix": "After the rename, confirm the moved owner token is the one that was judged stale.",
  "evidence": "src/lib/fs.ts:156 at the round's head; Two waiters both try to reclaim a dead holder's lock. The second renames away the first's new lock, and both write.",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F4",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/bus/prune.ts",
  "line": 64,
  "problem": "lease-expired is duplicated when the lease file removal fails or the process crashes",
  "impact": "The process crashes between the append and afterAppend, and the next prune writes a second lease-expired.",
  "suggested_fix": "Delete the lease first, or check the log for an existing lease-expired with that leaseId, all under the lock.",
  "evidence": "src/bus/prune.ts:64 at the round's head; The process crashes between the append and afterAppend, and the next prune writes a second lease-expired.",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F5",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/commands/bus.ts",
  "line": 268,
  "problem": "Control characters in body, activity, branch and checkout reach the terminal",
  "impact": "A peer sends ESC sequences, and bus log and bus list print them raw.",
  "suggested_fix": "Strip C0/C1 control characters before display.",
  "evidence": "src/commands/bus.ts:268 at the round's head; A peer sends ESC sequences, and bus log and bus list print them raw.",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F6",
  "reviewer": "review-orchestrator",
  "severity": "info",
  "file": "src/bus/paths.ts",
  "line": 62,
  "problem": "Project-key slug collisions; send --json is missing from help and cli-reference",
  "impact": "The paths a/b and a-b share a bus.",
  "suggested_fix": "Document --json. The slug collision is accepted as a known limitation.",
  "evidence": "src/bus/paths.ts:62 at the round's head; The paths a/b and a-b share a bus.",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "N1",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/commands/bus.ts",
  "line": 271,
  "problem": "ts/expiresAt printed without displaySafe; lenient timestamp validation",
  "impact": "A peer-written ts carrying ESC would reach the terminal if the parser accepted it",
  "suggested_fix": "strict ISO-8601 UTC check plus displaySafe on timestamps",
  "evidence": "src/commands/bus.ts:271 at the round's head; A peer-written ts carrying ESC would reach the terminal if the parser accepted it",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "N2",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/lib/fs.ts",
  "line": 200,
  "problem": "Rename-back onto a third waiter's empty lock dir let that waiter's cleanup rm a live lock",
  "impact": "C has run mkdir but not written owner.json; B renames A's lock back; C's cleanup removes A's lock",
  "suggested_fix": "acquirer cleanup removes only its own empty/ownerless directory",
  "evidence": "src/lib/fs.ts:200 at the round's head; C has run mkdir but not written owner.json; B renames A's lock back; C's cleanup removes A's lock",
  "confidence": "high",
  "source": "internal"
 }
]
```
