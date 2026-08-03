# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | implement | Extract configDir into src/lib/config-dir.ts and repoint both existing copies |
| T6 | implement | CLI wiring (src/commands/serve.ts + cli.ts) and command-registry verb classification |
| T7 | test | Mutation-check every guard and record what went red |
| T8 | review | Verification gates: tsc --noEmit, full bun test, keryx health run |

## Definitions

**T1 — context.** Read the requirements package
(`docs/requirements/keryx-remote-entry/`: README, specification, api-protocol,
security-policy, `schemas/remote-entry-config.schema.json`), the R4a code
(`src/lib/project-registry.ts`, `src/commands/projects.ts`,
`src/lib/shell-config.ts`), the dispatch table (`src/cli.ts`), the coverage guard
(`src/standard/command-registry.coverage.test.ts`) and the flow-127 lesson in
`.metaproject/memory/lessons/`. Record findings in `context.md`.

**T5 — extract `configDir`.** One resolver in `src/lib/config-dir.ts`;
`shell-config.ts` and `project-registry.ts` import it. Their existing test suites
must pass unedited — that is the regression proof, not a claim.

**T3 — tests first.** `serve-config.test.ts`, `serve-credential.test.ts`,
`serve-server.test.ts`, `serve.cli.test.ts`, `serve.escape.test.ts`. Each is
written before the code it tests and confirmed failing for the stated reason.
Every listener test binds `port: 0`; every exit-code assertion reads a real
subprocess.

**T2 — implement.** `src/lib/serve-config.ts`, `src/lib/serve-credential.ts`,
`src/lib/serve-server.ts` per `plan.md`.

**T6 — CLI.** `src/commands/serve.ts` (`serve`, `serve status`,
`serve token issue|revoke|rotate`, `serve config init|show`), wired into
`CLI_ROUTES` and the help text; `serve` added to `EXCLUSIONS` in
`src/standard/command-registry.coverage.test.ts` with its reason.

**T7 — mutation-check.** For each guard: remove or invert it, confirm the suite
goes red and record which test failed, restore. Guards in scope: the constant-time
comparison, the auth-before-routing order, the loopback classification, the
non-loopback acknowledgement, the config whitelist projection, the
no-token-in-output scan, the port release on drain, and the coverage exclusion.

**T8 — gates.** `tsc --noEmit`, the full `bun test` suite, `keryx health run`, the
command-registry coverage guard, then the project-local reviewers at
`.metaproject/skills/gdskills/review/` including security and logic.

**T4 — review and draft PR.** Consolidate findings, fix, re-verify, open a draft
PR against `main` in the author's name.
