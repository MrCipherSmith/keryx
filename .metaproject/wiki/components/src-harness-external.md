---
Title: Module src/harness/external
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/external` groups 21 file(s). Depends on `src/harness/external/codec`, `src/mcp-client`, `src/harness/monitor`. Exposes 13 public symbol(s)."
---
```markdown
---
Title: Module src/harness/external
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/external` groups 21 file(s). Depends on `src/harness/external/codec`, `src/mcp-client`, `src/harness/monitor`. Exposes 13 public symbol(s)."
---

# Module src/harness/external

## Overview

`src/harness/external` owns the harness-facing contract for running external agent CLIs (such as `claude` and `codex`) and ACP agents as supervised child runs. Its public entry point, `runExternalChild`, takes a dispatch's runtime block and returns a typed outcome, so callers never handle process spawning, vendor event formats, or MCP-client details themselves. Consumers named in the module graph are `src/tui`, `src/harness`, `src/commands`, and `scripts/smoke`.

## How it works

The module has four cooperating layers, all kept pure except for the injected process and worktree ports:

- **Contract**: `types.ts` holds the vocabulary: `ExternalAgentEntry` (one CLI described as data), `ExternalRunInput`, the canonical `ExternalEvent` union, and `ExternalAgentCodec`. A codec is three pure functions (`buildArgv`, `parseLine`/`parseEvents`, `classifyFailure`), so each vendor adapter can be tested offline against recorded transcripts. The adapters themselves live under `src/harness/external/codec`.
- **Registry and validation**: `registry.ts` is a static `EXTERNAL_AGENTS` table of metadata (binary, detect argv, known version range, sandbox modes, transport) with lookup helpers. It spawns nothing and never reports a login state; availability is `available`, `binary-missing`, or `not-probed`, and an out-of-range version is only a warning. `dispatch.ts` `validateRuntimeBlock` fails closed in a fixed order: the agent must exist, the CLI must support the requested sandbox, the release gate must allow it, and `read-only` must not contradict `allowed_actions`. Its refusal codes separate "this agent cannot" from "keryx does not do that yet". `worktree-write` is available for ACP agents and, for `claude-cli` and `codex-cli`, only when the caller owns write capture.
- **Orchestration**: `runtime.ts` `runExternalChild` runs one fixed sequence: capability gate, nesting depth, validation, codec or ACP transport resolution, optional version detection, staged result schema, prompt assembly, disposable worktree creation, execution, structured-result validation, and worktree removal in a `finally`. Every failure returns a named `ExternalCompletionStatus` and stops; it never falls back to another agent.
- **Supervision**: `supervise.ts` `superviseExternalRun` is the impure line-stream path. It spawns through an injected `ExternalSpawnPort` with stdin never inherited, parses stdout through the codec, counts unparseable lines as drift signals rather than failures, and races stream drain against the wall-clock timeout and any terminal event. Partial output is kept on every exit path. `supervise-mcp.ts` `superviseCodexMcpRun` is a separate path for `codex mcp-server`: it answers each elicitation through `src/mcp-client`, always runs `resolveApprovalDecision`, and default-denies when no approver is wired. `gatedSuperviseCodexMcpRun` applies the capability gate first. This MCP path is not wired into `dispatch.ts`.

## Key concepts

- **External agent entry**: `ExternalAgentEntry` describes one agent CLI. Its `transport` is `"line-stream"` (default) or `"acp"`.
- **Run input**: `ExternalRunInput` is what a codec needs to build argv (prompt, cwd, sandbox, model, schema). `RunExternalChildInput` is the caller-facing input, carrying the runtime block, task, timeout, and parent environment.
- **Sandbox**: `ExternalSandbox` is `"read-only"` or `"worktree-write"`. The registry records what a CLI supports, and the dispatch layer records what keryx implements; the two are deliberately separate.
- **External events**: `ExternalEvent` is the canonical event set that vendor streams fold onto. `retry` is non-terminal. `child_finished` and `child_failed` are terminal, as `TERMINAL_EVENT_KINDS` and `isTerminalEvent` define.
- **Outcomes and status**: `ProcessOutcome` is the input to `classifyFailure`. `ExternalChildOutcome` is the result, carrying `output`, `partial`, `sessionRef`, `argv`, `worktreePath`, and `costUnits`. A missing cost stays absent and is never zero. `ExternalCompletionStatus` names the result; `runtime.ts` itself produces `Completed`, `Timeout`, `Denied`, and `Error`.
- **Structured result**: a `Completed` run's output must validate against the `subagent-result` schema. A violation becomes `Error`, with the original text moved to `partial`.
- **Dependency injection**: `RunExternalChildDeps` supplies the spawn port, worktree port, capability gate, optional detector, and callbacks, which keeps the module independent of concrete process implementations.

## Main flows

### Run an external child

1. A caller builds a `RunExternalChildInput` whose `runtime` block names the agent, sandbox, and limits.
2. `runExternalChild` checks the capability gate and nesting depth, then `validateRuntimeBlock` resolves the registry entry.
3. For a line-stream agent it fetches the codec with `getExternalCodec`. For an ACP agent it routes to `runAcpBranch`, which uses `runAcpInWorktree` and, when a project root is set, `persistAcpRun`.
4. The prompt is assembled, a worktree is created, and the codec's `buildArgv` (or `buildStreamingArgv` for a steerable run) feeds `superviseExternalRun`.
5. `buildOutcome` maps the run onto a status. A run stopped for size reports its named overflow reason first, then the codec's `classifyFailure` decides. Structured-result validation runs last, and the worktree is removed in the `finally`.

### Observe a line-stream run

1. `superviseExternalRun` spawns the child and pumps each stdout line through `codec.parseEvents` (or `parseLine`).
2. Each parsed event is checked against the output budget, added to the transcript, and passed to `onEvent` as it arrives.
3. A terminal event starts a settle timer. If the streams do not close in time, the child is killed and the run is treated as ended, not timed out.
4. On a wall-clock timeout the child is killed, and the outcome is built from the transcript collected so far with `timedOut: true`.

### Supervise a codex MCP run

1. `superviseCodexMcpRun` connects to the `codex mcp-server` child and records a `child_started` event.
2. Each `elicitation/create` request is correlated with a sibling `codex/event` by `call_id` and classified for risk.
3. `resolveApprovalDecision` runs for every elicitation. An `auto` decision approves; otherwise the request goes to `requestApproval`, raced against a 45-second default timeout that counts as a deny.
4. Each answer is recorded in the returned `elicitations` array and never added to `events`.
5. The `tools/call` result becomes `child_finished` or `child_failed`, and the connection is closed.

---

## Reference

### Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `ExternalSandbox` | type | Execution boundary or isolation concept |
| `ExternalAgentEntry` | interface | Describable external agent or integration |
| `ExternalRunInput` | interface | Parameters to start an external run |
| `ExternalEvent` | type | Observable activity during an external run |
| `TERMINAL_EVENT_KINDS` | constant | Event kinds that mark completion |
| `isTerminalEvent` | function | Predicate to identify terminal events |
| `ProcessOutcome` | interface | Typed result for completed processes |
| `ExternalAgentCodec` | interface | Translation between harness and external representations |
| `ExternalCompletionStatus` | type | Normalized completion state |
| `ExternalChildOutcome` | interface | Result of an external child run |
| `RunExternalChildInput` | interface | Input for starting an external child |
| `RunExternalChildDeps` | interface | Injectable runtime dependencies |
| `runExternalChild` | function | Main execution entry point |

### File Inventory

| File | Imports | Reused By |
|------|---------|-----------|
| `types.ts` | 0 | 26 |
| `runtime.ts` | 10 | 4 |
| `supervise.ts` | 2 | 11 |
| `registry.ts` | 1 | 10 |
| `supervise-mcp.ts` | 9 | 2 |
| `dispatch.ts` | 2 | 4 |

### Module Dependencies

- [src/harness/external/codec](src-harness-external-codec.md) — codec boundary (6 imports)
- [src/mcp-client](src-mcp-client.md) — MCP client integration (5 imports)
- [src/harness/monitor](src-harness-monitor.md) — lifecycle observation (2 imports)
- [src/harness/child](src-harness-child.md) — child process abstractions (2 imports)
- [src/capability](src-capability.md) — capability definitions (2 imports)
- [src/commands](src-commands.md) — command layer (2 imports)

### Module Consumers

- [src/tui](src-tui.md) — 14 imports
- [src/harness](src-harness.md) — 11 imports
- [src/harness/external/codec](src-harness-external-codec.md) — 5 imports
- [src/commands](src-commands.md) — 4 imports
- `scripts/smoke` — 3 imports
- [src/mcp-servers](src-mcp-servers.md) — 2 imports

---

## Related Pages

- [Wiki Index](../index.md)
- [Module src/harness/external/codec](src-harness-external-codec.md)
- [Module src/mcp-client](src-mcp-client.md)
- [Module src/harness/monitor](src-harness-monitor.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/capability](src-capability.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)
- [Module src/harness](src-harness.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```
