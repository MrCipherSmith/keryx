# Implementation Plan — Flow 021 (interactive keryx shell)

Status: scoped increment (post-Release-1) — live-usability

## Approach

Add an interactive multi-turn REPL as `src/commands/shell.ts` with a testable core
(`runShell` over injected IO + a provider factory) so bare `keryx` opens a chat shell
streaming a local model through the reused W14/W20 `ProviderPort` adapters, test-first.
Wire bare `keryx` → shell in `src/cli.ts` (keep `--help` → command list), and fix the
`harness run` no-args usage. Automated tests are OFFLINE (injected stdin + FakeProvider);
a live smoke of bare `keryx` against Ollama proves the TTY path.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (RED) | test | tests-creator | **Sonnet** | logic/UX |
| T6 (impl) | implement | task-implementer | **Opus 4.8** | logic/UX |
| T7 (review) | review | review-orchestrator | **Opus 4.8** | logic/security/contract |
| T8 (live smoke) | verify | orchestrator | — | — |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via subagent-dispatch → subagent-result, worktree-guard
(`cd /Users/Goodea/goodea/keryx`).

## Steps

1. T1: shell design + reuse surface + testable-core contract (context.md).
2. T5 (RED): `runShell` core tests over injected IO + FakeProvider — streaming, multi-turn
   history (+2/turn), slash commands (/model,/provider,/clear,/help,/exit), EOF exit,
   provider_error handling; cli bare→shell dispatch test; harness-run no-args usage test.
3. T6 (GREEN): `src/commands/shell.ts` (`runShell` + `shellCommand`) + `src/cli.ts`
   (bare→shell, printHelp update) + `src/commands/harness.ts` (no-args→usage). Make T5 green.
4. T7 (review): conformance + offline-determinism (no real TTY/network in tests) + reuse-only
   + deps `{}` + no regression (bare-keryx-was-help change is intentional; `--help` still lists
   commands) + egress unchanged + D-02.
5. T8 (live smoke): pipe a couple of lines + EOF into bare `keryx` against Ollama; confirm a
   real streamed multi-turn reply. (Manual; not CI.)
6. `keryx health run`; confirm ACs; completion (option B) + PR.

## Verification

Gate: `tsc` clean; full `bun test` ≥ baseline + new green and OFFLINE; the REPL core streams +
maintains history + handles slash/exit deterministically with a FakeProvider; bare `keryx`
dispatches to the shell and `--help` lists commands (incl. harness + shell); `harness run`
no-args prints usage; deps `{}`; no live network in the suite; live smoke works end-to-end.

## Risks

- **A test needs a real TTY / blocks on stdin** → the core takes an injected async line source
  + write sink (no `process.stdin`); tests feed a generator ending in EOF; the TTY wrapper is
  thin + smoke-only.
- **Changing bare `keryx` breaks scripts expecting help** → intentional per the user; `--help`/
  `-h`/`help` still prints the (updated) command list; document it. T7 confirms `--help` works.
- **Live network in the automated suite** → tests use FakeProvider + injected IO only; the
  Ollama path is exercised only in the manual live smoke.
- **New dependency for a readline/TTY lib** → use Bun's built-in stdin/`console` / `node:readline`
  (stdlib) — NO new dependency; `deps {}`.
- **Rewriting providers / egress** → reuse the W14/W20 adapters + W15 guard unchanged; the shell
  only composes them; large change → STOP + report.
- **Wrong-worktree / index-guard** → guard directives in every dispatch (root = main checkout).
