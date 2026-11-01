# Integrated work candidate quality gate

Verified worktree: `/Users/Goodea/.codex/worktrees/hub-work-management/keryx`
Branch: `feat-hub-work-management`
HEAD at start: `11a776df1643d5127277f9c2f3909f76c962aacf`
Checks started: 2026-11-01T10:45:56Z; report finalized: 2026-11-01T10:49:41.657Z.

```yaml
VERIFICATION_RESULT:
  gate: FAIL
  scope: integrated candidate, including untracked work files and entire frontend
  checks:
    health_module:
      status: pass
      coverage: partial
      findings: 0
      note: optional oxlint/tests/dependencyAudit/SonarQube skipped; explicit checks below supplement scope
    lint:
      status: pass
      errors: 0
      warnings: 0
      scopes: [backend Hub/remote/CLI, entire apps/hub-web]
    type_check:
      status: pass
      errors: 0
      scopes: [root typecheck, root typecheck:scripts, entire apps/hub-web]
    backend_tests:
      status: fail
      passed: 1770
      failed: 1
      files: 158
      duration_seconds: 56.62
    frontend_tests:
      status: pass
      passed: 123
      failed: 0
      files: 28
      duration_seconds: 10.47
    testing_module:
      status: skipped_timeout
      exit_code: 143
      counts: unknown
      note: no output or normalized result after approximately 166 seconds; only this owned test process tree was terminated
    frontend_build:
      status: pass
      modules_transformed: 2227
    embedded_assets:
      status: fail
      reason: checked-in embedded frontend assets are stale
    circular_imports:
      status: skipped
      reason: madge is not a configured development dependency; nothing installed
  findings:
    - severity: CRITICAL
      check: backend_tests
      file: src/hub/work/http.test.ts
      line: 281
      message: Git capability reflects only repositories configured for the authorized project; expected false, received true.
      observed_at: 2026-11-01T10:46:54Z
      disposition: implementation changed concurrently; owner reports fix pending scoped rerun
    - severity: HIGH
      check: embedded_assets
      file: scripts/build-hub-web.ts
      line: 20
      message: Frontend assets are stale; packaging gate remains blocked until embedded assets are regenerated and checked.
    - severity: INFO
      check: testing_module
      message: Source testing module timed out without a normalized result; explicit directory tests completed and their failure remains reported.
```

## Commands and evidence

Every command below was invoked through the source CLI's context wrapper; the installed `keryx` binary was not used for code under review.

| Check | Exact command | Result |
|---|---|---|
| health | `bun --no-env-file src/cli.ts ctx run -- bun --no-env-file src/cli.ts health run --changed --source eslint,typescript` | PASS |
| testing | `bun --no-env-file src/cli.ts ctx run -- bun --no-env-file src/cli.ts test run --changed --strict` | TIMEOUT; exit 143 |
| backend-tests | `bun --no-env-file src/cli.ts ctx run -- bun test src/hub/ src/remote-control/ src/remote/ src/commands/hub-machine.test.ts src/cli-reference-coverage.test.ts src/standard/commands-by-task.test.ts src/standard/help-groups.test.ts` | FAIL; exit 1 |
| frontend-tests | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web test` | PASS |
| root-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck` | PASS |
| script-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck:scripts` | PASS |
| backend-lint | `bun --no-env-file src/cli.ts ctx run -- bun node_modules/eslint/bin/eslint.js src/hub src/remote-control src/remote src/commands/hub.ts src/commands/hub-machine.ts src/commands/hub-machine.test.ts` | PASS |
| frontend-types | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web typecheck` | PASS |
| frontend-lint | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web lint` | PASS |
| frontend-build | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web build` | PASS |
| embedded-assets | `bun --no-env-file src/cli.ts ctx run -- bun scripts/build-hub-web.ts --check` | FAIL; exit 1 |

Source status commands also ran: `bun --no-env-file src/cli.ts test status` reported `latest run: never`; `bun --no-env-file src/cli.ts health status` confirmed the 10:46:59Z PASS with partial coverage. The normalized health report is `.metaproject/data/health/artifacts/latest.md`. No normalized testing report was produced.

Raw logs are retained by gdctx:

- health: `.metaproject/data/gdctx/raw/2026-11-01T10-46-59-913Z-edcd5f_run.log`
- testing: `.metaproject/data/gdctx/raw/2026-11-01T10-48-43-547Z-731b14_run.log`
- backend-tests: `.metaproject/data/gdctx/raw/2026-11-01T10-46-54-559Z-726acb_run.log`
- frontend-tests: `.metaproject/data/gdctx/raw/2026-11-01T10-46-14-584Z-c4a943_run.log`
- root-types: `.metaproject/data/gdctx/raw/2026-11-01T10-46-57-246Z-38c48a_run.log`
- script-types: `.metaproject/data/gdctx/raw/2026-11-01T10-46-32-166Z-7d352a_run.log`
- backend-lint: `.metaproject/data/gdctx/raw/2026-11-01T10-46-32-184Z-155207_run.log`
- frontend-types: `.metaproject/data/gdctx/raw/2026-11-01T10-46-37-013Z-2d1805_run.log`
- frontend-lint: `.metaproject/data/gdctx/raw/2026-11-01T10-46-22-366Z-686e54_run.log`
- frontend-build: `.metaproject/data/gdctx/raw/2026-11-01T10-46-21-673Z-5da32d_run.log`
- embedded-assets: `.metaproject/data/gdctx/raw/2026-11-01T10-46-16-395Z-3e979b_run.log`

## Scope and limits

