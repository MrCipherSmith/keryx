# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: RS-01 resume/attempts — `src/harness/resume/` reconstructs the current session leaf from a persisted session + checkpoint using injected worktree/toolchain fingerprints; a stale result (fingerprint mismatch or new work) creates a NEW immutable attempt while prior attempts are preserved unchanged; accepted evidence is never duplicated across resume (reusing the W7 content-fingerprint dedup); an unchanged pending approval survives resume (SC_R05_APPROVAL_RESUME); prior evidence survives resume (SC_R11_EVIDENCE_SURVIVES_RESUME).
- AC2: transient-retry — a retryable provider error in the run loop records a NEW attempt within the run reservation (bounded), with prior attempts immutable and no duplicated evidence; this closes the W7-deferred `SC_R12_TRANSIENT_RETRY`.
- AC3: RS-02 recovery — the failpoint matrix passes: a crash cut BEFORE a side effect resumes safely (a new attempt, no double effect); a crash cut AFTER a side effect with an UNKNOWN outcome BLOCKS an unsafe retry until reconciliation via an `execution-receipt` (KNOWN outcome reconciles without duplicating evidence); a torn (truncated) last entry recovers to the last intact entry; a cancellation cut leaves a cancelled attempt that is resumable; isolated replay re-execution stays deferred (SC_R17_ISOLATED_REEXECUTE_DEFERRED). Durable payloads (checkpoint, execution-receipt, session-*) validate via `src/contracts`.
- AC4: Determinism / offline — all resume/recovery behavior is deterministic (clock, id, fingerprint, and failpoint are injected; no `Date.now`/`Math.random`/network); tests use an in-memory `SessionStore` fake and injected failpoints with NO real crash or filesystem write; reconciliation/replay is effect-free (no live provider/network/mutating tool).
- AC5: No regression / reuse / scope — `tsc --noEmit` is clean and the full `bun test` suite is ≥ the pre-change baseline of 797 pass with the new tests green and 0 fail; the W7 session/run, W5 ports, W6 fakes, and `src/contracts` validator are REUSED (not rewritten — any change to W7 `run.ts` is minimal/additive and noted); no new production dependency (`dependencies` `{}`), no provider SDK, no network; all new code lives under `src/harness/`; the frozen requirements package, `src/eval/`, `src/contracts/`, and ADR-0001…0004 are NOT modified.
