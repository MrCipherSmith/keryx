# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

AC ids refer to `acceptance-criteria.md`; context to `context-map.md` (read the
"Re-verification 2026-09-12" section first).

Lanes: `bundled-eval.ts` is edited by one task at a time (T7 → T8 → T9 → T11 →
T16); skill-content tasks run in parallel on disjoint files.

| ID | Kind | Depends | AC | Title |
|----|------|---------|----|-------|
| T1 | context | - | - | Context collected and re-verified (done) |
| T2 | implement | - | - | Scaffold row, superseded by T5-T17 (skipped) |
| T5 | implement | T1 | AC8 | Delete `SKILL.<runtime>.md` copies identical to `SKILL.md`; export/install/tests treat the fallback as normal |
| T6 | implement | T5 | AC1 | One description and one trigger list per skill; catalog equals `SKILL.md` frontmatter; no purpose fallback |
| T7 | implement | T6 | AC2 | `description:*` checks in bundled-eval with fixtures |
| T8 | implement | T7 | AC3 | `anatomy:sections` check with a reason-carrying exemption map |
| T9 | implement | T8 | AC4 | `anatomy:length` check, per-skill ceiling file, ratchet rule |
| T10 | test | T6 | AC5 | Routing corpus for every skill, pairwise negatives, rank-1 baseline |
| T11 | implement | T9 | AC6 | `description:collision` check on the scorer's tokenisation |
| T12 | implement | T10, T11 | AC7 | Resolve the routing collisions the corpus names |
| T13 | implement | T6, T8 | AC9 | Red Flags + Verification backfill — quality skills |
| T14 | implement | T6, T8 | AC9 | Red Flags + Verification backfill — platform, planning, orchestration skills |
| T15 | implement | T6, T8 | AC9 | Red Flags + Verification backfill — review skills |
| T16 | implement | T11, T13, T14 | AC10 | Carry-overs: xref over `orchestrator-prompt.md`, `parseSkillFrontmatter`, trailing period, `npx tsc` |
| T17 | docs | T1 | AC11 | Rejected-change ledger and the rule that requires it |
| T3 | test | T5-T17 | AC12 | Full suite, typecheck, eslint, bundled verify, mirror identity |
| T4 | review | T3 | AC13 | Review rounds to a clean gate |
