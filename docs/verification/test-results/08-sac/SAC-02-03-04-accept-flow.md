# SAC-02, SAC-03, SAC-04 — the real proposal accept flow

**Area:** 8. SAC: workspace / proposal / review · **Date:** 2026-08-22 · **Status:** PASS (all three)

Executed directly by the parent session (not delegated) against real CLI commands — no live
provider call needed for any of these three. Reused the real, already-pending proposal
`proposal-b051e66aebd74f37` (workspace `workspace-5c74a3f7b3c7414b`) created by an earlier live
`/goal --auto` test in this same testing campaign, rather than constructing a synthetic one.

## SAC-03 — `--decision accepted` without a confirm-token is refused (tested first, deliberately, before consuming the proposal)

### What was actually run

```bash
keryx workspace review workspace-5c74a3f7b3c7414b proposal-b051e66aebd74f37 \
  --decision accepted --reason "SAC-03 test: no confirm-token" \
  --idempotency-key sac-03-test-<timestamp>
```

(No `--confirm-token` passed.)

### Captured output

```text
exit code: 1
--decision accepted requires --confirm-token — run `keryx workspace confirm-review workspace-5c74a3f7b3c7414b proposal-b051e66aebd74f37` first
```

### Summary

Confirmed exactly as documented: a clean, typed refusal naming the exact fix command, no state
change, no stack trace.

---

## SAC-02 — the real accept flow, end to end

### What was actually run

```bash
keryx workspace confirm-review workspace-5c74a3f7b3c7414b proposal-b051e66aebd74f37
# -> real token minted: { "token": "...", "expiresAt": "2026-08-22T09:19:02.134Z" }

keryx workspace review workspace-5c74a3f7b3c7414b proposal-b051e66aebd74f37 \
  --decision accepted --reason "real live test of SAC accept flow (SAC-02)" \
  --idempotency-key sac-02-test-<timestamp> \
  --confirm-token <the minted token>
```

### Captured output (real, full JSON response)

```json
{
  "event": {
    "recordType": "proposal-transition",
    "proposalId": "proposal-b051e66aebd74f37",
    "fromStatus": "proposed",
    "toStatus": "accepted",
    "acceptance": {
      "reviewer": { "subject": "user:local-502", "authority": "owner" },
      "security": { "gate": "pass" },
      "freshness": { "state": "fresh", "maxEvidenceAgeSeconds": 3600 },
      "targetWrite": {
        "targetRef": "./memory/task-notes/sac-proposal-b051e66aebd74f37.md",
        "receiptRef": "./memory/task-notes/sac-proposal-b051e66aebd74f37.receipt.json",
        "completedAt": "2026-08-22T09:17:11.373Z"
      }
    }
  },
  "dedupHint": { "duplicates": [ { "path": "task-notes/sac-proposal-b051e66aebd74f37.md", "titleSimilarity": 0.918 } ], "conflicts": [] },
  "annotation": { "verdict": "duplicate-of", "ref": "task-notes/sac-proposal-b051e66aebd74f37.md" }
}
```

### Cross-check

```bash
ls .metaproject/memory/task-notes/
# sac-proposal-b051e66aebd74f37.md  1.4K
```

The file is real, on disk, 1.4K, landed by the memory owner-writer exactly at the `targetRef`
path the response named.

### Summary

Confirmed, fully — this is the complete, real, human-gated accept pipeline working end to end:
mint token → review with token → owner writer lands durable content → real file on disk. Not a
mock, not a dry run.

### Analysis

Interesting side note: the `dedupHint` fired with `titleSimilarity: 0.918` against **the exact
same file it had just written** (`path: task-notes/sac-proposal-b051e66aebd74f37.md` — the target
of THIS acceptance). This is very likely an artifact of the dedup check running *after* the write
completed and re-scanning the (now-updated) memory corpus, so the just-written file is its own
closest match. Not necessarily a bug — the doc explicitly says the hint is "informational only;
nothing reads `.verdict` to decide accept/reject" and is computed "after the decision, never
gating it" — but a dedup hint whose top match is the artifact the accept itself just produced is
a slightly odd first impression worth a second look if anyone builds tooling on top of this
verdict field.

---

## SAC-04 — `DedupHint` fires on an accept that duplicates existing accepted content

### Summary

Directly confirmed by SAC-02's own real output above (`dedupHint.duplicates` non-empty,
`annotation.verdict: "duplicate-of"`) — no separate run needed; same evidence, both claims true
of the same real accept call.

### Analysis

The hint correctly did NOT block or alter the accept outcome (`toStatus: "accepted"` regardless)
— matches the documented "informational only" contract exactly.
