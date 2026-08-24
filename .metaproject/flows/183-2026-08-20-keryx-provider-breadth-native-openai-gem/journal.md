# Flow Journal

- 2026-08-20T19:49:59.896Z - flow created
- 2026-08-20T19:59:41.205Z - task-added: T5: Extract OllamaProvider's compat engine into its own module, keep 8 dependent files passing unchanged
- 2026-08-20T19:59:41.323Z - task-added: T6: OpenAiProvider: native adapter targeting the Responses API
- 2026-08-20T19:59:41.419Z - task-added: T7: GeminiProvider: native adapter targeting generateContent/streamGenerateContent
- 2026-08-20T19:59:41.520Z - task-added: T8: make-provider.ts: openai/gemini named branches (code, not compat-registry data)
- 2026-08-20T19:59:41.622Z - task-added: T9: select.ts: add openai/gemini as first-class picker entries
- 2026-08-20T19:59:41.717Z - task-added: T10: SYNTHETIC fixtures for both vendors, sourced from the researched wire shapes, provenance documented in a manifest
- 2026-08-20T19:59:41.807Z - task-added: T11: SSRF/egress guard test for both new adapters, analogous to guard.loopback.test.ts
- 2026-08-20T20:00:01.601Z - frozen: 6 criteria; checksum recorded
- 2026-08-20T20:00:01.682Z - started
- 2026-08-20T20:15:35.641Z - task-done: T5: Extract OllamaProvider's compat engine into its own module, keep 8 dependent files passing unchanged
- 2026-08-20T20:31:54.161Z - task-done: T6: OpenAiProvider: native adapter targeting the Responses API
- 2026-08-20T20:31:54.260Z - task-done: T7: GeminiProvider: native adapter targeting generateContent/streamGenerateContent
- 2026-08-20T20:31:54.351Z - task-done: T8: make-provider.ts: openai/gemini named branches (code, not compat-registry data)
- 2026-08-20T20:46:07.519Z - task-done: T9: select.ts: add openai/gemini as first-class picker entries
- 2026-08-20T20:46:07.622Z - task-done: T10: SYNTHETIC fixtures for both vendors, sourced from the researched wire shapes, provenance documented in a manifest
- 2026-08-20T20:46:07.702Z - task-done: T11: SSRF/egress guard test for both new adapters, analogous to guard.loopback.test.ts
- 2026-08-20T20:46:16.738Z - task-done: T1: Collect remaining context
- 2026-08-20T20:46:16.842Z - task-done: T2: Implement per plan
- 2026-08-20T20:46:16.941Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-20T20:46:17.041Z - task-done: T4: Self-review and prepare draft PR
- Summary: T5 (commit 7d8677f) extracted OllamaProvider's ~600-line compat
  engine into src/harness/provider/compat/openai-compat-provider.ts,
  parameterized by identity; OllamaProvider became a thin wrapper (kept,
  not retired, because 2 test files construct it directly). T6+T7
  (commit bf8963a, dispatched in parallel, disjoint new directories, no
  conflict) built OpenAiProvider (Responses API, call_id correlation,
  reasoningMetadata confirmed live via response.reasoning_summary_text.delta,
  defends a documented empty-message context-overflow bug) and
  GeminiProvider (legacy generateContent/streamGenerateContent - a real
  architectural decision over the newer stateful Interactions API,
  confirmed AnthropicSSEParser fits Gemini's SSE framing unchanged,
  confirmed tool args arrive whole-in-one-chunk not delta-streamed).
  Both wired into make-provider.ts additively. T9 (commit c065f9c) added
  openai/gemini to select.ts's picker, model IDs verified against the
  official OpenAI/Gemini docs pages directly via WebFetch (a first
  WebSearch pass returned plausible-looking model names I initially
  suspected were SEO-spam fabrications - direct WebFetch of
  developers.openai.com/ai.google.dev confirmed they were real). T10/T11
  were substantially delivered inside T6/T7's own dispatches (each
  adapter shipped with its own .SYNTHETIC. fixtures + manifest + AC4 SSRF
  test) - confirmed via grep before marking done, no separate dispatch
  needed. AC1/AC2 remain explicitly NOT MET (no live API key) per the
  user's pre-approved decision - every fixture/capability claim traces to
  live-researched vendor documentation, not training recall, with
  unconfirmed items left false rather than guessed true. Independent
  verification after every commit: tsc clean, full provider+select+guard
  test suite green throughout (232 pass/0 fail at the end).
