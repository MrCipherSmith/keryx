# Context — Flow 020 (Ollama provider + keryx harness CLI)

Collected by `keryx flow init` and enriched. (T1 context.) New increment beyond Release 1.

## Baseline
- `bun test` = 1160 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ 46bf40a.
- Local Ollama: server on `http://localhost:11434`; models `llama3.1:latest` (8B, chat+tools)
  + `nomic-embed-text` (embeddings only). OpenAI-compat `/v1/chat/completions` streams SSE;
  confirmed live (usage: prompt/completion/total tokens; finish_reason).

## Approved decisions (user)
1. Egress opt-in = **narrow explicit per-grant `allowLoopback`** — re-permits LOOPBACK
   only (127/8, ::1, localhost, encoded forms) for the grant's own base URL; metadata
   (169.254)/link-local/private-LAN stay DENIED; general SSRF guard unchanged.
2. Built via flow-orchestrator (TDD + independent security review).

## Reuse surface (compose; only additive changes to prior modules)
- **W5 ProviderPort** `src/harness/provider/{types,provider-port}.ts` — `ProviderPort`
  (`describe(): ProviderDescription`; `stream(request: NormalizedRequest, opts:
  StreamOptions): AsyncIterable<NormalizedEvent>`), `NormalizedEvent`/`NormalizedError`/
  `NormalizedRequest`/`NormalizedUsage`, `NormalizedEventKind` (model_start|text_delta|
  tool_call_start|tool_call_delta|tool_call_end|usage_update|model_end|provider_error),
  `ProviderErrorKind` (9), `defaultRetryable`, `assertEventValid`. `AnthropicProviderDescriptorDocument`
  is the descriptor-doc bridge pattern to mirror.
- **W14 Anthropic adapter** `src/harness/provider/anthropic/{anthropic-provider,sse}.ts`
  — MIRROR its structure: `class AnthropicProvider implements ProviderPort`, constructor
  `deps: {fetch; grant?; clock?}`, `AnthropicCapabilityGrant {network:true; apiKey; baseUrl?}`,
  the guarded body read (fail-closed cancelled/malformed — the flow-019 fix), credential
  redaction, `describe()`/`descriptorDocument()`. Reuse `sse.ts` `AnthropicSSEParser`
  (generic `data:`-line SSE framing — reusable for the OpenAI-compat stream).
- **W15 egress guard** `src/harness/mutation/guard.ts` — `export function isPrivateEgressHost(host)`
  (denies loopback/private/metadata incl. encoded IPv4 + IPv6-mapped). ADD a sibling
  `export function isLoopbackHost(host): boolean` — TRUE only for loopback forms (127.0.0.0/8,
  `::1`/`[::1]`/`::ffff:127.x`, `localhost`, and the encoded loopback forms the existing
  decoder already recognizes), NOT metadata/private-LAN. Reuse the existing decodeEncodedIPv4/
  isPrivateIPv4 internals; do not reimplement.
- **W7 evidence/redaction** `src/harness/evidence/redaction.ts` — reuse for any surfaced content.
- **runOffline** `src/harness/run/run.ts` — `runOffline(input: HarnessRunInput, config:
  HarnessConfig, deps: RunDeps): Promise<RunResult>`. `RunDeps = {provider: ProviderPort;
  toolRegistry; toolExecutor; policyProfile: PolicyProfile; clock: ()=>string; idSeq:
  ()=>string; interactive: boolean}`. `runViaCli` (`src/harness/run/cli.ts`) delegates to it.
  Read `HarnessRunInput`/`HarnessConfig`/`RunResult` exact shapes before wiring.
- **CLI** `src/cli.ts` registers commands from `./commands/*` and dispatches on `args[0]`.
  ADD `src/commands/harness.ts` (`harnessCommand`) + register it. Mirror an existing
  simple command (e.g. `src/commands/status.ts` or `health.ts`) for the arg-parse/print style.

## Ollama wire → Normalized mapping (OpenAI-compat SSE)
- `POST ${baseUrl}/v1/chat/completions` with `{model, stream:true, messages, tools?}`.
- SSE `data: {...}` chunks: first chunk / `role` → `model_start`; `choices[0].delta.content`
  → `text_delta`; `choices[0].delta.tool_calls[]` → tool_call_start/delta/end (id/name/args);
  `choices[0].finish_reason` (stop/tool_calls/length) → `model_end`; a trailing chunk with
  `usage` (or the final `data: [DONE]`) → `usage_update`. Map HTTP/stream errors to the
  9-kind taxonomy (404 model-not-found → invalid_request; connection refused → unavailable;
  malformed/torn → malformed; abort → cancelled). No Anthropic-specific assumptions.

## Egress opt-in (the security-narrow change)
- Ollama grant: `{network:true; baseUrl:"http://localhost:11434"; allowLoopback:true}`.
- Adapter egress check: permit the request IFF `!isPrivateEgressHost(host)` OR
  (`grant.allowLoopback === true` AND `isLoopbackHost(host)`). So: a public host → allowed
  (as today); a loopback host + allowLoopback grant → allowed; a loopback host WITHOUT the
  opt-in → DENIED (as today); metadata/link-local/private-LAN → DENIED even WITH the opt-in
  (isLoopbackHost is false for them). Fail-closed default preserved.

## keryx harness run CLI
- `keryx harness run --provider <fake|anthropic|ollama> --model <m> [--base-url <url>] "<prompt>"`.
- Build `RunDeps` with real `clock`/`idSeq` (wall-clock/uuid is fine for a live run — NOT the
  deterministic test path), a minimal toolRegistry/toolExecutor (no tools, or a read-only stub),
  a policyProfile (read-only-review default), `interactive:false`, and `deps.provider` = the
  selected provider. `fake` → W6 FakeProvider (offline default). `ollama` → OllamaProvider with
  the loopback grant. `anthropic` → AnthropicProvider reading `ANTHROPIC_API_KEY` (absent → a
  clear fail-closed message; no network). Print events/final text/completion/evidence.

## D-02 invariant
The adapter + CLI never write flow.json (the CLI runs the harness, not the Task Manager loop).

## Decisions (approved)
- New code under `src/harness/provider/ollama/` + `src/commands/harness.ts`; additive
  `isLoopbackHost` export + opt-in branch in the Ollama adapter; CLI registration in
  `src/cli.ts`. Thin fetch/SSE, NO SDK, deps `{}`. Reuse W5/W6/W7/W14/W15. Tests OFFLINE
  (recorded transcripts + mocked fetch); live smoke is a manual orchestrator step. Deterministic
  tests (no Date.now/Math.random). allowLoopback re-permits loopback ONLY. Adapter writes no flow.json.
- TDD: RED tests (Sonnet) → GREEN impl (Opus) → security review (Opus) → live smoke (orchestrator).

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first, write ONLY under it. fetch-mocks `as unknown as typeof fetch`; guard array indexing.
- Order: T5 (RED) → T6 (impl) → T7 (security review) → T8 (live smoke).
