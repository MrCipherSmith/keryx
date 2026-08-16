# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Confirm current touch points (agent.ts isActionRequest, session/store.ts forkSession, session/paths.ts, harness/mutation/approval.ts rule (h), harness/policy/engine.ts+profiles.ts, lib/serve-turn.ts, sac/index.ts authorizeSacUse, sac/proposal-lifecycle.ts review(), commands/harness.ts flags) against live code |
| T2 | implement | Anchors + open/close lifecycle (SLATE-2, SLATE-5): new lifecycle wiring module, agent.ts open-on-action-intent hook, shell.ts close triggers (/new, shell exit, flow-done), attemptId scheme, archive-before-reopen, fork-safety regression test |
| T5 | implement | Course + Seeds (SLATE-3 feature half, SLATE-4): live FwkWork Course projection helper (reuse fwk-service.ts try/catch), Seed append + exact-text dedupeSeeds() |
| T6 | implement | Unattended checkpoint interactive gate (SLATE-8, security-sensitive): wire interactive:boolean into authorizeSacUse/ProposalLifecycleService.review(), deny accept only, mirror checkApproval rule (h) |
| T7 | implement | --unattended boolean flag on `keryx harness run` (src/commands/harness.ts ParsedArgs/parseArgs) — mechanical parse-and-store, not a --profile selector |
| T3 | test | Cross-cutting AC evidence pass: direct tests proving AC1-AC6 against real code (fork empty slate, unclosed-reopen archive, serve-equivalent accept denial, interactive spoof-resistance, propose-still-succeeds) |
| T4 | review | code-verifier + review-orchestrator; remediate findings; prepare draft PR |
