# Flow 271: review record for rounds r1–r4

PR: https://github.com/MrCipherSmith/keryx/pull/607. Final PR head: 86768cd5.
Reviewer: review-orchestrator, with domains logic, security, concurrency and testing.

| Round | Head | Result | Findings raised |
|---|---|---|---|
| r1 | pre-fix branch | approve with changes | F1 (major), F2–F7 (minor), F8–F9 (info) |
| r2 | dbc45cd3 | approve | N1, N2 (minor) |
| r3 | d3a8e839 | not clean | R3-1 (minor) |
| r4 (verify) | 1096d945 | not clean | R4-1 (minor) |

All earlier findings were refuted at the head of the following round.

The operator approved the fix for R4-1 as a narrow round beyond the three-round bound.

Fix commits:

| Findings | Commit |
|---|---|
| F1–F7, F9 | dbc45cd3 |
| F8 (documented) | dbc45cd3 |
| N1, N2 | 612eb1eb |
| R3-1 | ed63f567 |
| R4-1 | ee548bd2 |

```json keryx:findings
[
 {
  "id": "F1",
  "reviewer": "review-orchestrator",
  "severity": "major",
  "file": "src/session/lease.ts",
  "line": 259,
  "problem": "A holder that lost its lease is never told, and keeps writing the session",
  "impact": "A is SIGSTOPped, B runs -r X --take-over, A gets SIGCONT and keeps persisting to X, so there are two writers",
  "suggested_fix": "onLost from the heartbeat; stop persisting once the lease is lost",
  "evidence": "src/session/lease.ts:259 at the round's head; scenario: A is SIGSTOPped, B runs -r X --take-over, A gets SIGCONT and keeps persisting to X, so there are two writers",
  "confidence": "high",
  "source": "internal",
  "class_scope": {
   "sites": [
    "src/commands/shell.ts runShell save (readline chat and chat TUI)",
    "src/commands/shell.ts runShell /compact and onContextCompaction",
    "src/commands/shell.ts runAgentRepl turn save",
    "src/commands/shell.ts runAgentRepl auto-compaction and /compact",
    "src/tui/tui-shell.ts saveSession (debounced and turn-end)",
    "src/tui/tui-shell.ts auto-compaction and /compact",
    "slate writes via src/session/slate-lifecycle.ts entry points (ensureSlateOpened, writeSlateSession, recordSlateSessionTouch, closeSlateSession) reached from src/commands/agent.ts runAgentTurn and src/commands/goal-command.ts runGoalCommand",
    "raw-dir slate tools (appendSeed, workspace_create bind, spawn-subagent parent fold) via lease-gated getters"
   ],
   "enumeration_method": "keryx ctx rg over src/commands/shell.ts and src/tui/tui-shell.ts for persistHistory(, persistCompacted(, compactSession( call sites, plus every exported write entry point of src/session/slate-lifecycle.ts and its callers; later rounds N1, R3-1 and R4-1 found the slate members of this class and each was fixed at the slate layer"
  }
 },
 {
  "id": "F2",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/lib/fs.ts",
  "line": 440,
  "problem": "Check-then-act race in refresh/release can clobber or delete the new holder's lease",
  "impact": "A passes ownsIt() and stalls; B takes over; A resumes, then renames or rms over B's lease",
  "suggested_fix": "re-check inode and token immediately before the rename; release via rename-aside",
  "evidence": "src/lib/fs.ts:440 at the round's head; scenario: A passes ownsIt() and stalls; B takes over; A resumes, then renames or rms over B's lease",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F3",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/lib/fs.ts",
  "line": 380,
  "problem": "tryCreateLease failure cleanup removes whatever directory sits at lockPath",
  "impact": "a reclaimer's rename-back replaces C's empty directory; C's cleanup deletes A's lease",
  "suggested_fix": "remove only the directory's own inode, and only when it is empty",
  "evidence": "src/lib/fs.ts:380 at the round's head; scenario: a reclaimer's rename-back replaces C's empty directory; C's cleanup deletes A's lease",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F4",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/session/lease.ts",
  "line": 372,
  "problem": "openWith releases a pre-existing mine handle when openSession throws",
  "impact": "/resume of the current session with a corrupt transcript releases the current lease",
  "suggested_fix": "release only a handle this call minted",
  "evidence": "src/session/lease.ts:372 at the round's head; scenario: /resume of the current session with a corrupt transcript releases the current lease",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F5",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/session/lease.ts",
  "line": 97,
  "problem": "Test-only timing env vars are unclamped and weaken the take-over guard",
  "impact": "STALE_MS=1 lets --take-over seize a live shell",
  "suggested_fix": "test-gated and clamped",
  "evidence": "src/session/lease.ts:97 at the round's head; scenario: STALE_MS=1 lets --take-over seize a live shell",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F6",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/commands/sessions.ts",
  "line": 168,
  "problem": "sessions list crashes on one unreadable lease",
  "impact": "EACCES or ENOTDIR on one active.lease fails the whole listing",
  "suggested_fix": "try/catch that shows ?",
  "evidence": "src/commands/sessions.ts:168 at the round's head; scenario: EACCES or ENOTDIR on one active.lease fails the whole listing",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F7",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/commands/shell-lease.process.test.ts",
  "line": 260,
  "problem": "600ms staleMs flakes on a loaded runner",
  "impact": "the taker misses its heartbeats and reads stale",
  "suggested_fix": "default timing for the live-refusal step",
  "evidence": "src/commands/shell-lease.process.test.ts:260 at the round's head; scenario: the taker misses its heartbeats and reads stale",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F8",
  "reviewer": "review-orchestrator",
  "severity": "info",
  "file": "src/lib/fs.ts",
  "line": 301,
  "problem": "Cross-host clock skew misjudges liveness",
  "impact": "a skewed remote holder is misjudged",
  "suggested_fix": "document the limit",
  "evidence": "src/lib/fs.ts:301 at the round's head; scenario: a skewed remote holder is misjudged",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F9",
  "reviewer": "review-orchestrator",
  "severity": "info",
  "file": "src/cli.ts",
  "line": 323,
  "problem": "Foreign errors carrying exitCode now set keryx's exit code",
  "impact": "a ShellError propagates the child's exit code",
  "suggested_fix": "honour exitCode only for ShellFlagError",
  "evidence": "src/cli.ts:323 at the round's head; scenario: a ShellError propagates the child's exit code",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "N1",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/commands/shell.ts",
  "line": 3290,
  "problem": "Slate tool writes are not gated by canPersist until the loss is noticed",
  "impact": "after a take-over, slate tools write for up to one heartbeat",
  "suggested_fix": "gate the slate getters by canPersist",
  "evidence": "src/commands/shell.ts:3290 at the round's head; scenario: after a take-over, slate tools write for up to one heartbeat",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "N2",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/lib/fs.ts",
  "line": 525,
  "problem": "A transient owner.json read failure marks the lease permanently lost",
  "impact": "EMFILE makes holds() return false and the shell stops saving",
  "suggested_fix": "unreadable counts as unknown, not lost",
  "evidence": "src/lib/fs.ts:525 at the round's head; scenario: EMFILE makes holds() return false and the shell stops saving",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "R3-1",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/commands/agent.ts",
  "line": 2487,
  "problem": "A running turn or /goal loop keeps writing the taken-over session's slate",
  "impact": "the turn or goal loop captured the SlateSessionRef before the loss",
  "suggested_fix": "detach the SlateSessionRef and refuse writes in the slate layer",
  "evidence": "src/commands/agent.ts:2487 at the round's head; scenario: the turn or goal loop captured the SlateSessionRef before the loss",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "R4-1",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/commands/goal-command.ts",
  "line": 899,
  "problem": "/goal --auto post-verifier extra round skips the detach check",
  "impact": "the lease is lost during the verifier; one more full turn runs in the taken-over session",
  "suggested_fix": "re-check detach after runGoalVerifier",
  "evidence": "src/commands/goal-command.ts:899 at the round's head; scenario: the lease is lost during the verifier; one more full turn runs in the taken-over session",
  "confidence": "high",
  "source": "internal"
 }
]
```
