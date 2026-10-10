# Context — Flow 022 (Release 2 · R2-4 interactive CLI/TUI)

Collected by `keryx flow init` and enriched. (T1 context.) Release 2, Wave R2-4.

## Baseline
- Branch `feature/keryx-release2-tui` from `main` @ 03ba6df (R0+R1 + flow-021 shell merged).
- `bun test` = 1210 pass / 0 fail; `tsc --noEmit` clean; deps `{}`.

## Frozen scope (E-03 §4 AC-R2-4 · SC_R13_TUI_DEFERRED)
- E-03: "TUI adapter — a later adapter over the stable CLI/JSONL-RPC runtime ports (R0-03);
  no runtime-contract change required. Independent of AC-R2-1…3."
- `acceptance.feature:520` SC_R13_TUI_DEFERRED (@R13 @release-2 @positive): "Given the CLI
  and JSONL/RPC transports are stable / When TUI work is considered / Then it remains a
  later adapter over the same runtime ports." → R2-4 adds the interactive adapter WITHOUT
  changing the runtime contract.

## User decision (frozen)
Variant A — NO new dependency (readline + ANSI numbered picker). No full-screen TUI
framework in this wave; `deps {}`.

## Reuse surface (compose; do NOT rewrite)
- **flow-021 shell** `src/commands/shell.ts` — `ShellIO {lines: AsyncIterable<string>;
  write: (s)=>void}`, `ShellDeps {makeProvider; clock; idSeq; initial:{provider,model,
  baseUrl?}}`, `runShell(io, deps)` (the REPL core — REUSE + extend with `/models`/`/provider`/
  `/connect`), `shellCommand(args)` (the TTY wrapper — REPLACE the hardcoded ollama/llama3.1
  default at lines 203-204 with detect+picker), `SYSTEM_INSTRUCTION`, `HELP_TEXT`.
- **Providers (W14/W20)** `src/harness/provider/{ollama/ollama-provider,anthropic/anthropic-
  provider,fake-provider}.ts` — all `ProviderPort`. Ollama grant `{network:true,allowLoopback:
  true,baseUrl?}`; anthropic key-gated; fake offline. UNCHANGED.
- **harness.ts** `src/commands/harness.ts` — the provider-selection + read-only policy profile
  pattern to mirror in the shell's `makeProvider` factory (already mirrored in flow-021).
- **cli.ts** `src/cli.ts` — bare (no command) → `shellCommand` (flow 021); `--help` list.

## Ollama model listing (for detectProviders)
- `GET {baseUrl}/api/tags` → `{ models: [{ name, details:{family,...} }] }`. Chat models =
  exclude embedding families (e.g. `nomic-bert`/embed). Injected `fetch` in tests (a recorded
  `/api/tags` fixture); live only in the manual smoke. If the ollama server is unreachable →
  ollama is simply "not available" (no crash), fail-soft in detection (distinct from the
  egress fail-CLOSED which stays for actual chat requests).
- Anthropic: no local list without a key; use a small static known-model list (e.g.
  `claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5`) surfaced only when `ANTHROPIC_API_KEY`
  is set. `/connect` explains setting the env var — NEVER store/enter the key.

## Testable core (offline)
- `detectProviders(deps: {fetch; env; baseUrl?})` — pure over injected fetch (ollama /api/tags)
  + env (anthropic key). Returns `[{name, models: string[], baseUrl?}]`. Deterministic.
- `pickProviderModel(io: ShellIO, detected): Promise<{provider, model, baseUrl?}>` — reads
  numbered choices from `io.lines`, writes menus to `io.write`. No real TTY.
- Tests drive both with injected fetch/env + an async line generator; assert menus rendered,
  a numeric choice selects the right provider+model, an out-of-range/invalid choice re-prompts
  or defaults safely, and the resulting selection feeds `runShell`. `/models`/`/provider`/
  `/connect` tested via the runShell injected-IO harness (extend flow-021's shell.test.ts).

## D-02 / security
- The shell/CLI never write flow.json. Ollama chat egress stays loopback-gated (W20/W15);
  detection's `/api/tags` probe is to the same configured local base URL (loopback) — reuse
  the same egress posture. Credential never stored/entered/logged.

## Target modules
- `src/commands/select.ts` (NEW) — `detectProviders` + `pickProviderModel`.
- `src/commands/shell.ts` (ADDITIVE) — `/models`/`/provider`/`/connect` in `runShell`;
  `shellCommand` uses detect+picker when `--provider` absent; output polish.
- `src/cli.ts` (unchanged dispatch; help text may add a note). No runtime-contract change.

## Decisions (approved)
- New `src/commands/select.ts`; additive `shell.ts` + `cli.ts`. Reuse flow-021 core + W14/W20
  providers + W15/W20 egress (unchanged). NO new dep (`node:readline` stdlib), `deps {}`.
  Tests OFFLINE (injected IO/fetch/env + FakeProvider); live smoke manual. Deterministic core
  (no Date.now/Math.random). Credential never stored. D-02. No co-authorship in commits.
- TDD: RED (Sonnet) → impl (Opus) → review (Opus security/UX) → live smoke (orchestrator).

## Operational
- keryx = `bun ./src/cli.ts`. Root = `~/goodea/keryx` (branch feature/keryx-release2-tui).
  Never commit to main; PR at the end (no co-authorship).
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd ~/goodea/keryx && pwd` first, write ONLY
  under it. Guard array indexing; async-iterable mocks for stdin/lines; injected fetch/env; no
  real TTY/network in tests.
- Order: T5 (RED) → T6 (impl) → T7 (review) → T8 (live smoke).