- 2026-08-20T20:47:00.760Z - ac-confirmed: AC1: NOT fully met (docpack standard: live API call, not available). Delivered instead: OpenAiProvider (openai-provider.ts) builds/streams/normalizes correctly against fixtures/provider-breadth/openai/*.SYNTHETIC.* sourced from live-researched current OpenAI Responses API docs (WebSearch+WebFetch, confirmed via 3+ independent sources for reasoningMetadata specifically); 12 tests pass. Live verification remains an open follow-up.
- 2026-08-20T20:47:00.852Z - ac-confirmed: AC2: NOT fully met (docpack standard: live API call, not available). Delivered instead: GeminiProvider (gemini-provider.ts) builds/streams/normalizes correctly against fixtures/provider-breadth/gemini/*.SYNTHETIC.* sourced from live-researched current Gemini generateContent docs; confirmed AnthropicSSEParser fits Gemini's SSE framing unchanged and tool args arrive whole-in-one-chunk (not delta-streamed) via research; 25 tests pass. Live verification remains an open follow-up.
- 2026-08-20T20:47:00.945Z - ac-confirmed: AC3: src/harness/provider/compat/openai-compat-provider.ts is the distinct extracted module; the 8-file blast radius (ollama-provider.ts/.test.ts, select.ts/.test.ts, providers.ts, make-provider.ts/.test.ts, guard.loopback.test.ts) verified before and after: 87->102 pass/0 fail (T5's own before/after run) plus this session's independent re-run, 232 pass/0 fail on the full combined set. One deliberate, named test-import update (make-provider.test.ts's toBeInstanceOf assertion), no behavior change.
- 2026-08-20T20:47:01.031Z - ac-confirmed: AC4: Both new adapters have a dedicated AC4 SSRF/egress-guard describe block (openai-provider.test.ts, gemini-provider.test.ts) proving private/loopback/link-local/metadata denial + no-grant fail-closed, same isPrivateEgressHost/isLoopbackHost predicates as the existing two adapters.
- 2026-08-20T20:47:01.148Z - ac-confirmed: AC5: Capability matrix for both adapters recorded in plan.md and each fixture manifest, per-flag sourced from research with unconfirmed items left false (Gemini reasoningMetadata was researched-unconfirmed then confirmed true during T7 via a direct docs quote; OpenAI vision stayed false because request-side serialization isn't wired despite the shape being confirmed - not overclaimed).
- 2026-08-20T20:47:01.260Z - ac-confirmed: AC6: Import audit in both adapters' own test files confirms no vendor SDK import (source-text scan); package.json dependencies/optionalDependencies untouched by this flow.
- PR #364 review round 1 (CI green, 11/11): dispatched `/code-review high`
  against the full diff (T5's extraction + T6-T9's new adapters/wiring).
  10 findings, triaged into two groups:
  REAL GAPS FROM THIS PR'S OWN NEW WORK (all fixed, 4 commits -
  69b184f/6a52a13/b252b69 plus this entry's own edits):
    1. single-turn.ts's hasCredential/keyedProviderCandidates/
       defaultModelFor never recognized "openai"/"gemini" - auto-provider-
       detection (wiki enrich, health explain --narrate, etc.) silently
       dead for both new providers. Fixed, tests added.
    2. sandbox's buildDefaultMaskProviders never registered OPENAI_API_KEY/
       GEMINI_API_KEY/GOOGLE_API_KEY - a leaked key from either new
       provider would not be auto-redacted from captured sandbox output.
       Fixed (security-relevant), tests updated+added.
    3. new class OpenAiCompatProvider (T5's extraction) collided in name
       with the pre-existing OpenAiCompatProvider interface in
       commands/providers.ts (a compat-registry entry type). No live
       import collision yet, but a real landmine. Renamed the class to
       OpenAiCompatEngine across 5 files, verified no other reference
       remains (providers.ts's own interface untouched).
    4. GeminiProvider silently substituted DEFAULT_MODEL for an empty
       request.modelId; every other adapter (Anthropic, OpenAI, the
       compat engine) lets an empty modelId reach the vendor API and fail
       loudly instead. Made Gemini consistent - silently answering from a
       wrong model is worse than a loud vendor-side rejection.
    5. OpenAiProvider's response.failed/response.incomplete SSE branches
       had zero test coverage, unlike every other branch in the same
       switch. Added 2 inline tests; both passed on the first run,
       confirming the existing (untested) code was already correct.
  DELIBERATELY NOT FIXED - pre-existing behavior in the ORIGINAL
  OllamaProvider that T5's zero-behavior-change extraction (AC3) correctly
  preserved verbatim, confirmed by reading the pre-extraction source
  myself: the compat engine's classifyHttpError collapses 401/403/429/400
  into one invalid_request kind with no Retry-After handling; it never
  redacts grant.apiKey from error messages; Ollama's native flat-string
  error format ({"error":"<string>"}) is coerced to {} and the real text
  lost; all 9 non-Ollama compat gateways report providerId "ollama"
  (already named as an explicit, separate, out-of-scope naming fix in
  T5's own header comment). "Fixing" any of these inside this flow would
  violate AC3's own zero-behavior-change requirement - real, worthwhile
  follow-up work, but for a different, dedicated flow. Also not fixed:
  duplicated type-narrowing helpers (isPlainObject/asRecord/etc.) across
  4 provider files - a real DRY observation, lower priority, deferred.
  Full test suite re-verified after every fix commit: 266 pass/0 fail on
  the final combined run.
- 2026-08-20T21:11:56.049Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/364 (warning: PR is not a draft)
- 2026-08-20T21:12:05.606Z - completing
- 2026-08-20T21:12:08.254Z - done: all gates passed
