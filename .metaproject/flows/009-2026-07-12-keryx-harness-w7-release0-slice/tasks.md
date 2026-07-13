# Tasks — Flow 009 (W7 Release 0 slice)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W7** (implementation-plan.md §W7). Assembly of W4/W5/W6 — reuse, do
not rewrite. Offline/read-only/deterministic. No new dep/SDK/network/fs-mutation.
Worktree-guard in every worker.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Slice map + scenario→sub-slice coverage (context.md). |
| T2 | implement | — | Umbrella: implement per plan (closed when T6/T8/T10/T12/T14 done). |
| T3 | test | — | Umbrella: TDD tests (closed when RED tasks authored + impls green). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T15 + completion done). |
| T5 | test (S1 RED) | Sonnet | Startup/disabled-floor/offline/context-manifest tests. SC_R01/R02/R14. RED before T6. |
| T6 | impl (S1) | Opus | `src/harness/config.ts`/`startup.ts` + `context/manifest.ts`: disabled floor (byte-identical, no provider/socket), enabled preconditions, typed `environment_blocked`, bounded manifest+fingerprints, offline guarantee. GREEN. |
| T7 | test (S2 RED) | Sonnet | Append-only session / resume-no-dup / schema-migration tests. SC_R06. RED before T8. |
| T8 | impl (S2) | Opus | `src/harness/session/*`: append-only `session-manifest`/`session-entry`, currentLeaf, resume without duplicating evidence, deterministic migration. GREEN. |
| T9 | test (S3 RED) | Sonnet | Policy allow/ask/deny + hard-deny/headless-ask/stale-approval/role/transport-invariant + context-trust tests. SC_R05/R07/R08/R09. RED before T10. |
| T10 | impl (S3) | Opus | `src/harness/policy/*` (+ context-trust): deterministic engine over `policy-profile`→`harness-policy-decision`; fail-closed; role no-escalate; flow-file-edit denied; stale/untrusted context ≠ policy. GREEN. |
| T11 | test (S4 RED) | Sonnet | Completion-gate/evidence/redaction/metrics tests. SC_R10/R11. RED before T12. |
| T12 | impl (S4) | Opus | `src/harness/evidence/*` + `completion/*`: `completion-gate-result` (required evidence+gates, undisposed blocker, evidence-free reject), evidence records, redaction-before-persistence (preview+hash+category+provenance; scan-fail blocks), metric reliability. GREEN. |
| T13 | test (S5 RED) | Sonnet | Run-loop + tool-limits + budget/loop + CLI/JSONL-RPC parity + effect-free replay tests. SC_R04/R12/R13. RED before T14. |
| T14 | impl (S5) | Opus | `src/harness/run/*` + `cli.ts`/`rpc.ts` + `replay/*`: run loop over the fakes assembling the full flow; tool limits (timeout/overflow); budget/loop; CLI + JSONL/RPC (`rpc-jsonl-envelope`) semantic parity + transport-cannot-change-policy; offline effect-free replay (`replay-fixture`/`replay-mismatch`). GREEN. |
| T15 | review | Opus | code-verifier (`tsc` + full `bun test` ≥703 + new green); every `@task-R0-01/02/03` scenario has a covering test; boundaries (offline/no-fs/no-SDK/deterministic); `deps {}`; W4/W5/W6 reused not rewritten; frozen requirements pkg + src/eval + src/contracts + ADRs untouched. |
