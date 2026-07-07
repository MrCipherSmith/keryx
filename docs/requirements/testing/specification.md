# Testing Module technical specification

Version: 0.2.1
Status: implemented (MVP)

## 1. Purpose

Testing Module is the Metaproject owner of test context, test execution
reporting, and changed-scope test selection. It produces stable agent-readable
Markdown and machine-readable JSON artifacts for agents, Code Health, gdskills
and future memory workflows.

## 2. Design Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | MVP focus | Testing Context first, with architecture for Test Intelligence. |
| D2 | Storage | Hybrid: `skills/testing/SKILL.md`, `data/testing/*`, and optional `wiki/testing/*`. |
| D3 | Missing tests | Do not change project code; write recommendations. |
| D4 | Hooks | Ask separately for non-mutating post-commit stale-context reminder and pre-push gate. |
| D5 | Changed selection | Runner related mode -> gdgraph -> naming convention fallback. |
| D6 | Report contract | JSON source of truth + Markdown summary + optional raw log. |
| D7 | Health integration | Testing owns execution/reporting; Code Health imports normalized result. |

## 3. Placement

When enabled, `gd-metapro init` creates:

```text
.metaproject/
  testing.config.json
  core/
    testing/
      README.md
  data/
    testing/
      context.md
      context.json
      recommendations.md
      artifacts/
        latest.md
        latest.json
      history/
      logs/
        latest.raw.log
  skills/
    testing/
      SKILL.md
  wiki/
    testing/
      README.md
      conventions.md
  modules/
    testing.md
```

`wiki/testing/*` is created only when gdwiki is enabled.

## 4. Configuration

Config lives in `.metaproject/testing.config.json`.

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "runner": "auto",
  "changedSelection": {
    "strategies": ["runner", "gdgraph", "naming"],
    "fallbackWhenEmpty": "warn"
  },
  "hooks": {
    "postCommitRefresh": false,
    "prePushGate": false
  },
  "artifacts": {
    "keepRawLogs": true,
    "historyLimit": 50
  }
}
```

## 5. CLI

```bash
gd-metapro test init
gd-metapro test analyze
gd-metapro test run [--changed] [--strict] [--since <ref>] [--scope <path>] [--kind unit|integration|e2e|smoke]
gd-metapro test status
gd-metapro test context
gd-metapro test explain <file-or-scope>
gd-metapro test related <file>
gd-metapro test report latest [--json]
```

### 5.1 `test init`

Creates module structure and runs `test analyze`.

### 5.2 `test analyze`

Detects and writes testing context without running tests.

Detection inputs:

- `package.json` scripts;
- dependencies/devDependencies;
- configs: `bunfig.toml`, `vitest.config.*`, `jest.config.*`,
  `playwright.config.*`, `cypress.config.*`, `tsconfig.*`;
- test files: `*.test.*`, `*.spec.*`, `__tests__`, `e2e`, `tests`;
- CI: `.github/workflows/*`, `.gitlab-ci.yml`;
- instructions: `AGENTS.md`, `CLAUDE.md`, `.metaproject/rules/*`,
  `.metaproject/wiki/*`, `docs/*`.

### 5.3 `test run`

Runs detected test command and writes normalized artifacts. `--since <ref>`
selects changed files against a git ref; `--gate` is an alias of `--strict`.

Runner priority:

1. Bun when `bun.lockb` or `bun:test`/`bun test` is detected.
2. Package script `test`.
3. Vitest/Jest/Playwright scripts when requested by `--kind`.
4. No run when no command is available; write skipped report and recommendations.

### 5.4 `test related`

Finds likely tests for a file:

1. runner related mode when supported;
2. gdgraph dependents/importers/test nodes;
3. naming convention fallback.

MVP may implement naming fallback first and record `gdgraph: unavailable` when
graph query support is not sufficient yet.

## 6. JSON Report Schema

`.metaproject/data/testing/artifacts/latest.json`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-07T00:00:00.000Z",
  "gitRef": "abc1234",
  "status": "pass",
  "scope": "project",
  "runner": "bun",
  "command": "bun test",
  "exitCode": 0,
  "durationMs": 1200,
  "counts": {
    "passed": 10,
    "failed": 0,
    "skipped": 0,
    "total": 10
  },
  "selection": {
    "changed": false,
    "strategies": ["runner", "gdgraph", "naming"],
    "selectedTests": [],
    "changedFiles": [],
    "fallback": "none"
  },
  "failures": [],
  "relatedFiles": [],
  "relatedSkills": [],
  "rawLogPath": ".metaproject/data/testing/logs/latest.raw.log"
}
```

Status values: `pass`, `fail`, `error`, `skipped`.

Changed-scope reports include `gitRef`; Code Health imports a report only when
the report scope and git ref are compatible with the current health run.
`--strict` turns empty changed-scope selection into a failing gate result, which
is what the pre-push hook uses.

## 7. Markdown Report

`.metaproject/data/testing/artifacts/latest.md` must include:

- status, scope, runner and command;
- counts and duration;
- priority failures;
- selected tests for changed-scope runs;
- next suggested command;
- links to raw log and context.

## 8. Context Schema

`.metaproject/data/testing/context.json`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-07T00:00:00.000Z",
  "frameworks": ["bun"],
  "scripts": [{ "name": "test", "command": "bun test" }],
  "configs": ["tsconfig.json"],
  "testFiles": ["src/example.test.ts"],
  "ciFiles": [".github/workflows/ci.yml"],
  "conventions": ["Use bun:test"],
  "recommendations": []
}
```

## 9. Agent Skill

`.metaproject/skills/testing/SKILL.md` instructs agents to:

- read testing context before creating or changing tests;
- use `gd-metapro test related <file>` before broad test search;
- use `gd-metapro test run --changed` for focused verification;
- read `latest.md` before raw logs;
- send repeated failures to `gd-metapro skills learn --from-test`.

## 10. Hook Behavior

Post-commit reminder:

```bash
gd-metapro test analyze
```

- non-blocking;
- only reports when source/test/config/docs files changed;
- does not write context/report metadata after commit, because post-commit mutation leaves the worktree dirty;
- user or orchestrator runs the explicit command when fresh testing context is needed.

Pre-push gate:

```bash
gd-metapro test run --changed
```

- blocking;
- fails push on failed changed-scope tests;
- fallback when no related tests found is controlled by config.

## 11. Code Health Integration

Health `tests` source should:

1. import `.metaproject/data/testing/artifacts/latest.json` when present;
2. convert failed tests into P0 health findings;
3. record provenance from Testing Module;
4. run legacy `bun test` only when no testing report is present and fallback mode allows it.

## 12. MVP Acceptance Criteria

- `gd-metapro init` can enable Testing Module.
- `gd-metapro test analyze` writes context artifacts.
- `gd-metapro test run` writes latest JSON/Markdown/raw log artifacts.
- `gd-metapro test status/context/report/explain/related` work without network.
- `.metaproject/index.md` references Testing Module when enabled.
- Code Health spec identifies Testing as execution/reporting owner.
