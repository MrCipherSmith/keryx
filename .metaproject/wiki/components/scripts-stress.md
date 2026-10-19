---
Title: Module scripts/stress
Version: 1.0.0
Type: component
Status: accepted
Summary: "`scripts/stress` holds executable stress and boundary probes for the agent shell, sub-agent and concurrent test paths. The shell probes drive production agent code with a scripted provider, and the concurrent harness runs parallel `bun test` suites; both report findings rather than runtime behaviour."
---
# Module scripts/stress

## Summary

`scripts/stress` holds executable stress and boundary probes for the agent shell, sub-agent and concurrent test paths. `keryx-shell-stress.ts` runs the real agent turn loop with a scripted model and records findings per probe. `concurrent-suite-stress.ts` runs several `bun test` suites at once and reports which tests fail under contention.

## Overview

The module measures how the agent harness behaves under repeated and concurrent load, instead of assuming it. It owns the probe scenarios and their reporting: each probe yields a `Finding` with a verdict (`PASS`, `FAIL`, `RISK`, `INFO` or `SKIP`), and the shell harness writes the full set as JSON under `.metaproject/data/stress`. Nothing in this directory is imported by runtime code; the files are run directly or through the offline test.

## How it works

The shell harness, `keryx-shell-stress.ts`, is built around one substitution. `scriptedProvider` replays fixed rounds of `NormalizedEvent`s through the `ProviderPort` interface, and `callRound` shapes a round of parallel tool calls. `runTurn` wires an `AgentIO` that captures tool calls, results, approvals and system messages, plus an `AgentDeps` carrying the provider, tool list and id sequence, then calls `runAgentTurn`. The model is the only fake; tools, the approval gate and the spawn path are the production ones. `spawnToolWith` does the same for `createSpawnSubagentTool`, swapping in a scripted child provider or a `hangingProvider` that never settles.

Probes are plain async functions (`P1` through `L3`), grouped by suite letter (permission, injection, concurrency, multi-agent, sandbox, longevity). They are registered in the `SUITE` map and filtered by `selected`, which honours `--only` and `--skip` on either the full id or the suite letter. Each probe calls `record`, which appends to `findings` and prints one line. An exception inside a probe becomes a `FAIL` finding for that probe, so one broken probe does not stop the run.

The harness keeps itself safe. Fixtures live in a `mkdtempSync` root that is removed at exit. Destructive commands such as `rm -rf /` are never handed to the runner; the probe only checks that the gate refuses them. Egress probes run only with `--allow-egress`.

`concurrent-suite-stress.ts` has no internal imports. It starts `bun test` processes with `Bun.spawn`, `--runs` of them at a time per wave and `--repeat` waves in total. `summarize` parses the pass, fail and skip tallies and the `(fail)` lines from each transcript. `retainFailingTranscripts` writes the transcript of any failing run to `.tmp-stress-logs`, and `reportWave` aggregates failing test names and error lines across the wave. The process exits 1 if any failure occurred.

`keryx-shell-stress.test.ts` checks the shell harness's contract rather than its probes. It runs the harness with `--only __offline_report_only__`, sets `KERYX_AGENT_MAX_ROUNDS=7`, and asserts that the JSON report records `maxRounds: 7` and no findings.

## Key concepts

- **Scripted provider** — A fake `ProviderPort` that replays fixed event rounds, so the agent loop runs without a live model and without non-determinism.
- **Finding and verdict** — One probe result: `PASS` (behaviour held), `FAIL` (an assertion broke), `RISK` (a hazard was observed, such as no timeout on `shell_exec`), `INFO` (an observation with no judgement), or `SKIP` (a prerequisite such as the `docker` binary is absent).
- **Permission gate** — The approval path in `runAgentTurn`. With no `requestApproval` the probes expect a "not approved" error, which is the default-deny behaviour.
- **Remembered shell pattern** — An "always allow" grant checked by `isShellCommandAllowed`, `suggestShellPatterns` and `matchShellPattern`. The P-suite probes check that a remembered prefix does not cover chained or destructive commands.
- **Caps and budgets** — `MAX_ATTEMPTS_PER_HASH`, `DEFAULT_MAX_ROUNDS`, `DEFAULT_MAX_CHILDREN`, and the per-call `max_tool_calls` and `max_rounds` on `spawn_subagent`. The M and T probes check that these bound runaway work.
- **Wave** — One batch of concurrent `bun test` processes in `concurrent-suite-stress.ts`, reported together.

## Main flows

### Run the shell stress suite

1. A developer runs `bun scripts/stress/keryx-shell-stress.ts`, optionally with `--only`, `--skip`, `--big-file-mb` or `--allow-egress`.
2. `main` prints the sandbox mode, round cap and platform, then calls `makeFixtures`.
3. Each selected probe in `SUITE` runs a real turn through `runTurn` or a spawn through `spawnToolWith`, and `record` logs its verdict.
4. `main` writes `stress-<timestamp>.json` to `OUT_DIR`, prints the verdict counts, deletes the fixture root and exits 0.

### Probe the sub-agent path

1. The M and T probes call `spawnToolWith`, which builds a `createSpawnSubagentTool` bound to a scripted child.
2. `M4a` runs a child that loops on `read_file` and expects `BudgetExhausted` from its tool-call cap.
3. `M4b` races a child whose provider never responds against a 4-second window. A `RISK` verdict means only that no result arrived inside that window; the probe does not confirm whether the longer configured deadline is enforced.

### Measure concurrent test suites

1. A developer runs `bun scripts/stress/concurrent-suite-stress.ts --runs 6 --repeat 2 --filter <path>`.
2. For each wave, `runOnce` starts the `bun test` processes in parallel and collects their stdout and stderr.
3. `retainFailingTranscripts` saves failing transcripts; `reportWave` prints the per-run table, the failing tests with the number of runs they failed in, and an excerpt of each failure.
4. The process exits 0 only when every wave reports zero failures.

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Key files

- `scripts/stress/keryx-shell-stress.ts` - imported by 0, imports 9
- `scripts/stress/concurrent-suite-stress.ts` - imported by 0, imports 0
- `scripts/stress/keryx-shell-stress.test.ts` - imported by 0, imports 0

### Depends on

- `src/harness/tool/builtin` - 4 import(s)
- `src/commands` - 1 import(s)
- `src/harness/child` - 1 import(s)
- `src/harness/process/sandbox` - 1 import(s)
- `src/harness/provider` - 1 import(s)
- `src/lib` - 1 import(s)

### Graph signals

- Files: 3
- Cross-module imports: 9

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/process/sandbox](src-harness-process-sandbox.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/lib](src-lib.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z.
