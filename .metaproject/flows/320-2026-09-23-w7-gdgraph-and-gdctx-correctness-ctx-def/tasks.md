# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

These four are created by `keryx flow init` as a default checklist. Add your
own with `keryx flow task add`; a scaffold row your plan supersedes is closed
with `--disposition skipped --reason "<why>"`, not left open.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR (opus review/fix loop on the PR, CI green, merge) |
| T5 | implement | GDCTX-1: stream- and exit-code-aware error classification in ctx run (AC1) |
| T6 | implement | GDCTX-2: trust-aware image-URL redaction for trusted-project sources (AC2) |
| T7 | implement | GDCTX-3 bundled rg short flags + GIT_READONLY_ALLOW in the ctx hook (AC3, AC9) |
| T8 | test | gdgraph: freshness note on every query path + golden edge and staleness fixtures (AC4, AC5) |
| T9 | test | Correctness benchmark goldens in gdctx-fact-preservation.json, run by bun test (AC6) |
| T10 | test | Index gate: enforce 400-token budget on template and live index.md (AC8) |
| T11 | docs | Memory: four known-mistake entries for the closed defects (AC7) |
| T12 | verify | Targeted tests, typecheck and eslint on changed files (AC10) |
| T13 | verify | End-to-end CLI repro of GDCTX-1/2/3 and hook allowlist with the local build |
