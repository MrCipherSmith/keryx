# Keryx Task Router — Implementation Plan

Version: 0.4.0 (draft — reworked per operator direction, 2026-09-25)
Base: `origin/main` @ `e04715a2`, keryx `0.2.161`

This plan splits `PRD.md` into flows sized the way recent flows in this
repo are sized (`.metaproject/flows/300-*` through `303-*`: one coherent,
independently-shippable slice each, with its own acceptance criteria
file). No flow is opened by this package — flow letters below (A–D) are
placeholders; the operator runs `keryx flow start` (or the flow-
orchestrator skill) to assign real ids when ready to build.

Acceptance criteria are drafted below in keryx style: `- ACn: <criterion>`,
one line, verifiable, naming files/functions/tests, matching the register
used in
`.metaproject/flows/300-2026-09-23-tui-sidebar-and-modals-for-the-governanc/acceptance-criteria.md`.

Order, per the operator's direction: **the table before the classifier.**
Flow A ships the routing-table infrastructure with zero classifier
involvement — categories are chosen explicitly by the call site (review,
subagents). Flow A2 adds model-profile discovery and a `derived` default
table built from those profiles — still no classifier. Flow B adds the
*idea* of a pluggable classifier plus the cheapest real implementation
(the session's own model). Flow C adds Jev. Flow D widens which call
sites auto-route and adds the metrics PRD §16 asks for.

## Flow A — routing table, `/routing` modal, CLI; wire review + subagents

No classifier anywhere in this flow. A category is always chosen by the
call site itself (`review`, `subagents`) or by the operator directly
(`/routing`, `keryx routing set`) — never inferred from task text.

Draft acceptance criteria:

- AC1: `src/harness/routing/table.ts` (new) defines `ROUTING_CATEGORIES`
  (`default`, `review`, `subagents`, `quick`, `coding`, `planning`,
  `docs`, `unattended` — PRD §4) and a `CategoryAssignment` union
  (`{kind:"session-default"}` | `{kind:"model", providerId, modelId}` |
  `{kind:"provider-default", providerId}`, PRD §5). A `resolveCategory
  (category, layers): CategoryAssignment` function applies the precedence
  order (explicit override > per-project > per-user > `default`, PRD §5)
  over injected per-user/per-project tables — pure, no fs/network access
  itself.
- AC2: `routing.config.json` (project root) and a per-user entry
  (alongside `apiKeys`/`openrouterKey` in shell config,
  `src/lib/shell-config.ts`) are both readable/writable through a shared
  loader (`loadRoutingConfig`/`saveRoutingConfig`), same "config file +
  schema validation" pattern as `security.config.json`'s loader. An
  unreadable or malformed file is a named, surfaced error — never a
  silent empty table.
- AC3: `keryx routing list [--json]`, `keryx routing set <category>
  <provider>/<model>`, `keryx routing set <category> <provider>` (provider-
  default form), `keryx routing unset <category>`, all exist in
  `src/commands/routing.ts`, mirroring `keryx providers`' subcommand
  dispatch shape (`src/commands/providers.ts:1065-1090`). `--user`/
  `--project` select the write layer, defaulting to `--user`. `list`
  prints every category, its resolved assignment, and its source layer.
- AC4: `/routing` (new, registered in `AGENT_SLASH_COMMANDS`,
  `src/commands/agent-commands.ts`, agent-mode only) opens a list+detail
  modal through `modal-host`: the list side is every category with its
  current resolution; selecting one opens a **flat** searchable/filterable
  model picker built on the existing `mountFilterList`
  (`src/tui/tui-shell.ts:3198-`) fed `"<providerId>/<modelId>"` strings
  flattened across every `detectProviders()` entry
  (`src/commands/select.ts`), plus one "provider default" row per
  connected provider and one "session default" row — never a two-step
  provider-then-model flow (PRD §7, §Non-goals). A confirmed pick writes
  immediately (to the per-user layer per AC3's default), not on modal
  close. Proven by a modal test over a fixture multi-provider catalogue.
- AC5: `keryx review tier`'s dispatch-model computation
  (`runTier`, `src/commands/review.ts:767`) resolves the `review` category
  (AC1) ahead of / alongside its existing live-detection ranking — when
  the category resolves to an explicit `{kind:"model"}`, that provider/
  model is used; when it is `session-default`, today's exact behavior is
  unchanged (a regression/snapshot test with an empty routing table
  reproduces byte-identical `runTier` output to pre-Flow-A).
- AC6: `spawn_subagent` (`src/harness/tool/builtin/spawn-subagent-tool.ts`)
  resolves the `subagents` category (AC1) when the dispatcher supplied no
  explicit `ChildModelRequest` (i.e. `kind` absent or `"inherit"`,
  `src/harness/child/model.ts:43-46`) — constructing a `{kind:"explicit",
  providerId, modelId}` or `{kind:"tier", tier}` request from the
  category's resolution before calling `resolveChildModel`
  (`model.ts:156-`). AC7 covers what happens to that request next.
- AC7: The category-resolved `ChildModelRequest` from AC6 passes through
  `resolveChildModel`'s G1 (allowlist)/G2 (network-trust)/G3
  (classifiable) gates completely unmodified — proven by a test where the
  `subagents` category resolves to a provider outside `allowedProviders`,
  and the spawn is denied with the SAME reason text an explicit
  out-of-allowlist request produces today (regression-pinned against
  `model.test.ts`'s existing denial cases). A dispatcher-supplied explicit
  request still overrides the category entirely (AC6's "no explicit
  request" gate), proven by a test asserting the category is never even
  looked up when the dispatcher named its own provider/model/tier.
- AC8: CI is green; `keryx health run` passes; existing
  `spawn-subagent-tool.test.ts`, `model.test.ts`, and `review.test.ts`
  suites are unmodified in their pre-existing assertions (additive tests
  only).

Tasks (sizes: S ≤ half day, M ≤ 2 days, L > 2 days):
- T1 (M): `src/harness/routing/table.ts` — types, `resolveCategory`,
  precedence logic (AC1).
- T2 (M): config loader/writer for both layers + schema validation (AC2).
- T3 (M): `src/commands/routing.ts` — `list`/`set`/`unset` (AC3).
- T4 (L): `/routing` modal — list view + flat model picker (AC4).
- T5 (M): `review tier` integration (AC5).
- T6 (M): `spawn_subagent` integration + gate-preservation tests (AC6, AC7).
- T7 (S): docs (`docs/docs/cli-reference.md`, README, category catalogue
  table from PRD §4).

## Flow A2 — model profile discovery and derived default routing

Ships between Flow A (the table) and Flow B (the classifier), per the
operator's direction — still no classifier anywhere in this flow. Extends
Flow A's table/CLI/modal with per-model profiles and a new `derived`
precedence layer, so an operator who has configured nothing still gets a
sensible category -> model mapping built from whatever their session
provider actually offers (PRD §6).

Draft acceptance criteria:

- AC1: `src/harness/routing/model-profile.ts` (new) defines `ModelProfile`/
  `ProfileSource`/`PrioritySource` (PRD §6.1): `strengthTier`,
  `priceInputPerMillion`, `priceOutputPerMillion`, `contextLength` (each
  `{value, source}`, `source` one of `reported`/`curated`/`guessed`/
  `operator`/`unknown`), `priority` (`{value, source: "auto"|"operator"}`),
  `available` (boolean), `lastSeenAt`, `refreshedAt`.
- AC2: `fetchOpenAiCompatModelsDetailed` and `testProviderConnection`
  (`src/commands/providers.ts:613`, `:838`) are extended to parse
  `pricing`/`context_length` off ANY gateway's `/models` response body,
  generically, when present (confirmed present for OpenRouter, PRD §6.1;
  parsing is not gateway-specific — it reads the fields when they exist
  and falls through per-field when they don't) and to call a new
  `refreshModelProfiles(...)` after a successful live fetch — additive:
  both functions' existing return shape (`ModelsResolveResult`) is
  unchanged, profiles are a side effect written to the per-user store
  (AC3), not a new return field, so no existing caller or test of either
  function needs to change.
- AC3: Profiles are stored per-user in `src/lib/shell-config.ts` (alongside
  `apiKeys`/`modelParams`), keyed by `<providerId>/<modelId>`, readable/
  writable through `loadModelProfiles`/`saveModelProfiles`. The store is
  ONE catalogue, not split by provenance: a curated seed entry (AC4a) and
  a later-discovered entry from any other provider live side by side in
  the same keyed map.
- AC4a: A hand-maintained curated seed table ships for EXACTLY the three
  providers with no live `/models` source today —
  `ANTHROPIC_MODELS`/`OPENAI_MODELS`/`GEMINI_MODELS`
  (`src/commands/select.ts:75,84,93`) — with a price/context/tier entry
  per listed model id. It seeds the per-user catalogue (AC3) on first use,
  never overwriting an already-stored (especially `operator`-sourced)
  entry for the same id.
- AC4b: Connecting ANY other provider — built-in compat-registry entry or
  a custom `llm-providers.json` entry — adds its discovered profiles
  (AC2's parsing) to the SAME per-user catalogue (AC3) the curated seed
  lives in, each retaining its own per-field `source` independent of every
  other entry in the store (the operator's decision, 2026-09-25: "the
  catalogue is curated seed plus everything discovered").
- AC5: Strength-tier guessing reuses `rankModelId`/`MODEL_RANK_HINTS`
  (`src/gdskills/model-tier.ts:205-258`) unmodified: rank `< 0` -> `light`,
  `0` -> `standard`, `> 0` -> `deep`, `undefined` -> `standard` (source
  `guessed`) — never a new/second regex table.
- AC6: A price or context-length field with no `reported`/`curated`/
  `operator` source is `{value:"unknown", source:"unknown"}` — NEVER `0`
  or a fabricated number — verified by a test.
- AC7: `priority` is computed automatically as `-priceInputPerMillion`
  when known, else a fixed documented sentinel below every known price
  (PRD §6.1 "Auto-priority") — on first profile creation AND on every
  refresh (the operator's decision, 2026-09-25) — UNLESS the profile's
  `priority.source` is already `"operator"`, in which case it is never
  recomputed. Proven by a test: two profiles with known, different prices
  auto-rank cheaper-first; an operator-set priority survives a refresh
  that changes that model's price.
- AC8: `keryx routing profile list [--json]` (extends
  `src/commands/routing.ts` from Flow A) prints every stored profile —
  including catalogue-grown (non-seed) entries — with its fields, sources,
  `available` status, and `priority`; `keryx routing profile set
  <provider>/<model> --tier|--price-in|--price-out|--context|--priority
  <value>` writes an operator correction, storing that field with
  `source: "operator"`; a subsequent refresh (AC2) leaves every
  `operator`-sourced field on that profile untouched while updating the
  rest.
- AC9: A refresh (AC2) DIFFS against the profiles already stored for that
  provider (PRD §6.2): a newly-listed model id gets a fresh profile
  (`available: true`); a model id no longer listed is marked
  `available: false` and KEPT, never deleted; a model id in both updates
  its non-`operator` fields and advances `lastSeenAt`. Proven by a test
  simulating a shrunk-then-grown live model list across two refreshes.
- AC10: `resolveCategory` (Flow A AC1) gains a `derived` rung between
  per-user and `default` (PRD §6.3 precedence: explicit > per-project >
  per-user > derived > default), and treats any layer's resolved model as
  UNRESOLVED at that layer when its profile is `available: false`,
  falling through to the next layer (PRD §6.2). `deriveDefaultTable
  (providerId, models, profiles)` is a PURE function: one AVAILABLE model
  -> that model for every category; several available models ->
  lightest-priced (`quick`/`subagents`/`docs`), strongest (`planning`/
  `review`), session model unchanged (`default`/`coding`), tie-broken by
  `priority.value` after tier/price; a category with no comparable
  (all-`unknown`) candidate falls through to the bare session model.
  Derivation reads only the SESSION's current provider's models in v1
  (cross-provider derivation is out of scope — PLAN.md open question 8).
- AC11: `keryx routing list` (Flow A AC3) reports a category with no
  explicit config as `auto (derived from <provider>'s models)` — distinct
  from `session default` — including which profile fields (and their
  sources) the derivation used, and reports an explicit/per-project/
  per-user entry pointing at an unavailable model as `<provider>/<model> —
  unavailable, falling back to <resolved>` (AC10).
- AC12: The `/routing` modal (Flow A AC4) shows, per model in the flat
  picker, its strength tier, price (or "unknown"), context length,
  priority, source per field, and `available`/`unavailable` status
  (an unavailable model is shown greyed/struck-through, still selectable),
  and marks which categories are currently derived vs. explicit vs.
  session-default vs. falling-back-from-unavailable.
- AC13: The `/connect` `[Test]` result and `keryx providers test`'s output
  mention when the refresh updated stored model profiles, with counts
  (e.g. "3 added, 1 changed, 1 now unavailable").
- AC14: CI is green; `keryx health run` passes; Flow A's existing tests are
  unmodified in their pre-existing assertions.

Tasks:
- T1 (S): `model-profile.ts` types (AC1).
- T2 (M): extend `fetchOpenAiCompatModelsDetailed`/`testProviderConnection`
  parsing (generic, any gateway) + `refreshModelProfiles` wiring (AC2).
- T3 (S): per-user profile store, one catalogue (AC3).
- T4 (S): curated seed table for Anthropic/OpenAI/Gemini + seeding logic
  that never overwrites an existing entry (AC4a).
- T5 (S): catalogue-growth wiring — any provider's discovery adds to the
  same store (AC4b).
- T6 (S): tier-guess via `rankModelId` reuse (AC5, AC6).
- T7 (M): auto-priority computation + operator-set exemption (AC7).
- T8 (M): `keryx routing profile list|set` incl. `--priority` (AC8).
- T9 (M): refresh-diff logic — added/changed/unavailable (AC9).
- T10 (M): `deriveDefaultTable` + `resolveCategory` integration, including
  the unavailable-falls-through rule (AC10).
- T11 (S): `keryx routing list` derived/unavailable-entry reporting
  (AC11).
- T12 (M): `/routing` modal profile + availability display (AC12).
- T13 (S): `/connect` Test / `keryx providers test` profile-refresh
  counts (AC13).
- T14 (L): tests — one-model provider, several models with known
  (reported/curated) prices, several with guessed prices/unknown fields,
  catalogue growth from a non-seeded provider, auto-priority ordering,
  operator-set priority surviving a refresh, availability
  marking/fallback across two refreshes, cross-checked against
  `model.test.ts`-style fixtures.
- T15 (S): docs.

## Flow B — classifier abstraction + main-model classifier

Introduces `TaskClassifier` (PRD §9.1) and its cheapest real
implementation. Still no Jev/`DecisionPort` in this flow — that is Flow C.
Nothing auto-classifies yet; this flow makes classification *possible* and
exposes it through `keryx routing explain`, not through any live call site
(Flow D wires call sites).

Draft acceptance criteria:

- AC1: `src/harness/decision/classifier.ts` defines `TaskClassifier` (PRD
  §9.1: `classify(task, categories) -> {ok, category, confidence, source}
  | {ok:false, reason}`), and a `NullClassifier` that always returns
  `{ok:false, reason:"no classifier configured"}` — the default when
  nothing is configured (PRD §9.4).
- AC2: `MainModelTaskClassifier`
  (`src/harness/decision/main-model-classifier.ts`) sends one short,
  non-streaming, tool-free request to the session's own current
  provider/model asking for exactly one of the candidate category names,
  parses a single-token or short-JSON reply into `{category, confidence}`
  — an unparseable or out-of-vocabulary reply is `{ok:false, reason:
  "unparseable classifier response"}`, never a guessed category.
- AC3: The classifier call is size-capped (task text truncated past a
  configured limit, flagged when truncated) and gated: it is only invoked
  when a caller explicitly asks for a classification (`keryx routing
  explain`, or a Flow D call site) — never speculatively, never more than
  once in flight for the same request, mirroring
  `NextStepSuggestionGate`'s cancel-on-superseded shape
  (`src/tui/tui-shell.ts:3737-3742`).
- AC4: `keryx routing explain "<task>"` (extends `src/commands/routing.ts`
  from Flow A) runs the configured classifier (falling back to
  `NullClassifier` when none is configured or enabled) and prints the
  category, confidence, source (`main-model`/none), and the resolved
  provider/model for that category from Flow A's table. `--json` mirrors
  the same fields machine-readably.
- AC5: A classifier timeout (default 2000ms, configurable) or network/
  provider error is reported as a distinct `{ok:false, reason}` and never
  surfaces as an unhandled rejection to the caller.
- AC6: CI is green; `keryx health run` passes.

Tasks:
- T1 (S): `TaskClassifier` interface + `NullClassifier` (AC1).
- T2 (M): `MainModelTaskClassifier` — request construction, response
  parsing, size cap (AC2, AC3).
- T3 (S): `keryx routing explain` (AC4).
- T4 (M): tests — injected provider stub (success, unparseable, timeout,
  error), gating/dedup test (AC3, AC5).
- T5 (S): docs.

## Flow C — Jev classifier via `DecisionPort`

Adds the second, richer classifier implementation, kept behind the same
`TaskClassifier` interface Flow B defined — nothing calling a classifier
needs to change to gain Jev; only configuration (`classifier: "jev"`)
selects it.

Draft acceptance criteria:

- AC1: `src/harness/decision/decision-port.ts` defines `DecisionQuestion`,
  `DecisionAnswer`, and `DecisionPort` (`decide(state, questions) ->
  {answers, usage}`), structurally independent of `ProviderPort`
  (`src/harness/provider/types.ts:345`) — no shared method name, no
  import of provider types into the new file (PRD §9.2).
- AC2: `src/harness/decision/jev-decision-port.ts` implements
  `JevDecisionPort`, constructed with `{fetch, apiKey}`. `decide()` makes
  exactly one `POST https://openrouter.ai/api/v1/systemone` call with
  `Authorization: Bearer <apiKey>` and body `{model, state, questions}`,
  parses `{id, model, provider, answers, usage}`, never retries. Proven by
  tests with an injected `fetch` stub asserting the exact request body and
  a parsed-response round trip; zero real network calls in the test file.
- AC3: `JevDecisionPort.decide()` enforces the 64k combined `state`+
  `questions` token budget client-side (character-based estimate,
  documented as approximate) — an over-budget call returns a named
  refusal rather than sending a request TypeSafe would reject. `decide()`
  honors a `timeoutMs` (default 2000) via `AbortSignal`, reporting a
  timeout as a distinct reason (PRD §13).
- AC4: `JevTaskClassifier`
  (`src/harness/decision/jev-classifier.ts`) implements `TaskClassifier`
  (Flow B AC1) over a `DecisionPort`: one `choice` question whose
  `criteria` are the wired category names (PRD §4), plus a `confidence`
  `noul` question (PRD §9.2). Confidence below the configured threshold
  (default 0.6) is `{ok:false, reason:"low confidence"}`, not a returned
  category.
- AC5: `JevTaskClassifier` is selected only when `classifier: "jev"` is
  configured (Flow A/B's config surface) AND `OPENROUTER_API_KEY`
  resolves (same resolution as the `openrouter` compat-provider entry,
  `src/commands/providers.ts:312-321`) — otherwise construction falls
  back to `MainModelTaskClassifier` or `NullClassifier` per the chain in
  PRD §9.4, proven by a test with the key present but `classifier` unset.
- AC6: The task text assembled into `state` is passed through
  `redactSensitiveText` (`src/security/redact.ts:128`) before the
  `DecisionPort` call — proven by a test planting a secret/PII-shaped
  string in the task text and asserting it never appears verbatim in the
  constructed request body.
- AC7: A routing-specific spend ceiling (`routing.spendCeilingUsd`,
  tracked with the same `spendFromTokens`/ceiling-status shape `keryx
  review budget` uses, `src/review/caps.ts:270-334`) is exposed as `keryx
  routing budget`; once exceeded, `JevTaskClassifier` fails closed to "no
  classification" with a named reason, never blocking the caller's own
  turn.
- AC8: A sandboxed/unattended caller of `JevTaskClassifier` refuses with a
  named reason (never a silent skip) unless `openrouter.ai` is present in
  that run's network allowlist (`src/harness/process/sandbox/
  unattended.ts:59-68`), proven by a test against the allowlist shape.
- AC9: `keryx routing explain` (Flow B AC4) reports `source: "jev"` and
  Jev's `usage`/latency when the Jev classifier answered, and the TUI/CLI
  share one formatter for these fields (no drift between what `explain`
  prints and what the TUI modal shows once Flow D adds it).
- AC10: CI is green; `keryx health run` passes; no test anywhere in this
  flow makes a real network call.

Tasks:
- T1 (S): `decision-port.ts` types.
- T2 (M): `jev-decision-port.ts` — request/response mapping, budget guard,
  timeout/abort.
- T3 (M): `jev-classifier.ts` — question design, confidence gating,
  fallback chain wiring.
- T4 (M): redaction integration (AC6) + `keryx routing budget` (AC7).
- T5 (S): sandbox allowlist refusal (AC8).
- T6 (M): tests for T2–T5 (injected fetch fixtures: success, malformed
  response, HTTP error, timeout, over-budget, low-confidence, disabled/
  unconfigured, sandboxed-without-allowlist).
- T7 (S): shared CLI/formatter update (AC9) + docs.

## Flow D — wider auto-routing + TUI visibility + metrics

Wires more call sites to classify automatically (rather than requiring an
explicit category or a manual `keryx routing explain`), and builds the
TUI surfaces PRD §11 requires plus the PRD §16 metrics. This is the flow
where `quick`/`coding`/`planning`/`docs` categories can first actually get
used automatically; `unattended` stays a Flow E-or-later candidate (open
question 4 below).

Draft acceptance criteria:

- AC1: At least one additional call site (recommend: the interactive
  main-agent turn's pre-dispatch hook, following the same "gated,
  cancellable, never blocking" shape as Flow B AC3) calls the configured
  classifier (Jev if enabled, else main-model, else none — PRD §9.4) when
  no explicit category/model was given for that turn, and applies the
  resolved category's table entry (Flow A) to the turn's provider/model
  choice.
- AC2: A `Routing` row is mounted in `sidebarTop` immediately after the
  existing `Model` row (`sb-model-k`/`sb-model-v`,
  `src/tui/tui-shell.ts:3857-3858`), via an exported
  `mountRoutingPanel(otui, renderer, parent, opts) -> {refresh, dispose}`
  (matches `mountGovernancePanel`'s shape,
  `.metaproject/flows/300-.../acceptance-criteria.md` AC1), showing the
  wired categories' current resolution compactly, row text within
  `SIDEBAR_TEXT_WIDTH`, theme-role colours only. Proven by a panel test
  over fixture tables.
- AC3: Whenever a turn or dispatch used a routed (non-`default`) category,
  a one-line summary appears — `routed to <provider>/<model> (<category>,
  <classifier>, <confidence>)` — as a toast or inline transcript note
  (PRD §11), proven by a test asserting the line's fields for a
  Jev-routed, a main-model-routed, and an explicit (no classifier) case.
- AC4: From that summary or from the `/routing` modal (Flow A AC4), the
  operator can override — for just the next call, or persistently (writes
  to the table via Flow A's `keryx routing set` path) — proven by a test
  that a persistent override changes the next automatic classification's
  outcome without re-classifying.
- AC5: `/routing` is registered in `ACP_TUI_ONLY_COMMANDS` and classified
  read-only in `classifyBusyDispatch` (matching the Governance/Triggers
  precedent, `.metaproject/flows/300-.../acceptance-criteria.md` AC8).
- AC6: With a fixture project holding a non-empty routing table, the
  existing shell smoke test (`shell-pty-launch.smoke.test.ts`) still finds
  `Model`, `Context`, `Tools`, `Status`, `Ready` on an 80x24 pty — the new
  section does not push existing chrome off a small terminal.
- AC7: Metrics per PRD §16 (category-agreement rate between classifiers,
  override rate per category, cost delta via `spendFromTokens`,
  classifier overhead, fallback rate) are computed from the per-turn
  routing-decision log AC3 writes — reported via `keryx routing report`
  (or folded into `keryx governance report`, operator's call — see open
  question 5) rather than a new bespoke analytics surface.
- AC8: Documentation (`docs/docs/cli-reference.md`, `README.md`, docs
  site, and this package's own docs) covers the `Routing` sidebar
  section, its modal, `/routing`, `keryx routing explain`/`report`, and
  which categories are auto-routed as of this flow.
- AC9: CI is green; `keryx health run` passes.

Tasks:
- T1 (M): auto-routing hook for the chosen additional call site (AC1).
- T2 (M): `mountRoutingPanel` (AC2).
- T3 (M): per-turn routing-decision log + toast/transcript summary (AC3).
- T4 (M): override affordance wired to Flow A's table-write path (AC4).
- T5 (S): `/routing` command registration + busy-dispatch classification
  (AC5).
- T6 (S): smoke-test non-regression check (AC6).
- T7 (M): `keryx routing report`/metrics wiring (AC7).
- T8 (M): tests for all of the above.
- T9 (S): docs.

## Cross-flow dependencies

Flow A -> Flow A2 -> Flow B -> Flow C -> Flow D, strictly in that order:
Flow A2 extends the exact `resolveCategory`/table/CLI/modal Flow A ships
with a `derived` rung and profile display, so it cannot start before Flow
A's T1–T4 land; Flow B's `TaskClassifier` interface is designed once a
table (with or without Flow A2's derived layer) exists to feed it into;
Flow C is a second implementation behind the same interface; Flow D is the
only flow that makes classification *automatic* anywhere, so it depends on
both a working classifier (Flow B at minimum, Flow C for the richer
option) and the table it applies the result to (Flow A/A2). Flow A itself
has an internal order: the table/config/CLI (T1–T3) before the TUI modal
(T4) before the two call-site integrations (T5–T6), since the modal and
the CLI are two independent ways to exercise the same `resolveCategory`
function T1 ships. Flow A2 could, in principle, ship in parallel with
Flow A's T5–T6 (the review/subagent wiring) once Flow A's T1–T4 are done,
since profile discovery does not touch either call site directly — but is
listed strictly after Flow A here for a simpler, one-thing-at-a-time
review.

## Test strategy

- **No real network calls anywhere in this package's tests.** Every
  `JevDecisionPort` test injects `fetch` (a stub returning scripted
  responses/errors/timeouts), matching the existing pattern in
  `src/harness/provider/anthropic/anthropic-provider.test.ts` and
  `src/commands/providers.cross-family.test.ts`. `MainModelTaskClassifier`
  tests inject a stub `ProviderPort`, never a real session provider.
- Redaction (Flow C AC6) is tested with planted secret/PII fixtures
  against the existing `src/security/detect/*` test fixtures' shapes, not
  new ad hoc patterns.
- Subagent-spawn wiring (Flow A AC6/AC7) reuses `model.test.ts`'s existing
  fail-closed gate test fixtures (`allowedProviders`, `policy`,
  `providerClass`) so the category-resolved request is tested against the
  SAME denial cases as `"explicit"`/`"tier"`, not a parallel fixture set.
- TUI panel/modal tests follow `governance-panel.test.ts`/
  `triggers-panel.test.ts`'s fixture-project + `otui.testing` pattern.
- A `runTier`/`review tier` regression test with an empty routing table
  must reproduce byte-identical output to pre-Flow-A behavior, guarding
  against silent behavior change for operators who never touch `/routing`.
- Flow B/C classifier tests cover, at minimum: success, unparseable/
  malformed response, timeout, network/provider error, low confidence,
  and "classifier not configured" — one test per failure mode, none
  touching the network.
- Flow A2's `deriveDefaultTable` (PRD §6.3) is a pure function tested
  without any fetch/provider stub at all: one-model provider; several
  models with known (reported/curated) prices; several models with
  guessed prices and/or `unknown` fields; an unavailable model excluded
  from candidates; and a per-user override winning over a derived entry
  for the same category. `refreshModelProfiles` itself is tested with an
  injected `/models` response fixture (with and without `pricing`/
  `context_length` present, and with a shrunk/grown model list across two
  calls to exercise availability marking), never a real network call.
  Auto-priority (PRD §6.1) is tested as its own pure function: ordering by
  known price, the fixed sentinel for `unknown`, and an operator-set
  priority surviving a refresh that would otherwise recompute it.

## Open questions for the operator

1. **"Provider default" semantics** (PRD §5, §15): is repurposing
   `OPENAI_COMPAT_PROVIDERS[].models[0]` as each compat provider's
   "default model" acceptable, or should each registry entry gain an
   explicit `defaultModel` field (mirroring `OLLAMA_COMPAT_IDENTITY`)
   before Flow A ships?
2. **Where a `/routing` modal write lands**: this plan assumes a modal
   edit always writes to the per-user layer (never silently rewriting the
   checked-in project file from an interactive session). Confirm, or
   specify when a project-layer write should be reachable from the modal
   too (e.g. a `--project` toggle inside the modal itself).
3. **Confidence threshold default (0.6)**: chosen arbitrarily in this
   draft, shared by both classifiers — should Jev and the main-model
   classifier have independently tunable thresholds, given they likely
   have different reliability profiles?
4. **`unattended` category timing**: PRD §4 scopes it to a future
   authoring-time "let the table decide" flow for schedules/`flow-next`,
   since a dispatch's `rates`/model are otherwise required at authoring
   time today (`src/trigger/config.ts:561-564`). Should this be Flow D's
   scope, or pushed to a separate follow-up package entirely?
5. **Metrics surface** (Flow D AC7): fold into `keryx governance report`,
   or a new `keryx routing report`? This plan defaults to a new
   subcommand to avoid entangling routing's own release cadence with
   governance's, but either is a small change.
6. **Jev version pin**: `jev-1.13` vs. `jev-latest` — recommend defaulting
   to `jev-1.13` (fixed, reproducible) with `jev-latest` as an opt-in
   override (Flow C). Confirm this default is acceptable.
7. **Which additional call site for Flow D AC1**: this plan recommends the
   interactive main-agent turn as the first auto-classified surface (it is
   the highest-volume, most visible place classification would matter),
   but the operator may prefer starting with scheduled/`flow-next`
   authoring instead, or a different subagent path. Needs a decision
   before Flow D is scheduled.
8. **Cross-provider derivation** (PRD §6.3, §Non-goals): confirmed out of
   scope for v1 per the operator's own suggestion (derive from the
   session's current provider only). Worth revisiting once there is usage
   data showing operators keep multiple providers connected where none of
   them, alone, has a good `planning`/`quick` spread.

**Answered** (2026-09-25, captured as PRD §6/§17 requirements — kept here
only as a changelog, not as open items):

- *Curated table starting scope*: seeded with exactly Anthropic, OpenAI,
  and Gemini (PRD §6.1); the catalogue grows with every connected
  provider's discovered profiles (R22). Per-gateway coverage of
  `pricing`/`context_length` beyond OpenRouter is resolved architecturally
  — parsing is generic and opportunistic per field, no gateway allowlist,
  so nothing blocks on checking each gateway individually (PRD §6.1's
  `reported` bullet).
- *`priority` field provenance*: auto-computed from price on every
  creation/refresh unless operator-set (PRD §6.1 "Auto-priority", R23); a
  user-set priority is never overwritten.
- *Refresh behavior for models that disappear*: marked `available: false`
  and kept, never deleted; routing entries pointing at them fall back to
  the next precedence layer and show it (PRD §6.2, R24–R26).
