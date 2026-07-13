# Flow 021 — Interactive keryx shell (bare `keryx` opens a REPL)

Status: formalized
Source: user request — bare `keryx` (no args) should open an interactive agent shell
like Claude Code / opencode, streaming responses through the harness. (This is the
deferred SC_R13_TUI direction, brought forward as a live-usability increment on top of
the merged harness + provider adapters.)

## Problem

`keryx` today is a batch CLI: bare `keryx` prints a usage list and exits; there is no
interactive mode. The user wants bare `keryx` to open an interactive multi-turn shell
(like `claude` / `opencode`) that streams a local model's responses through the harness
provider layer. Also: the `harness` command is missing from the usage list, and
`keryx harness run` with no `--provider`/prompt prints a confusing blocked-run JSON
instead of usage.

## Approved decisions (user)

1. **Bare `keryx` (no args) → the interactive shell** (claude/opencode style);
   `keryx --help`/`-h` → the command list.
2. **Default provider = `ollama` + `llama3.1:latest`** (local, no key); overridable via
   `keryx --provider <fake|ollama|anthropic> --model <m> [--base-url <url>]` or in-shell
   slash commands.
3. Built through flow-orchestrator (TDD + review + live smoke).

## Expected Outcome

- **Interactive shell** — `src/commands/shell.ts` (`shellCommand`) — a multi-turn REPL:
  reads a user line from stdin, appends it to a `NormalizedMessage[]` history, calls the
  selected `ProviderPort.stream(request)` with the accumulated history + a trusted
  systemInstruction, streams the assistant `text_delta`s live to stdout, appends the
  assistant reply to history, and loops. Exit on `Ctrl-D` (EOF) / `Ctrl-C` / `/exit` /
  `/quit`. Slash commands: `/help`, `/model <m>`, `/provider <fake|ollama|anthropic>`,
  `/clear` (reset history), `/exit`. A `provider_error` surfaces as a readable line, not
  a crash. Reuses the W14/W20 adapters (Ollama loopback grant, Anthropic key-gated,
  Fake) — NO new provider code, NO SDK, `deps {}`.
- **CLI dispatch** — `src/cli.ts`: bare (no `args[0]`) → `shellCommand`; `--help`/`-h`/
  `help` → the command list (updated to include `harness run` + the interactive shell).
  `keryx <command>` unchanged.
- **UX fix** — `keryx harness run` with an empty/unknown `--provider` or an empty prompt
  prints the harness usage line and returns (no blocked-run JSON).
- **Testable core** — the REPL loop is a function over INJECTED IO (an async line source
  + a write sink + a `ProviderPort` factory), so offline/deterministic tests drive it
  with a `FakeProvider` and assert streaming, multi-turn history growth, slash commands,
  and clean exit — no real TTY/network in CI. A live smoke run of bare `keryx` against
  Ollama is a manual orchestrator step.

## Out of Scope (do NOT touch)

- No new provider adapter / no SDK / no new dependency (`dependencies` stays `{}`); the
  shell composes the existing W14/W20 `ProviderPort` adapters. No live network in the
  automated suite (injected fake provider + injected IO).
- No tool-execution / policy-mutation loop inside the shell v1 — it is a streaming chat
  over the provider (read-only posture); the full harness completion-gate/evidence
  pipeline (`runOffline`) is NOT run per turn (that stays the `harness run` batch path).
- The frozen requirements package + ADR-0001…0004 + canonical schemas + `src/eval/` +
  `src/contracts/` — read/cite only. The Ollama loopback egress opt-in + W15 SSRF guard
  are REUSED unchanged. Deterministic tests (no `Date.now`/`Math.random` in the tested
  core; the live shell may use real clock/uuid). The shell never writes flow.json (D-02).
