# Quality: health and testing

The quality commands gather lint, type, test, dependency and complexity signals into one health report with a pass, warn or fail gate, find the tests that matter for a change, and record what each agent run did. They remove the guesswork from "is this branch healthy, and which tests prove it?" without running the whole suite every time.

## When to use it

- You want one gate result, with named sources, before a push or before a flow can complete.
- You changed one file and want the tests related to it, not the whole suite.
- You want a pre-push check that runs only the tests for the changed files.
- You want to see which quality tools Keryx found in the project, and which are missing.
- You want per-run records of what an agent did, to compare two runs or build a paired benchmark.

## Quick example

Run this in a small project with a test file, after `keryx init --yes`.

```bash
keryx gdgraph build
keryx test analyze
keryx test related src/math.ts
keryx test run --changed
keryx health sources
keryx health run
```

```text
# related tests: src/math.ts

context: complete

- src/math.test.ts

command: bun run test src/math.test.ts
passed: 1
failed: 0
selected tests: 1

# health sources

- eslint: skipped (mode auto, required)
- typescript: skipped (mode auto, required)
- tests: skipped (mode auto, optional)
- dependencyAudit: available (mode auto, optional)
…

# Code Health: INCOMPLETE

project score: 100 (trend: unknown)
findings: 0

- INCOMPLETE: required source unavailable: eslint
- INCOMPLETE: required source unavailable: typescript
…
```

The project in this example has no ESLint or TypeScript setup, so the gate reports `INCOMPLETE` and says which required source is missing instead of passing silently.

## How it works

**Health.** `keryx health run` runs each source it detects (ESLint, TypeScript, tests, dependency audit, SonarQube, plus built-in complexity, coverage and churn), writes `latest.json` and `latest.md` under `.metaproject/data/health/`, and prints the gate and a score per scope. `health sources` lists what is available without running anything. `health gate` re-reads the last report, and exits `1` on fail (on warn too with `--strict-warn`). `health baseline update` records current scores so later runs report regressions, and `health trend` prints a scope's score history. `health explain <file-or-module>` shows a scope's metrics and its first findings. A required source that cannot run makes the gate `INCOMPLETE`, which is neither a pass nor a fail. Flow completion calls the same gate, see [Managed work](managed-work.md).

**Related tests.** `keryx test analyze` detects the test stack and writes a context under `.metaproject/data/testing/`. `test related <file>` lists tests related to a source file by naming and directory heuristics. `test run --changed` selects tests for changed files through `git`, and with `--strict` a run with no matching tests fails, which is what the pre-push gate uses. `test explain <file-or-scope>` shows the frameworks, related tests and latest failures for a target. `test suggest <file>` proposes a test plan and needs a model credential.

**Coverage map.** The opt-in test-impact capability (`keryx init --testing-tia`) builds a map from source files to the tests that cover them with `keryx test coverage-map build`. When a fresh map exists, `run --changed` uses it to pick exactly the covering tests. A missing or stale map falls back to the naming heuristics, and `coverage-map status` says which applies.

**Metrics.** `keryx metrics` keeps provenance-aware run records: `collect` folds an events file into a record, `latest` and `show <run-id>` print one, `compare <run-a> <run-b>` diffs two, and `benchmark init` and `validate` set up a paired comparison manifest. No performance claim has been made about Keryx. The benchmark harness exists so a comparison can be run and reported honestly.

## Common tasks

| I want to… | Command or page |
|---|---|
| Run the full health pipeline | `keryx health run` |
| See which sources are available | `keryx health sources` |
| Re-check the last gate result | `keryx health gate [--strict-warn]` |
| Only check what I changed | `keryx health run --changed --since <ref>` |
| Record today's scores as the baseline | `keryx health baseline update` |
| Find the tests for a file | `keryx test related <file>` |
| Run only the tests for my changes | `keryx test run --changed` |
| Enable precise test selection | `keryx init --testing-tia`, then `keryx test coverage-map build` |
| Print the latest test report | `keryx test report latest` |
| Compare two agent runs | `keryx metrics compare <run-a> <run-b>` |

## Status

Health gate and test selection are stable and on by default. The coverage map is opt-in. `metrics` is available for run records and benchmarks, with no published performance claim. Test and health behaviour that reaches a model (`health explain --narrate`, `test suggest`) needs a credential and exits `1` without one.

## Reference

- CLI reference: [health](../cli-reference.md#health), [test](../cli-reference.md#test), [metrics](../cli-reference.md#metrics)
- [Managed work](managed-work.md): the health gate as a completion gate
- [Run Keryx in CI](../guides/run-in-ci.md)
- [Module reference](../modules.md)
