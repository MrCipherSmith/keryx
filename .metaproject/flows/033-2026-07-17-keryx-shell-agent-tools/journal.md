# Flow Journal

- 2026-07-17T12:50:26.703Z - flow created
- 2026-07-17T12:53:19.800Z - frozen: 5 criteria; checksum recorded
- 2026-07-17T12:53:19.988Z - started
- 2026-07-17T12:53:20.143Z - task-done: T1: Collect remaining context
- 2026-07-17T12:54:33.441Z - ac-updated: probe
- 2026-07-17T12:55:36.032Z - ac-updated: Discovered durable ToolExecutorPort returns hashed receipts (not content) + policy decide is heavy; Flow A uses a lightweight content-returning interactive tool layer + read-risk gate, deferring full executor/policy/receipts to a later SA-01 flow
- 2026-07-17T13:01:39.975Z - ac-updated: Scope mid-session /agent toggle out of Flow A (chat-core reuse in one loop is costly); --agent startup flag only. Orient context wired via ctx/orient buildOrientation

## T2 — implementation (branch `feature/033-keryx-shell-agent-tools`)

- `src/harness/tool/builtin/interactive-tools.ts` (new): lightweight
  content-returning tool layer (reuses `NormalizedToolDefinition` + `ToolRisk`).
  Tools `get_cwd`/`list_dir`/`read_file`, all risk `read`, root-confined via
  `confineToRoot` (rejects `..`/absolute escapes).
- `src/commands/agent.ts` (new): deterministic `runAgentTurn(io, deps, history,
  line)` — streams `provider.stream(request WITH tools)`, on `tool_call_end`
  parses+validates input (`validateAgainstSchemaObject`), applies a `read`-only
  risk gate, invokes the executor, feeds the output back as a `role:"tool"`
  message, and re-requests until a text-only finish or the `maxToolCalls` guard.
  Plus pure `buildAgentSystemInstruction(orient?)` (embeds orient, falls back).
- `src/commands/shell.ts`: `--agent` flag + `runAgentRepl` wrapper — reuses the
  flow-031/032 header, prompt, and status bar; renders `⚙ tool(input)` +
  dim/red result summaries. Injects `builtinReadOnlyTools(cwd)` + a `ctx/orient`
  `buildOrientation(cwd)` context (best-effort). Chat `runShell` path untouched;
  `createRichIo` gained a `printPrompt` accessor.

## T3 — tests

- `interactive-tools.test.ts` (8): risk=read, `confineToRoot` inside/escape,
  get_cwd, list_dir happy + escape, read_file happy/missing/absolute-escape.
- `agent.test.ts` (4): scripted-provider tool call fed back into the next
  request as role `tool` (real cwd), tools advertised in request; text-only
  finish (no 2nd request); unknown-tool error; context builder present/absent.

## Verification

- `bunx tsc --noEmit`: clean.
- `bun test`: **1381 pass / 3 skip / 0 fail** (baseline 1369; +12). Offline/
  deterministic; the flow-021/022/031/032 chat-core tests are UNCHANGED and green.
- `--agent` startup smoke (`printf '/help\n/exit\n' | bun src/cli.ts shell
  --provider fake --model test --agent`): header shows `fake/test · agent`,
  `/help` prints agent help, `/exit` leaves cleanly; `buildOrientation` did not
  throw. No new dependency (`dependencies` stays `{}`).
- PENDING (user, real TTY, tool-capable model): ask "what is my cwd / list files"
  → agent CALLS `get_cwd`/`list_dir` and reports the REAL data, no hallucination
  (AC5 live-proof). Note `gemma4:e4b` may not emit tool calls; use a tool-capable
  model (e.g. a llama3.1/qwen ollama model, or anthropic).
- 2026-07-17T13:05:37.414Z - task-done: T2: Implement per plan
- 2026-07-17T13:05:37.512Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-17T13:05:37.599Z - ac-confirmed: AC1: interactive-tools.test.ts: 8 tests — risk=read, confineToRoot inside/escape, get_cwd/list_dir/read_file happy+escape+missing
- 2026-07-17T13:05:37.679Z - ac-confirmed: AC2: agent.test.ts: scripted tool_call fed back as role tool (real cwd) + tools advertised; text-only finish; unknown-tool error
- 2026-07-17T13:05:37.755Z - ac-confirmed: AC3: agent.test.ts: buildAgentSystemInstruction embeds orient when present, falls back on empty/undefined without throwing
- 2026-07-17T13:05:37.841Z - ac-confirmed: AC4: --agent flag + runAgentRepl; chat runShell tests unchanged/green; deps still {}; startup smoke shows agent mode + /help + /exit
