# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Interactive REPL core — `src/commands/shell.ts` exposes an injectable `runShell(io, deps)` where `io` supplies an async line source + a write sink and `deps` supplies a `ProviderPort` factory + clock/id, reaching NO real `process.stdin`/`process.stdout`/TTY. Driven with a `FakeProvider` and an async generator of input lines, a user turn streams the assistant `text_delta`s to the write sink and appends BOTH the user message and the assembled assistant reply to a `NormalizedMessage[]` history (history grows by exactly 2 per turn); a subsequent turn sends the full accumulated history in the `NormalizedRequest` (genuine multi-turn); the loop terminates cleanly on end-of-input (EOF) and on `/exit`/`/quit`.
- AC2: Slash commands + error resilience — the shell handles `/help` (prints help, no model turn), `/model <m>` and `/provider <fake|ollama|anthropic>` (switch the active model/provider for subsequent turns), `/clear` (reset history to empty), and `/exit`/`/quit` (terminate); a turn whose provider yields a `provider_error` prints a readable error line and the loop CONTINUES (it does not throw/crash).
- AC3: CLI dispatch — `src/cli.ts` dispatches bare `keryx` (no `args[0]`) to the interactive shell, while `keryx --help`/`-h`/`help` prints the command list, which now INCLUDES `keryx harness run …` and the interactive shell; every existing `keryx <command>` (init/status/harness/…) is unchanged.
- AC4: harness-run UX fix — `keryx harness run` with an empty/unknown `--provider` OR an empty prompt prints the harness usage line and returns WITHOUT running `runOffline` (no blocked-run JSON); a valid `harness run --provider <fake|ollama|anthropic> --model <m> "<prompt>"` still works as before.
- AC5: No regression / offline / reuse / deps — `tsc --noEmit` is clean and the full `bun test` suite is ≥ the pre-change baseline with the new tests green and 0 fail, and the ENTIRE automated suite runs OFFLINE (injected IO + `FakeProvider`; no real TTY, no live network — the Ollama path is exercised only in the manual live smoke); the tested core is deterministic (no `Date.now`/`Math.random` in `runShell`; the TTY wrapper may use real clock/uuid); no new production dependency — `dependencies` REMAINS `{}` (a stdlib `node:readline`/Bun stdin only, no readline/TTY package); new code lives in `src/commands/shell.ts`, and the only changes to prior modules are additive (`src/cli.ts` bare-dispatch + printHelp, `src/commands/harness.ts` usage guard); the W14/W20 provider adapters, the W15 SSRF guard + W20 loopback opt-in, and the W5 provider types are REUSED unchanged (the shell adds no new egress path); the shell never writes flow.json (D-02); the frozen requirements package, canonical contract schemas, `src/eval/`, `src/contracts/`, and ADR-0001…0004 are NOT modified. A live smoke run of bare `keryx` against the local Ollama streams a real multi-turn reply and exits cleanly (recorded in the flow journal; not a CI gate).