Explicit backend directory execution included all `src/hub/` files, including untracked `src/hub/work/`, legacy/server/store/MCP/connector regressions, all `src/remote-control/` and `src/remote/`, Hub machine CLI tests, and the CLI reference/help coverage tests. Explicit lint covered the same source directories and changed Hub launchers. Frontend scripts covered the entire `apps/hub-web` application, including its untracked managed-work implementation and tests. Root and scripts TypeScript checks ran independently.

The source health/testing modules were supplemented because changed-file discovery may omit untracked files. Health PASS alone is not the gate verdict. Full root-wide tests beyond the requested backend/CLI/remote scope were not run. No live vendor integration, deployment, credential inspection, browser journey, or screenshot review was performed.

This was an in-flight candidate, not a frozen final head. A 377-file scope manifest was captured at `output/work-quality-scope-start.json`; `output/work-quality-scope-end.json` recorded changes to `src/hub/work/http.ts` and `src/hub/work/http.test.ts` during checks. The failing capability test was newly introduced during this window. Further owner fixes and frontend increments require changed-scope reruns. The owner retains responsibility for final generated assets, final candidate verification, and acceptance.

No source files were edited by this verifier. Build output and normalized health/context reports were generated by the requested checks.

Routing audit: graph_used: not-relevant (execution-only verification, no dependency conclusions); wiki_used: previously read index, no architecture claims; ctx_used: source CLI run/read wrappers and normalized reports; raw_rg_used: no.

## Backend refresh after review fixes — 2026-11-01T10:58:01.249Z

This append supersedes the earlier backend test failure only. **Backend gate: PASS.** The earlier overall packaging failure is not cleared: frontend increment two and embedded asset regeneration remain owner work.

```yaml
VERIFICATION_RESULT:
  gate: PASS
  scope: backend refresh including all tracked and untracked src/hub work, remote and Hub CLI sources
  candidate:
    head_at_start: 11a776df1643d5127277f9c2f3909f76c962aacf
    head_at_finish: 239ba72298d2aeeeb1d7c119ea5332b0eda5fab0
    backend_manifest_files: 270
    backend_content_changes_during_checks: 0
  checks:
    source_health:
      status: pass
      findings: 0
      coverage: partial_optional_sources
      generated_at: 2026-11-01T10:57:01.210Z
    lint:
      status: pass
      errors: 0
      warnings: 0
    root_type_check:
      status: pass
      errors: 0
    scripts_type_check:
      status: pass
      errors: 0
    tests:
      status: pass
      passed: 1777
      failed: 0
      files: 158
      expectations: 20447
      duration_seconds: 43.47
    requirement_schema_docs:
      status: pass
      markdown_files: 13
      prd_requirements: 14
      acceptance_criteria: 16
      schemas: 3
      valid_examples: 11
      invalid_examples: 16
    testing_module:
      status: not_rerun
      reason: earlier discovery timeout retained; explicit complete relevant directory execution used instead, as requested
    circular_imports:
      status: skipped
      reason: madge not installed or configured; nothing installed
  findings: []
```

Commands were started at 10:56:14Z and all exited successfully. The previous project-scoped Git capability regression now passes in the complete backend suite. Exact immutable document fetch, new domain/runtime guards, observation metadata, CLI and MCP tests were included by directory, including untracked files.

| Check | Exact command | Evidence |
|---|---|---|
| refresh-health | `bun --no-env-file src/cli.ts ctx run -- bun --no-env-file src/cli.ts health run --changed --source eslint,typescript` | `.metaproject/data/gdctx/raw/2026-11-01T10-57-01-240Z-e2cccc_ru` |
| refresh-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T10-56-48-134Z-569954_ru` |
| refresh-script-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck:scripts` | `.metaproject/data/gdctx/raw/2026-11-01T10-56-22-979Z-1bde6d_ru` |
| refresh-lint | `bun --no-env-file src/cli.ts ctx run -- bun node_modules/eslint/bin/eslint.js src/hub src/remote-control src/remote src/commands/hub.ts src/commands/hub-machine.ts src/commands/hub-machine.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T10-56-20-676Z-3870d3_ru` |
| refresh-tests | `bun --no-env-file src/cli.ts ctx run -- bun test src/hub/ src/remote-control/ src/remote/ src/commands/hub-machine.test.ts src/cli-reference-coverage.test.ts src/standard/commands-by-task.test.ts src/standard/help-groups.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T10-56-59-273Z-cad48d_ru` |
| refresh-schema-docs | `bun --no-env-file src/cli.ts ctx run -- node docs/requirements/hub-work-management/verify.cjs` | `.metaproject/data/gdctx/raw/2026-11-01T10-56-15-897Z-f821f8_ru` |

The source health report was read after completion; required ESLint and TypeScript sources completed and parsed with zero findings. Optional oxlint, tests, dependency audit and SonarQube were skipped by that health invocation; direct tests, explicit lint and both TypeScript commands supplement its discovery scope.

Scope manifests: `output/work-quality-backend-start.json` and `output/work-quality-backend-end.json`. Root committed during checks, changing HEAD, but all 270 captured backend source/test files retained identical hashes. This is a source-content verification result, not a claim that the entire worktree or pending frontend increment was frozen.

No frontend checks, embedded asset generation, deployment, vendor calls, dependency installation, or source edits were performed in this refresh. Frontend first-patch 123/123 results remain historical evidence only; the pending second increment requires its own checks. The overall candidate is not packaging-ready until embedded assets are regenerated and verified.

Routing audit unchanged: source ctx used; graph not relevant to execution-only checks; no raw rg.
