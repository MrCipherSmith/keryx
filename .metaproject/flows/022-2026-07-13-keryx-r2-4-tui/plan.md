# Implementation Plan — Flow 022 (Release 2 · R2-4 interactive CLI/TUI)

Status: frozen scope (R2-4 only) — Release 2

## Approach

Add provider/model detection + an interactive picker (`src/commands/select.ts`) and wire
it into the flow-021 shell so bare `keryx` detects available providers and lets you pick
provider+model (no hardcoded ollama/llama3.1), with `/models`/`/provider`/`/connect` slash
commands and output polish — an interactive CLI/TUI adapter over the SAME runtime ports
(SC_R13_TUI intent), test-first, NO new dependency (readline + ANSI). Reuse the W14/W20
providers + the flow-021 `runShell` core unchanged.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (RED) | test | tests-creator | **Sonnet** | logic/UX |
| T6 (impl) | implement | task-implementer | **Opus 4.8** | logic/UX |
| T7 (review) | review | review-orchestrator | **Opus 4.8** | security/UX/contract |
| T8 (live smoke) | verify | orchestrator | — | — |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via subagent-dispatch → subagent-result, worktree-guard
(`cd ~/goodea/keryx`).

## Steps

1. T1: R2-4 scope + reuse surface + testable-core contract (context.md).
2. T5 (RED): `select.ts` tests — `detectProviders` (injected fetch `/api/tags` + env; ollama
   models listed, embed excluded, unreachable→not-available; anthropic iff key; fake always)
   + `pickProviderModel` (injected lines → correct provider+model; invalid choice handled);
   `runShell` slash `/models`/`/provider`/`/connect` (extend shell.test.ts); the bare-shell
   detect+pick path (no hardcoded default). Offline.
3. T6 (GREEN): `src/commands/select.ts` (`detectProviders` + `pickProviderModel`) + additive
   `shell.ts` (`/models`/`/provider`/`/connect`, detect+pick when no `--provider`, output
   polish) + minimal `cli.ts` help note. Make T5 green.
4. T7 (review): offline-determinism (no real TTY/network in tests); no hardcoded default;
   credential never stored/entered; egress posture reused (loopback probe); reuse-only;
   `deps {}` (no new dep/SDK); D-02; no regression (flow-021 shell tests green); frozen
   untouched; no runtime-contract change (SC_R13_TUI intent).
5. T8 (live smoke): bare `keryx` against live Ollama → detect → pick provider+model → multi-
   turn chat; `/models` lists real models; `--provider anthropic` w/o key → clear message.
   Manual; not CI.
6. `keryx health run`; confirm ACs; completion (option B) + PR (no co-authorship).

## Verification

Gate: `tsc` clean; full `bun test` ≥ 1210 + new green and OFFLINE; detection is deterministic
over injected fetch/env; the picker selects correctly; no hardcoded provider default; bare
`keryx` runs detect+pick; slash commands work; credential never stored; `deps {}`; no live
network in the suite; live smoke works end-to-end; no runtime-contract change.

## Risks

- **A test hits the live Ollama / network** → `detectProviders` takes an injected `fetch`;
  tests use a recorded `/api/tags` fixture; live only in the manual smoke.
- **New dependency for a TUI/picker** → numbered readline picker (stdlib), NO framework;
  `deps {}`. A full-screen TUI is explicitly deferred (separate dep decision).
- **Credential handling** → `ANTHROPIC_API_KEY` only READ from env; `/connect` explains
  setting it; NEVER stored/entered/logged; T7 confirms.
- **Regressing the flow-021 shell** → reuse `runShell` unchanged in contract; only ADD slash
  commands + the pre-chat selection; flow-021 shell tests stay green.
- **Egress posture drift** → the `/api/tags` probe uses the same configured loopback base URL;
  chat egress stays loopback-gated (W20/W15) unchanged; detection fail-SOFT (unreachable →
  not available) is distinct from chat fail-CLOSED.
- **Wrong-worktree / runtime-contract change** → guard directives; R2-4 changes NO runtime
  contract (adapter over existing ports).
