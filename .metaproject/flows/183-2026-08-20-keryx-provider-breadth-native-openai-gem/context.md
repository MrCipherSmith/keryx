# Context

Collected deterministically by `keryx flow init` at 2026-08-20T19:49:59.757Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-20T11:53:56.789Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

### No live API keys — user-approved deviation

`OPENAI_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY` are all absent from this
environment (checked directly, not inferred). The user was asked explicitly
whether to (a) provide keys, (b) build without live verification and mark
it honestly, or (c) skip this package. Answer: **(b)** — implement against
current vendor documentation, fixtures marked `.SYNTHETIC.`, AC1/AC2
recorded as not fully met rather than silently softened. See
`acceptance-criteria.md` and `description.md`.

### Existing provider architecture (read directly, not assumed)

- `src/harness/provider/types.ts` — the `ProviderPort` target shape: 9
  `NormalizedEventKind`, 9 `ProviderErrorKind`, `NormalizedUsage`,
  9-flag `ProviderCapabilities`. SDK-free by design.
- `src/harness/provider/ollama/ollama-provider.ts` (604 lines) — the file
  T2 extracts. Its `stream()` method body genuinely IS the generic
  OpenAI-Chat-Completions-compat engine: SSE parse via
  `AnthropicSSEParser`, tool-call accumulation by `index`/`id` key,
  `linkToolCalls` for request-side tool-result linking, SSRF guard via
  `isPrivateEgressHost`/`isLoopbackHost`. Only `DEFAULT_BASE_URL`,
  `PROVIDER_REVISION`, `DEFAULT_MODEL`, and `describe()`'s hardcoded
  `providerId: "ollama"` are genuinely Ollama-specific.
- `src/harness/provider/anthropic/sse.ts` — `AnthropicSSEParser`, a fully
  generic `text/event-stream` parser (despite the name/location), already
  reused by `OllamaProvider`. Both new adapters should reuse it directly.
- `src/harness/provider/make-provider.ts` — `makeProvider(name, model,
  opts)`: `"anthropic"` reads `ANTHROPIC_API_KEY`, falls back to
  `FakeProvider` when absent (never touches network without a
  credential); `"ollama"` and any `providerByName()` compat-registry hit
  construct `OllamaProvider` with a scoped grant. `openai`/`gemini` need
  the same shape as the `anthropic` branch (dedicated named code, not a
  registry entry — D-03).
- `src/commands/providers.ts` (301 lines), `src/commands/select.ts`
  (357 lines) — not read in full during flow-init; implementer reads
  directly. `providers.ts` holds `OPENAI_COMPAT_PROVIDERS`; `openai`/
  `gemini` do NOT go in it (D-03).

### Live vendor-shape research (WebSearch/WebFetch, not training recall)

Full findings folded into `plan.md`'s "Vendor wire-shape decisions"
section — summary of what's confirmed vs. explicitly unconfirmed:

**OpenAI** — targets the **Responses API** (`/v1/responses`), confirmed
current-recommended over Chat Completions. Confirmed: SSE event `type`
strings, `call_id` as the tool-call correlation key, `usage` field names,
auth (`Authorization: Bearer`, `OPENAI_API_KEY`). Unconfirmed (verify
during implementation, do not silently assume): exact reasoning-summary
SSE event type string, exact `input_image` vision content-part shape,
full Responses schema (reference page didn't fetch cleanly), exact
context-length-exceeded error `code` string on the streaming path. Named
defensive finding: a documented third-party bug report shows
context-overflow on the *streaming* Responses path returns a terminal
`error` event with an EMPTY `message` — classify defensively, don't
surface the empty string.

**Gemini** — targets **legacy `generateContent`/`streamGenerateContent`**,
NOT the newer stateful Interactions API (real architectural decision,
recorded in plan.md — Interactions' `previous_interaction_id`
session model structurally mismatches keryx's stateless
`NormalizedRequest`). Confirmed: flat `contents[]` shape, no `system`
role (separate `systemInstruction` field), `functionCall`/
`functionResponse` part shapes, parallel tool calls supported, `x-goog-api-key`
header auth, dedicated `countTokens` endpoint exists. Unconfirmed: whether
`?key=` query-param auth still works, exact `thinkingConfig` shape for
reasoning metadata (do not claim `reasoningMetadata: true` until
confirmed), `Retry-After`/`RetryInfo` presence on 429s, whether
`alt=sse` is required or now default for streaming.

Full per-vendor detail (error taxonomy mapping candidates, usage field
lists, capability-by-capability sourcing) is in this flow's research
agent transcript if a later task needs more than plan.md's summary —
ask the flow-orchestrator rather than re-researching from scratch.
