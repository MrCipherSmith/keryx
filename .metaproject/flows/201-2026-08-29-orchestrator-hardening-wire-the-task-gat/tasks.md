# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Grouped by the four independent changes in `plan.md`. Every verification step is
a task rather than a sentence, because a check written only in prose blocks
nothing — which is the defect this flow exists to remove.

T1–T4 are the generic scaffold `flow init` created; T5–T19 carry the actual
work. T2 and T3 are umbrella entries and are closed only once their specific
counterparts are.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |

## Change 1 — the task gate (roadmap 0.1 + 0.2)

| ID | Kind | Title |
|----|------|-------|
| T5 | context | Baseline: record current `bun test` counts and the 34 affected historical flows |
| T6 | implement | Wire `taskGateStatus()` into `complete()` as a fifth gate, opt-in by schemaVersion |
| T7 | implement | Decide and implement the `skipped`-disposition rule; record the decision in journal.md |
| T8 | test | Test: open task fails `complete`; a pre-existing package is unaffected |
| T9 | docs | Remove the false task-gate claim from `flow-orchestrator/SKILL.md` in the same commit |

## Change 2 — round-trip-safe review record (roadmap 1.1)

| ID | Kind | Title |
|----|------|-------|
| T10 | implement | Structured findings array: `findings.json` conforming to `review-finding.schema.json` |
| T11 | implement | Consume the structured array; keep Markdown parsing for legacy reports only |
| T12 | test | Test: construct a round-2 `reviewer-input` from a round-1 artifact and validate it |
| T13 | test | Test: a legacy Markdown review report still parses without error |

## Change 3 — attempt counters and resume (roadmap 1.2 + 1.3)

| ID | Kind | Title |
|----|------|-------|
| T14 | implement | `keryx flow task attempt` CLI verb writing to the existing `attempts` field |
| T15 | test | Test: attempt count survives a simulated session restart |
| T16 | docs | Port `job-orchestrator` §0.0 State Resumption Check into `flow-orchestrator` Phase 0 |

## Change 4 — dead surface (roadmap 0.3)

| ID | Kind | Title |
|----|------|-------|
| T17 | implement | Delete `--greptile`, the frontend-conventions misroute, `FAILED`, the legacy-profile prompt |

## Gates

| ID | Kind | Title |
|----|------|-------|
| T18 | review | Verify both skill copies agree (`src/gdskills/bundled/` and `.metaproject/skills/gdskills/`) |
| T19 | review | Quality gate: typecheck, full suite against the T5 baseline, doc-links |
