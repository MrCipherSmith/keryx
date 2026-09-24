# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

These four are created by `keryx flow init` as a default checklist. Add your
own with `keryx flow task add`; a scaffold row your plan supersedes is closed
with `--disposition skipped --reason "<why>"`, not left open.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context (orchestrator: context.md, plan.md, ACs) |
| T2 | implement | Implement per plan: `src/integrations/` registry, SettingsFileOwner, the three modules as registry views, installers routed through the owner, ZONE_TABLE entry (AC1-AC4, AC6, AC7) |
| T3 | test | New tests: registry shape/coverage/derived-view parity/coherence invariant; the Wave-0 coexistence guard over every SettingsFileOwner with negative controls (AC1-AC5) |
| T4 | review | Adversarial review (opus) of the diff before the PR; findings become fix tasks |
| T5 | test | Verify: targeted tests of every touched module, typecheck, eslint on changed files, import-policy tests (AC6, AC8) |
| T6 | test | Verify: end-to-end CLI install/uninstall of ctx guard, security hooks and orient in both orders in a temp project with `bun ./src/cli.ts` (AC5, AC8) |
| T7 | docs | Docs: architecture note for `src/integrations` and a W5 status pointer |
| T8 | review | PR review/fix loop, CI green, merge into feat/agent-platform-expansion (AC8) |
