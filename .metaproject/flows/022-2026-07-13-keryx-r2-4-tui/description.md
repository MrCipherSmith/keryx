# Flow 022 — Release 2 · Wave R2-4: Interactive CLI / TUI adapter

Status: formalized
Source: user runbook prompt (Release 2, Wave R2-4). Frozen scope from
`docs/decisions/keryx-harness/E-03-release1-handoff.md` §4 AC-R2-4 +
`SC_R13_TUI_DEFERRED` (acceptance.feature:520, @R13 @release-2 @positive).

## Problem

The interactive `keryx` shell (flow 021, merged) is a minimal REPL that HARDCODES
`provider="ollama"` / `model="llama3.1:latest"` (shell.ts:203-204). So bare `keryx` auto-
targets a local model that may not exist and offers no way to see/choose providers or
models from the CLI — unlike other terminal agents, where you select provider+model interactively.
R2-4 turns the shell into a proper interactive CLI/TUI adapter over the SAME stable
CLI/JSONL-RPC runtime ports (no runtime-contract change — SC_R13_TUI intent), with
provider/model detection + selection and no hardcoded default.

## Scope (frozen: E-03 §4 AC-R2-4 · SC_R13_TUI_DEFERRED)

"A later adapter over the stable CLI/JSONL-RPC runtime ports established in Release 0
(R0-03); no runtime-contract change is required." R2-4 is INDEPENDENT of R2-1/R2-2/R2-3
(extension-execution / provenance / bound-parallel-wave) and R2-5 (real-subprocess) —
those are out of scope for this wave.

## Approved decision (user)

**Variant A — NO new dependencies** (readline + ANSI, numbered picker). A full-screen TUI
framework (Ink etc.) is NOT introduced in this wave — `dependencies` stays `{}`. A
full-screen TUI is a separate future dependency decision.

## Expected Outcome

1. **Provider/model selection** (replaces the ollama/llama3.1 hardcode) — a new
   `src/commands/select.ts`:
   - `detectProviders(deps)` — probes `ollama` (`GET {baseUrl}/api/tags`, injected fetch →
     its chat models), `anthropic` (available iff `ANTHROPIC_API_KEY` in injected env; a
     static known-model list), `fake` (always). Returns the available providers + models.
   - `pickProviderModel(io, detected)` — an interactive numbered picker (readline over the
     injected line source): choose provider, then model. Returns `{provider, model,
     baseUrl?}`. NO hardcoded default.
   - `shellCommand`: bare `keryx` (no `--provider`) → detect + pick BEFORE the chat; an
     explicit `keryx --provider X [--model Y]` skips the picker (Y or the provider's first
     model).
2. **In-session slash commands** (reuse the flow-021 `runShell` core): `/models` (list the
   current provider's models → pick to switch), `/provider` (re-run the picker), `/connect`
   (explain how to set `ANTHROPIC_API_KEY` — the credential is NEVER stored or entered by
   the tool), plus the existing `/help`, `/clear`, `/model`, `/exit`, `/quit`.
3. **Output polish** — a newline/separator after each turn, a `> ` input indicator, and the
   active provider/model shown in the prompt.

## Out of Scope (do NOT touch)

- R2-1/R2-2/R2-3/R2-5 (extension-execution, provenance, bound-parallel-wave, real-
  subprocess). No new provider adapter (reuse W14/W20). No full-screen TUI framework / no
  new dependency (`dependencies` stays `{}` — `node:readline` stdlib only). No live network
  in the automated suite (injected IO/fetch/env + FakeProvider; live Ollama = manual smoke).
- The `ANTHROPIC_API_KEY` credential is NEVER stored/entered/logged — only read from env
  and referenced in `/connect` guidance.
- The frozen requirements package + ADR-0001…0004 + canonical schemas + `src/eval/` +
  `src/contracts/` — read/cite only. The flow-021 `runShell` core + W14/W20 provider
  adapters + W15 egress guard + W20 loopback opt-in are REUSED unchanged (composition only).
  The shell/CLI never write flow.json (D-02). Deterministic tests (no `Date.now`/
  `Math.random` in the tested core). Commits/PR carry NO co-authorship trailer.
