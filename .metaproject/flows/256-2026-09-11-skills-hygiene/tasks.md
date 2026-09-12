# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Defect ids refer to `defect-map.md`; AC ids to `acceptance-criteria.md`.

| ID | Kind | Wave | Defect | AC | Title |
|----|------|------|--------|----|-------|
| T1 | context | - | all | - | Verify every defect in the current tree (done: defect-map.md) |
| T2 | implement | - | - | - | Scaffold row, superseded by T5-T17 (skipped) |
| T5 | implement | W1 | D1, D2 | AC1, AC3 | Delete retired review rules; clean review-orchestrator model_strategy and strict synthesis |
| T7 | implement | W1 | D3 | AC4 | Verification skills use keryx health/test run and a bound of 3 |
| T12 | implement | W1 | D7 | AC9 | Rendered core/platform skill descriptions read as triggers |
| T13 | implement | W1 | D8 | AC10 | Heading-only entrypoint body falls back instead of an empty mirror |
| T14 | implement | W1 | D9 | AC11 | One unhandled-rejection rule, one documentation layout, model choice via review tier |
| T16 | implement | W1 | D11 | AC13 | Stack labels on stack-specific rules and an honest rules README |
| T6 | implement | W2 | D1 | AC2 | Prune unmodified retired bundled rules from installations |
| T8 | implement | W2 | D4 | AC5 | One job context path, `<job>/ai/context.md` |
| T9 | implement | W2 | D5 | AC6 | Remove dead references in shipped skills and rules |
| T17 | implement | W2 | D12 | AC14 | Verifier describes what verify.ts checks; project-skill footer stops asserting status |
| T10 | implement | W3 | D5 | AC7 | xref resolves against the installed layout and sweeps rules |
| T11 | implement | W3 | D6 | AC8 | compatible_harnesses includes claude, categories match catalog, both checked |
| T15 | implement | W3 | D10 | AC12 | git-concurrency rule, wired into orchestrators, destructive-git patterns |
| T3 | test | W4 | - | AC15 | Full suite, typecheck, bundled verify, mirror identity |
| T4 | review | W4 | - | AC16 | review-orchestrator round over the branch diff |
