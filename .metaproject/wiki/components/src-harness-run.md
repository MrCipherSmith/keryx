---
Title: Module src/harness/run
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/run` is the offline, deterministic run loop of the harness: `runOffline` assembles startup, provider streaming, policy, tool execution, redaction and the completion gate into one run."
---
```markdown
---
Title: Module src/harness/run
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/run` is the offline, deterministic run loop of the harness: `runOffline` assembles startup, provider streaming, policy, tool execution, redaction and the completion gate into one run."
---
# Module src/harness/run

## Overview

`src/harness/run` owns the assembled offline run of a harness turn. Its entry point, `runOffline` in `src/harness/run/run.ts`, wires startup, the provider stream, the policy engine, the tool executor, the session log, redaction and the completion gate into one run, and returns a `RunResult` whose `output` is a schema-valid `HarnessRunOutput`.

The module also exports the typed contract that callers use instead of the execution internals: `RunDeps`, `CompletionRequirements`, `RunResult`, `HarnessRunOutput`, `HarnessRunOutputMetrics` and `UnresolvedRisk`. Modules that depend on it in the code graph, such as `src/commands`, `src/harness/replay` and `src/harness/resume`, consume these types. `cli.ts` adds `runViaCli`, which only delegates to `runOffline`.

## How it works

- **Startup gate first.** `runOffline` calls `startRun` (from `src/harness/startup`) before anything else. Any outcome other than `started` goes to `earlyTermination`, which returns a `failed` output with a `blocker:startup` and never opens a provider stream.
- **Streaming loop.** The run consumes the events of `deps.provider.stream(...)`. `tool_call_start` only records the tool name for a call id. Each `tool_call_end` is one unit of work, and `model_end` marks the final message and fires the optional `Stop` hook.
- **Per-call decision pipeline.** Each call is decided in a fixed order. `decide()` from `src/harness/policy/engine` runs first, and the MP-6 blast-radius escalation may tighten an `allow` to `ask`. The optional `PreToolUse` hook runs next, and `composeDecision` (from `src/harness/hooks/compose`) folds its decisions in. The optional `approver` comes last, and it can only turn an `ask` into `allow`, only when the fingerprint it returns equals this call's action fingerprint. Only an `allow` reaches execution.
- **Guards before execution.** A hard budget ceiling (`budget_exceeded`) and a loop guard (the same action fingerprint reaching `LOOP_THRESHOLD`, which is 3) each record an unresolved risk and a blocker, then stop the loop.
- **Execution and persistence.** `deps.toolExecutor.invoke` runs the call. A thrown error becomes `blocker:tool-rejected:<id>`, and a result whose status is not `succeeded` becomes a blocker. The result passes through `redactForPersistence` (from `src/harness/evidence/redaction`) with the injected `scan`, then it is appended to an `AppendOnlySession` as a `tool_result` artifact reference.
- **Completion.** After the loop, `evaluateCompletion` (from `src/harness/completion/gate`) checks the caller's required gates and evidence refs, the undisposed blockers and the final-message flag. `resolveStatus` then maps the outcome: any unresolved risk gives `blocked`, a gate `pass` gives `completed`, a gate `blocked` gives `blocked`, and anything else gives `failed`.
- **Optional hooks and approver.** With no `deps.hooks`, no hook fires and `RunResult` omits `hookInvocations` and `hookWarnings`. With no `approver` and no interactive channel, `decide()` turns an `ask` into a headless deny.
- **Determinism.** `run.ts` reads no clock or randomness of its own. Time and ids come only from `deps.clock` and `deps.idSeq`, and the `runId`, `sessionId` and `requestId` values derive from the context manifest hash.

## Key concepts

- **Run dependencies**: `RunDeps` is the injected bundle. Required fields are `provider`, `toolRegistry`, `toolExecutor`, `policyProfile`, `clock`, `idSeq` and `interactive`. Optional fields are `metaprojectPort`, `blastRadiusThreshold`, `scan`, `completionRequirements`, `hooks` and `approver`. The run creates its own `AppendOnlySession`, so a session is not part of `RunDeps`.
- **Completion requirements**: `CompletionRequirements` lists `requiredGates` (gates that must report `pass`) and `requiredEvidenceRefs` (evidence ids that must appear among the ones the run records). Both default to empty, so an ad-hoc run does not start failing.
- **Run output**: `HarnessRunOutput` is the terminal document. It carries `status`, `gate`, `artifacts`, `unresolvedBlockerIds` and, when there are stop reasons, `unresolvedRisks`.
- **Run metrics**: `HarnessRunOutputMetrics` holds `toolCalls`, `modelRequests` and `retries`. In this module the token and wall-time fields are set to `null`, and `reliability` is `"unknown"`.
- **Unresolved risk**: `UnresolvedRisk` is a string-literal type alias, `"budget_exceeded" | "loop_detected"`, not an interface. It is the typed stop-reason surface, and any entry forces the run to `blocked`.
- **Blockers**: Undisposed blockers are plain strings such as `blocker:tool-rejected:<id>`, `blocker:redaction-failed:<id>` and `blocker:hook-denied:UserPromptSubmit`. The completion gate checks them.
- **Run result**: `RunResult` combines `output` with the ordered `events`, `decisions` and `sessionEntries`, plus the hashes (`sessionManifestHash`, `eventLogHash`, `toolRegistryHash`, `transcriptHash`, `expectedStateHash`) that a replay fixture binds to.

## Main flows

### 1. Offline run through `runOffline`

1. The caller passes a `HarnessRunInput`, a `HarnessConfig` and a `RunDeps` bundle. `startRun` decides whether the run may start.
2. If `deps.hooks` fires `UserPromptSubmit` with a `deny` or `ask`, the run ends `blocked` before the stream opens.
3. The loop streams provider events. For each complete tool call it runs the decision pipeline, then the budget and loop guards, then `toolExecutor.invoke`, then the optional `PostToolUse` or `PostToolUseFailure` hook.
4. Each result is redacted and appended to the session as a `tool_result` reference, and a `model_end` event sets the final-message flag.
5. `evaluateCompletion` runs over the collected evidence and blockers, and `resolveStatus` sets the terminal status. The function returns a `RunResult` whose `output` is a `HarnessRunOutput`.

### 2. Headless call that is not allowed

1. `decide()` checks the call. With no interactive channel and no `approver`, an `ask` is already a deny.
2. The decision is pushed to `decisions` and recorded as a `policy_decision` session entry.
3. A call whose composed decision is not `allow` is skipped with `continue`. It is never sent to `toolExecutor`, and no tool result is recorded.

### 3. CLI invocation and replay

1. `runViaCli` in `src/harness/run/cli.ts` delegates to `runOffline` unchanged and returns its `RunResult`.
2. The CLI adds no policy of its own, so it cannot change a decision made by the in-process engine.
3. Replay fixtures bind to the `RunResult` hashes (`sessionManifestHash`, `eventLogHash`, `transcriptHash`, `expectedStateHash`), which are recomputed from the same deterministic inputs. The file `src/harness/replay/replay.ts` is the consumer.

---

## Reference

### Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `runOffline` | function | Primary entry point for starting a run with a `RunDeps` bundle |
| `RunResult` | interface | Top-level outcome shape combining output, metrics, and risk |
| `HarnessRunOutput` | interface | Qualitative result artifacts produced by a run |
| `HarnessRunOutputMetrics` | interface | Quantitative measures capturing run performance or quality |
| `CompletionRequirements` | interface | Declared conditions that must be satisfied for a run to complete |
| `RunDeps` | interface | Dependency bundle supplying tools, providers, policies, and sessions |
| `UnresolvedRisk` | interface | Records remaining uncertainty or unmet requirements from a run |

### Key files

| File | Purpose |
|------|---------|
| `src/harness/run/run.ts` | Main implementation (imported by 15 modules, imports 14 modules) |
| `src/harness/run/cli.ts` | Command-line entry point (imported by 1 module, imports 3 modules) |
| `src/harness/run/run.test.ts` | General behavior tests (imports 10 modules) |
| `src/harness/run/run.metaproject.test.ts` | Metaproject-level expectation tests (imports 10 modules) |
| `src/harness/run/run.completion-requirements.test.ts` | Completion requirement tests (imports 8 modules) |

### Dependencies

- [Module src/harness/tool](src-harness-tool.md) — 12 imports
- [Module src/harness](src-harness.md) — 11 imports
- [Module src/harness/provider](src-harness-provider.md) — 7 imports
- [Module src/harness/policy](src-harness-policy.md) — 6 imports
- [Module src/harness/session](src-harness-session.md) — 2 imports
- [Module src/contracts](src-contracts.md) — 1 import

### Dependents

- [Module src/harness](src-harness.md) — 3 imports
- [Module src/lib](src-lib.md) — 3 imports
- [Module src/commands](src-commands.md) — 2 imports
- [Module src/harness/replay](src-harness-replay.md) — 2 imports
- [Module src/harness/resume](src-harness-resume.md) — 2 imports

### Module metrics

- **Files**: 5
- **Cross-module imports**: 41

## Related pages

- [Wiki Index](../index.md)
- [Module src/harness/tool](src-harness-tool.md)
- [Module src/harness](src-harness.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/harness/policy](src-harness-policy.md)
- [Module src/harness/session](src-harness-session.md)
- [Module src/contracts](src-contracts.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/replay](src-harness-replay.md)
- [Module src/harness/resume](src-harness-resume.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- **0.1.0** — Initial draft generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```
