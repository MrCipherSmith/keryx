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
| T4 | review | Self-review and prepare draft PR (skipped: superseded by T18) |
| T5 | docs | Consolidate research into audit-report.md with target IA |
| T6 | verify | Owner approves the target IA (gate before public files change) |
| T7 | implement | Fix `keryx --help` and cli-reference drift; subcommand-level coverage test |
| T8 | docs | Site restructure: Diátaxis nav, landing page, llms.txt, pinned deps, Zensical trial job |
| T9 | docs | Area pages batch 1 (code-truth §2 areas 1-5) |
| T10 | docs | Area pages batch 2 (areas 6-10) |
| T11 | docs | Area pages batch 3 (areas 11-15, incl. Reference) |
| T12 | docs | Getting started tutorial and concept pages (architecture, security model, Metaproject) |
| T13 | docs | Built with Keryx and Project status pages |
| T14 | docs | Showcase README, README.ru.md, hero/OG assets |
| T15 | docs | Meta-files: ARCHITECTURE, SUPPORT, ROADMAP, docs issue template, package.json fields, docs/README map |
| T16 | verify | Run README quickstart and tutorial verbatim in a fresh dir; save transcript |
| T17 | verify | Strict build, link check, retired spellings, internal-id and external-name scan |
| T18 | review | review-orchestrator round over the final diff |

T2/T3 skipped: superseded by T5-T17 (tests live in T7; implementation is the docs tasks).
