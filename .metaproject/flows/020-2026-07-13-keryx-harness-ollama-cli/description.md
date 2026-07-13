# Flow 020 — Ollama provider adapter + `keryx harness run` CLI (live-testable increment)

Status: formalized
Source: user request — add a local Ollama provider (alongside the W14 Anthropic
adapter) + a keryx CLI command to run the harness end-to-end, for full live testing.
(New increment beyond frozen Release 1; NOT a @release-2 scenario.)

## Problem

The harness is library-level (`runOffline(input, config, deps)`); it is not exposed as
a `keryx` CLI command, and the only real provider (W14 Anthropic) needs an API key the
user does not have (Claude MAX is a subscription, not an API key). The user has a local
Ollama server (`llama3.1:latest`) and wants to (1) add an Ollama `ProviderPort` adapter
so the harness can run against a local model with no key/cloud, and (2) add a
`keryx harness run` command to drive the full pipeline end-to-end for live testing.

## Approved decisions (user)

1. **Egress opt-in = narrow explicit per-grant** — the local-provider capability grant
   carries `allowLoopback: true`, and it re-permits egress ONLY to a LOOPBACK host
   (127.0.0.0/8, ::1, localhost, incl. encoded forms) for that grant's own base URL.
   The W15 SSRF guard stays fail-closed everywhere else; `allowLoopback` does NOT
   re-permit metadata (169.254/16), link-local, or private-LAN (10/8, 172.16-31,
   192.168/16) — a local model is loopback, and letting the opt-in reach cloud-metadata
   would reintroduce the exact SSRF W15 closed.
2. **Built through flow-orchestrator** — TDD RED→GREEN + an independent security review
   (the egress guard is touched — same bar as the hardening waves).

## Expected Outcome

- **Ollama adapter** — `src/harness/provider/ollama/`: `OllamaProvider implements
  ProviderPort` over the OpenAI-compatible `/v1/chat/completions` SSE endpoint (thin
  `fetch`, NO SDK — `dependencies` stays `{}`); reuse the W14 SSE line-parser; a pure
  OpenAI-delta → `NormalizedEvent` normalizer (`choices[].delta.content` → text_delta;
  `tool_calls` → tool_call_*; `finish_reason` → model_end; `usage` → usage_update).
  `describe()` reports storage/retention/continuation = false (local, stateless).
  Provider negatives fail-closed (the 9-kind taxonomy). Capability-gated + guarded
  egress with the `allowLoopback` opt-in.
- **Egress opt-in (additive, security-narrow)** — a minimal additive change so a
  configured local grant may reach a loopback base URL: add an `isLoopbackHost(host)`
  predicate (subset of `isPrivateEgressHost` — loopback only) and let the adapter permit
  the request iff `!isPrivateEgressHost(host) || (grant.allowLoopback === true &&
  isLoopbackHost(host))`. No general SSRF weakening; the Anthropic adapter's default
  fail-closed egress is unchanged.
- **`keryx harness run` CLI** — `src/commands/harness.ts` + registration in
  `src/cli.ts`: `keryx harness run --provider <fake|anthropic|ollama> --model <m>
  [--base-url <url>] "<prompt>"` wires `runOffline` with REAL deps (real clock/id/fetch,
  the selected provider) and prints the normalized event stream / final text /
  completion / evidence. `fake` = the deterministic default (no network); `ollama` =
  the local grant (`allowLoopback`, base `http://localhost:11434`); `anthropic` = reads
  `ANTHROPIC_API_KEY` from env (absent → a clear fail-closed message, no network). The
  live path is separate from the deterministic test deps.
- **Offline tests + live smoke** — the Ollama adapter (recorded transcript + mocked
  `fetch`), the egress opt-in (default localhost deny preserved; only an explicit
  `allowLoopback` grant permits loopback; metadata still denied), and the CLI (offline
  via `fake`) are covered by deterministic OFFLINE tests (no live network in CI). A live
  smoke run of `keryx harness run --provider ollama --model llama3.1:latest` against the
  local server proves end-to-end (run by the orchestrator, not in CI).

## Out of Scope (do NOT touch)

- No `@release-2` scenario. No new production dependency (`dependencies` stays `{}`; thin
  `fetch`, no SDK). No live network in the automated test suite (recorded transcripts /
  mocked `fetch` only; the live smoke is a manual orchestrator step).
- Rewriting the W5 ProviderPort / W6 fake / W7 evidence / W14 Anthropic adapter / W15
  guard — REUSE them; the only changes to a prior module are additive (the
  `isLoopbackHost` export + the opt-in branch, and the CLI registration). Large refactor
  → STOP + report.
- The frozen requirements package + ADR-0001…0004 + canonical schemas + `src/eval/` +
  `src/contracts/` — read/cite only.
- No general weakening of the W15 SSRF guard: `allowLoopback` re-permits LOOPBACK only,
  per-grant, for its own base URL; metadata/link-local/private-LAN stay denied. The
  adapter never writes flow.json (D-02). Deterministic tests (no `Date.now`/`Math.random`).
