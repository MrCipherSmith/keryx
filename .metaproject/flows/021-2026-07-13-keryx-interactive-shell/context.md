# Context — Flow 021 (interactive keryx shell)

Collected by `keryx flow init` and enriched. (T1 context.) Post-Release-1 increment.

## Baseline
- On `main` (harness + Ollama/CLI merged) + this branch `feature/keryx-interactive-shell`.
- `bun test` ~1160/0 baseline on main; `tsc --noEmit` clean; deps `{}`. (Flows 003–020 on main.)

## Approved decisions (user)
1. Bare `keryx` (no args) → interactive shell; `keryx --help`/`-h` → command list.
2. Default provider `ollama` + `llama3.1:latest` (local, no key); overridable.
3. Via flow-orchestrator (TDD + review + live smoke).

## Reuse surface (compose; do NOT rewrite)
- **cli.ts** `src/cli.ts` `main()`: `const command = args[0]; if (!command || "--help"|"-h") printHelp()`.
  CHANGE: `!command` → `shellCommand(...)`; keep `--help`/`-h`/`help` → `printHelp()`. Update
  `printHelp` to list `harness run` + the interactive shell. Dispatch a new `command === "chat"`
  optionally as an explicit alias (not required). Mirror existing `command === "..."` blocks.
- **Providers (W14/W20)** `src/harness/provider/{anthropic,ollama,fake-provider}` — all implement
  `ProviderPort` (`describe()`, `stream(request: NormalizedRequest, opts: StreamOptions):
  AsyncIterable<NormalizedEvent>`). Ollama: `new OllamaProvider({fetch, grant:{network:true,
  allowLoopback:true, baseUrl?}})`. Anthropic: key-gated. Fake: `new FakeProvider(transcripts)`.
- **Types** `src/harness/provider/types.ts` — `NormalizedRequest { providerId; modelId;
  systemInstruction; messages: NormalizedMessage[]; tools?; options?; budget: NormalizedBudget;
  stream; signal?; requestId; parentRunId }`; `NormalizedMessage { role:"system"|"user"|
  "assistant"|"tool"; content; provenance? }`; `NormalizedEvent { kind; text?; usage?; error?;
  ... }` (kind text_delta carries `text`; model_end/usage_update; provider_error carries `error`).
  The adapters read `request.systemInstruction` + `request.messages[]` → wire messages.
- **harness.ts** `src/commands/harness.ts` — the provider-selection + read-only policy profile
  pattern to mirror for the shell's provider factory; also the UX-fix target (`harness run` no-args).

## Multi-turn design
- The shell keeps `history: NormalizedMessage[]`. Each turn: read a user line → push
  `{role:"user", content:line}` → build a `NormalizedRequest` (providerId/modelId from the
  selected provider+model; a trusted `systemInstruction`; `messages: history`; `stream:true`;
  a `budget`; injected `requestId`/`parentRunId`) → `for await (const ev of provider.stream(req,
  {attemptId}))`: on `text_delta` write `ev.text` to stdout live + accumulate; on `provider_error`
  print a readable error line + break; on `model_end` finish → push `{role:"assistant",
  content:accumulated}`. Loop. This is a lighter conversational path than `runOffline` (no
  completion-gate/evidence per turn) and reuses the adapters directly.

## Testable REPL core (the key to offline tests)
- `runShell(io, deps)` where `io = { lines: AsyncIterable<string>; write: (s:string)=>void }`
  and `deps = { makeProvider: (name, model, baseUrl?) => ProviderPort; clock; idSeq; initial:
  {provider, model, baseUrl?} }`. No direct `process.stdin`/`process.stdout`/TTY in the core.
  Tests feed an async generator of lines (incl. slash commands + a final EOF) + a FakeProvider
  and assert: streamed text captured, `history` grows by 2 per turn (user+assistant), `/clear`
  resets history, `/model`/`/provider` switch, `/exit` + EOF terminate cleanly, a provider_error
  turn prints an error line and continues. `shellCommand(args)` = the thin TTY wrapper wiring
  real stdin(readline)/stdout + the provider factory + real clock/uuid.

## Egress / security (reuse, unchanged)
- Ollama provider uses the W20 loopback grant (`allowLoopback:true`) — W15 SSRF guard unchanged;
  metadata/LAN still denied. Anthropic key-gated (no key → the shell reports it, stays offline).
  The shell adds NO new egress path.

## D-02 invariant
The shell never writes flow.json (it is a conversational REPL, not the Task Manager loop).

## Decisions (approved)
- New: `src/commands/shell.ts` (`runShell` core + `shellCommand` wrapper). Additive edits:
  `src/cli.ts` (bare → shell; printHelp update) + `src/commands/harness.ts` (no-args → usage).
  Reuse W14/W20 providers + W5 types. NO SDK/new dep (deps `{}`). Tested core with injected IO +
  FakeProvider (offline/deterministic). Live TTY = manual smoke. Default ollama/llama3.1:latest.
- TDD: RED (Sonnet) → impl (Opus) → review (Opus) → live smoke (orchestrator).

## Operational
- keryx = `bun ./src/cli.ts`. Root = `/Users/Goodea/goodea/keryx` (branch
  feature/keryx-interactive-shell). Never commit to main directly; PR at the end.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx && pwd` first, write ONLY
  under it. Guard array indexing; async-iterable mocks for stdin; no real TTY/network in tests.
- Order: T5 (RED) → T6 (impl) → T7 (review) → T8 (live smoke).
