# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan — superseded by T5–T9 |
| T3 | test | Full suite, typecheck and lint green after T5–T10 |
| T4 | review | Review through review-orchestrator and prepare the completion choice |
| T5 | implement | Entrypoint-target model: manifest normalizer, legacy-array migration decision, local-ignore library |
| T6 | implement | Index-block writers and block migration wired into init/update/rules sync/distill |
| T7 | implement | Ignore rules: check-ignore, `.git/info/exclude`, tracked `.gitignore` migration |
| T8 | implement | Claude hooks through `claudeSettings`; hook migration; never in both files |
| T9 | implement | Readers: standard validate/profiles, doctor, audit surfaces, worktree prune, preview |
| T10 | docs | Docs, skills, templates, index-block wording, CHANGELOG, version bump |
| T11 | verify | End-to-end acceptance against throwaway git repositories |

## Notes per task

Each implement task writes its failing tests first (`rules/core/tdd-workflow.mdc`) and
leaves the tests of its own scope green. Order is serial, T5 → T11, because T6–T9 edit the
same command files (`src/commands/init.ts`, `update.ts`, `rules.ts`).

- **T5** covers AC1 (read side) and the primitives behind AC6/AC7. New pure modules only.
- **T6** covers AC1 (write side), AC2 (block part), AC3, AC4, AC8–AC10 for `AGENTS.md`/`CLAUDE.md`.
- **T7** covers AC6, AC7, AC8 for `.gitignore`.
- **T8** covers AC5, AC8 for `.claude/settings.json`.
- **T9** covers AC11.
- **T10** covers AC12.
- **T11** is the check no unit test gives: the real CLI entry of this worktree, run with a
  throwaway directory as cwd, never against this repository's own `.metaproject/`.
- **T3** covers AC13.
