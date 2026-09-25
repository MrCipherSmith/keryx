# Keryx Task Router — PRD

Version: 0.4.0 (draft — reworked per operator direction, 2026-09-25)
Base: `origin/main` @ `e04715a2`, keryx `0.2.161`
Branch: `docs/jev-prd` (draft PR #701)

## 1. Problem

Keryx today has no way for an operator to say "reviews run on model X,
quick edits run on model Y, everything else runs on whatever the session
is on." It has exactly one hand-written, single-purpose version of this
idea — `assignTier`/`decideDispatchModel` in
`src/gdskills/model-tier.ts:656-767`, surfaced as `keryx review tier`
(`src/commands/review.ts:767-808`) — which computes a `light`/`standard`/
`deep` tier from review-specific signals (diff size, finding count,
verifier method) and then ranks the session's already-detected models
against that tier. It is scoped to the review pipeline alone, its
thresholds are code, not configuration, and nothing outside review reads
it. Subagent spawning has a *narrower* mechanism still: a child either
inherits the parent's model verbatim or the dispatcher names an explicit
provider/model/tier (`ChildModelRequest`, `src/harness/child/model.ts:43-46`,
resolved by `resolveChildModel`, `model.ts:156-`) — there is no operator-
facing "this kind of task goes to this model" setting anywhere. Keryx also
does not know anything about a MODEL beyond its id: it cannot say whether
`deepseek-chat` is cheaper or weaker than `deepseek-reasoner`, or what
either actually costs (§6).

The first thing keryx needs, before anything about TypeSafe's Jev matters
at all, is that missing piece of infrastructure: **a user-configured
routing table that maps a task category to a model**, independent of any
classifier. Only once that table exists does it make sense to ask "what
decides which category a given task falls into" — which is where Jev (and,
failing that, a cheaper local classifier) comes in as one *pluggable*
answer to a question the table itself does not depend on.

## 2. Goals

1. Ship the **routing table** first: category -> `{provider, model}` (or
   "provider default", or "session default"), configurable per user and/or
   per project (§5), with a CLI (§8) and a TUI `/routing` modal (§7) to
   read and edit it.
2. Ship a **flat, searchable, filterable model list** across every
   connected provider for picking a category's model — no "pick a provider
   first, then a model" two-step (§7).
3. Define a **small, code-grounded set of task categories** (§4), marking
   which are actually wired to a real call site in v1 and which are
   catalogue entries for later (§4, PLAN.md Flow A).
4. **Discover what keryx can honestly know about each connected model** —
   strength, price, context length (§6) — and use it to **build a sensible
   default routing table automatically** when the operator has not
   configured one themselves (§6.3).
5. Make **category classification** — "which category does this task
   belong to" — a **pluggable, optional** decision, with three tiers of
   fallback: Jev (via a `DecisionPort`, §9) -> the session's own main
   model (a cheap structured call, §9) -> today's behavior (the `default`
   category, no classification at all) (§9).
6. Make the **review** category the single source of truth the review
   pipeline (`keryx review tier`) and the sibling Jev-review-triage design
   (`docs/requirements/keryx-jev-review/`) both read — one config, not two
   competing model choices for review (§10).
7. Keep every routing decision **visible, explainable, and overridable** in
   the TUI (§11) and the CLI (§8), fail-closed to today's behavior on any
   classifier error, timeout, or low confidence (§9.4).

## Non-goals (this version)

- Replacing `assignTier`'s within-category tier arithmetic
  (light/standard/deep ranking against the session's own model,
  `model-tier.ts:656-767`). That stays exactly as it is for ranking a
  concrete model *inside* whatever provider/model the `review` category
  resolves to; this design sits one level above it (which model/provider a
  category uses at all), not a replacement.
- Auto-classifying every main-agent interactive turn in v1. Flow A ships
  the table with categories chosen *explicitly* by call site (the review
  pipeline always asks for `review`; `spawn_subagent` always asks for
  `subagents` unless the dispatcher named something more specific).
  Automatic, per-turn classification is Flow B/C/D (see PLAN.md).
- Training or fine-tuning any classifier model. Jev is a hosted,
  pre-trained decision model; the main-model classifier reuses whatever
  provider/model the session is already running.
- Routing `/delegate`'s external-agent-CLI dispatch
  (`src/commands/agent-commands.ts:255-263`) — a different agent binary,
  not a model choice in keryx's own provider layer.
- Redesigning `/model`/`/provider`/`/connect`'s existing two-step
  provider-then-model pickers (`selectProviderModelInTui`,
  `pickModelInTui`, `src/tui/tui-shell.ts:3070-3165`) — those stay as they
  are for "change the session's own model"; `/routing`'s flat list (§7) is
  a new, additional picker for a different job (assign a category, not the
  live session).
- **Cross-provider derivation** (§6.3): deriving a default table using
  models from a provider OTHER than the session's own current provider.
  v1 derives from the session's own provider only; the operator's own
  suggestion, adopted here — see PLAN.md open questions.

## 3. Users and scenarios

**Primary user**: the operator who has connected 2+ providers of different
cost/strength (`configuredProviders`, `src/commands/providers.ts:1031-1044`)
and wants different kinds of work to land on different models without
manually running `/model` before every turn.

- **Scenario A — set up the table once.** The operator opens `/routing`,
  sees every category already carrying a sensible auto-derived model from
  their connected provider (§6.3), picks a cheaper model for `quick` and a
  stronger one for `planning` where the derived guess is not what they
  want, closes the modal. No classifier involved yet.
- **Scenario B — review dispatch reads the table.** `keryx review tier`
  and the review pipeline's dispatch step resolve the `review` category
  from the table (§10) instead of only ranking against the session's own
  model, the same way the sibling `keryx-jev-review` package's triage
  design reads it too.
- **Scenario C — subagent spawn reads the table.** `spawn_subagent`
  resolves the `subagents` category from the table when the dispatcher
  named nothing more specific, instead of plain parent inheritance.
- **Scenario D — classified routing (Flow B/C).** Once a classifier is
  configured, a task description is classified into one of the catalogue
  categories (§4) and the table's entry for that category is used —
  visible in the TUI as "routed to X (category, classifier, confidence)"
  (§11), always overridable.

## 4. Task categories

Proposed catalogue, grounded in where keryx already makes (or could make)
a task-shaped model decision. **Wired in v1 (Flow A)** means an existing
call site is changed to resolve its model from this category today,
independent of any classifier; the others are catalogue entries the table
supports and the TUI/CLI can set, ready for Flow D to wire up, but nothing
currently reads them automatically.

| Category | Meaning | Wired in v1? | Grounding |
|---|---|---|---|
| `default` | The session's currently selected provider/model — the fallback every other category resolves to when unset. | Always (this is today's behavior; nothing to wire). | The existing session selection (`/model`, `/provider`, `sel.provider`/`sel.model` in `src/tui/tui-shell.ts:3858`). |
| `review` | The model the review pipeline dispatches on and the model review's own verification/confirmation reads. | **Yes.** | `keryx review tier` (`src/commands/review.ts:767-808`); shared with `docs/requirements/keryx-jev-review/`. |
| `subagents` | The model a `spawn_subagent` child uses when the dispatcher named no explicit provider/model/tier. | **Yes.** | `ChildModelRequest{kind:"inherit"}` today falls through to plain parent inheritance (`src/harness/child/model.ts:156-`); this category becomes a new resolution rung ahead of that fallback. |
| `quick` | Light, mechanical, low-risk tasks (renames, small fixes, one-line edits). | No (catalogue only). | Mirrors the existing `light` tier concept and its `LIGHT_MAX_FINDINGS`/`LIGHT_MAX_DIFF_LINES` thresholds (`model-tier.ts:625-627`). |
| `coding` | Main-line implementation/coding work. | No (catalogue only). | The common case main-agent turns are not currently distinguished from any other turn. |
| `planning` | Architecture, design, multi-step planning, deep reasoning. | No (catalogue only). | Mirrors the existing `deep` tier. |
| `docs` | Documentation and writing tasks (this very package is an example). | No (catalogue only). | Not currently distinguished from `coding` anywhere in keryx. |
| `unattended` | Scheduled tasks and `flow-next` dispatches that do not pin their own provider/model at authoring time. | No (catalogue only — see PLAN.md open question 4). | Today every schedule/`flow-next` dispatch is REQUIRED to carry its own `rates.inputUsdPerMTok`/`outputUsdPerMTok` and (implicitly) its own provider/model at authoring time (`src/trigger/config.ts:561-564`); this category is for a future authoring-time "let the table decide" path, not a live runtime override of an already-fully-specified dispatch. |

The category enum itself (`ROUTING_CATEGORIES` — planned constant, mirrors
`MODEL_TIERS` at `model-tier.ts:87`) ships complete in Flow A regardless of
which categories are wired, so the table, the TUI modal, and the CLI never
need a second migration when Flow D wires up `quick`/`coding`/`planning`/
`docs`/`unattended`.

## 5. Configuration: where the table lives

Two layers, same precedence pattern keryx already uses for shell config vs.
project config (`shell-config.ts` for per-user persisted picks,
`.metaproject`-adjacent JSON for per-project policy like
`security.config.json`/`health.config.json`):

- **Per-project**: `routing.config.json` at the project root (sibling to
  `.metaproject/security.config.json`) — checked in, shared by everyone
  working on the project, the natural home for "this project's reviews run
  on model X."
- **Per-user**: an entry in the user's persisted shell config (alongside
  `openrouterKey`/`apiKeys` in `shell-config.ts`) — a personal override, not
  shared, for an operator who wants their *own* `quick` category on a
  cheaper personal account regardless of what the project recommends.

**Precedence** (the operator's decision, 2026-09-25: the user's table is the
general default and a project overrides it): **explicit per-call override**
(§9.5) > **per-project config** > **per-user config** > **`default`
category** (today's session model, unconditionally available with nothing
configured). A user sets their routing once, in their own config, for every
project; a project that needs something different — a stronger review
model, a provider its CI can reach — states it in `routing.config.json`,
and that wins inside that project. A project entry that names a provider or
model the user has not connected falls through to the user's entry for that
category (and the modal says so), rather than failing the call.

§6 adds one more rung to this chain, between per-user config and the bare
`default` category — a `derived` table keryx builds itself when the
operator has configured nothing: **explicit > per-project > per-user >
derived (§6.3) > `default`**.

Open question: whether a user should also be able to pin a category *over*
a project's choice for their own interactive sessions (the reverse order).
Not in v1.

Table shape (both layers, same schema):

```json
{
  "categories": {
    "review": { "kind": "model", "providerId": "anthropic", "modelId": "..." },
    "quick": { "kind": "provider-default", "providerId": "deepseek" },
    "subagents": { "kind": "session-default" }
  }
}
```

- `"kind": "session-default"` — the category is unset; resolves to
  whatever the session's own model is (today's behavior). This is the
  default for every category the operator has not touched, before §6's
  `derived` layer improves on it.
- `"kind": "model"` — an explicit `providerId`/`modelId` pair, picked from
  the flat list (§7).
- `"kind": "provider-default"` — pins a *provider* without pinning an
  exact model id. Resolves to that provider's own notion of a default
  model: `OLLAMA_COMPAT_IDENTITY.defaultModel.modelId` for `ollama`
  (`src/harness/provider/make-provider.ts:34-40`, the only provider with a
  documented default today), or the first entry of that provider's curated
  `models` list for a compat-registry entry (`OPENAI_COMPAT_PROVIDERS[].
  models[0]`, `src/commands/providers.ts:310-`, itself explicitly
  documented as "a fallback only" ahead of a live `/models` fetch,
  `providers.ts:305-308`) when nothing more specific has resolved.
  Confirm this rule before Flow A ships (PLAN.md open question 1) — it
  repurposes a field that was not designed for this.

## 6. Model profile discovery and derived default routing

This is the piece that makes an unconfigured routing table useful on day
one, rather than every category simply reading `session-default` until the
operator does the work of §5/§7 by hand.

### 6.1 Model profiles: what keryx records, and where each field honestly comes from

Every provider offers several models today (`OPENAI_COMPAT_PROVIDERS[].
models`, `providers.ts:310-`), but keryx does not currently know anything
about a MODEL beyond its id. Both places that already learn a provider's
live model list — `fetchOpenAiCompatModelsDetailed`
(`src/commands/providers.ts:613-671`, the general model-list fetch) and
`testProviderConnection` (`providers.ts:838-845`, the `/connect` `[Test]`
button and its `keryx providers test` CLI parity, flow 304) — call the
SAME underlying function, and today it extracts only `id`/`name` from each
entry in the response body (`providers.ts:644-658`); any `pricing`/
`context_length` fields a gateway returns are read off the wire and then
discarded. This section adds a **model profile** record per
`<providerId>/<modelId>`, captured/refreshed at exactly those two call
sites:

```ts
// src/harness/routing/model-profile.ts (new)
export type ProfileSource = "reported" | "curated" | "guessed" | "operator" | "unknown";
export type PrioritySource = "auto" | "operator";

export interface ModelProfile {
  providerId: string;
  modelId: string;
  strengthTier: { value: "light" | "standard" | "deep"; source: ProfileSource };
  priceInputPerMillion: { value: number; source: ProfileSource } | { value: "unknown"; source: "unknown" };
  priceOutputPerMillion: { value: number; source: ProfileSource } | { value: "unknown"; source: "unknown" };
  contextLength: { value: number; source: ProfileSource } | { value: "unknown"; source: "unknown" };
  priority: { value: number; source: PrioritySource };
  /** False once a live fetch no longer lists this model (§6.2) — the profile is kept, not deleted. */
  available: boolean;
  /** Last time this model was present in a live fetch (updates only while `available`). */
  lastSeenAt: string;
  refreshedAt: string;
}
```

Field provenance, in the order each is tried, honestly:

- **`reported`** — read directly off the gateway's own `/models` response,
  when it carries the field. OpenRouter's `GET /api/v1/models` is
  confirmed (2026-09-25, via its own API reference plus independent
  documentation of the same shape) to return a `context_length` integer
  and a `pricing: {prompt, completion, ...}` object (string USD-per-token
  values) per model entry — a strictly richer body than the `id`/`name`
  pair keryx reads today. Capturing these means EXTENDING
  `fetchOpenAiCompatModelsDetailed`'s parsing, not reusing existing
  plumbing — the fields exist on the wire today for OpenRouter and are
  simply unread. Parsing is OPPORTUNISTIC and generic, not OpenRouter-
  specific: whatever gateway a provider's `/models` response comes from,
  keryx reads `pricing`/`context_length` when present and falls through to
  `curated`/`guessed`/`unknown` per field when absent — no gateway
  allowlist to maintain. Whether the standard OpenAI-compatible `/v1/models`
  shape other compat gateways in the registry speak (DeepSeek, Z.AI,
  Cerebras, Groq, Moonshot, Grok, …) actually carries these fields is
  unverified per gateway (checked opportunistically as each is connected,
  not blocking this design).
- **`curated`** — a small, hand-maintained price/context/tier table keryx
  ships with, seeded with **Anthropic, OpenAI, and Gemini only** (the
  operator's decision, 2026-09-25) — the exact three providers keryx
  already hand-maintains a model-ID list for and nothing more
  (`ANTHROPIC_MODELS`/`OPENAI_MODELS`/`GEMINI_MODELS`,
  `src/commands/select.ts:75,84,93`), and the exact three that go through
  their own native `ProviderPort` adapters rather than the OpenAI-compat
  `/models` fetch (`make-provider.ts:88-113`) — so they have no live
  pricing/context source at all today and a hand-maintained table is the
  ONLY way to profile them beyond a `guessed` tier. **The catalogue is not
  static**: it MUST grow as providers are connected. When any provider
  connects — built-in or a custom `llm-providers.json` entry — its
  discovered model profiles (reported pricing/context where the gateway's
  `/models` response carries them, `guessed` tier otherwise) are added to
  the operator's own model catalogue (§6.2) alongside the three curated
  seed entries. The catalogue an operator actually has, at any point in
  time, is therefore "curated seed plus everything discovered so far" —
  never only the seed, and never something keryx invents beyond what was
  either hand-curated at v1 or actually observed on a connected provider.
  Each field keeps its OWN source as it was captured (a DeepSeek model
  discovered with a `guessed` tier and `unknown` price stays exactly that
  — it is never later relabeled `curated` just because it sits beside
  Anthropic's curated entries in the same store).
- **`guessed`** — a name-pattern heuristic, for **strength tier only**,
  never for price: a wrong guessed price is worse than an admitted
  unknown. Reuses `MODEL_RANK_HINTS`/`rankModelId`
  (`src/gdskills/model-tier.ts:205-258`) verbatim rather than inventing a
  second regex table: its existing vendor-neutral size words (`nano`/
  `tiny`/`mini`/`lite`/`small`/`flash`/`haiku`/`instant`/`air` -> negative
  weight; `sonnet`/`medium` -> weight 0; `opus`/`pro`/`large`/`max` ->
  positive weight; `ultra` -> +2) already encode exactly the
  mini/flash/haiku/lite -> light, pro/opus/large -> deep mapping the
  operator asked for. Mapping: rank `< 0` -> `light`, rank `0` ->
  `standard`, rank `> 0` -> `deep`; `undefined` (no hint matched at all) ->
  `standard`, marked `guessed` with a note that it is a bare default, not
  even a guess.
- **`operator`** — the operator set this field themselves (`/routing`
  modal, §7, or `keryx routing profile set`, §8). An `operator`-sourced
  field is NEVER overwritten by a later refresh (§6.2) until the operator
  explicitly clears it — this replaces a separate "overridden" flag with
  the same per-field `source` tag every other provenance already uses, so
  "who last touched this field" is always one place, not two.
- **`unknown`** — used ONLY for price/context, never silently coerced to
  `0` or a made-up number: a model with no reported, curated, or
  operator-set price is `"unknown"`, exactly as the operator specified, so
  any caller doing cost math treats it as "cannot compute", not "free."

### Auto-priority

`priority` is a plain ordering number (higher wins a tie). Unless the
operator has set one (`source: "operator"`, never overwritten by a later
refresh, same rule as every other field), keryx computes it automatically
— **both on first connection and on every refresh** (the operator's
decision, 2026-09-25):

```
priority.value = known price(priceInputPerMillion) ? -priceInputPerMillion.value
                                                     : PRIORITY_UNKNOWN_PRICE  // a fixed, documented sentinel below every known price
```

i.e. **the cheaper a model's known input price, the higher its
auto-priority**; a model with an `unknown` price sorts below every
model keryx has a real number for. Justification:

- It reproduces the operator's own example directly: among several
  `light`-tier candidates for `quick`/`subagents`/`docs`, the auto-priority
  order already puts the cheapest first — because §6.3's derivation
  compares price BEFORE priority for those categories, priority's
  cheaper-first rule simply agrees with, rather than fights, that
  comparison, so the two never produce a contradictory answer.
- It does not fight §6.3's `planning`/`review` preference for the
  STRONGEST model either: priority there is consulted only after tier and
  price have both already been compared and still tied — preferring the
  cheaper of two otherwise-equally-ranked strong models in that residual
  case is still the cost-conscious, defensible default, not a contradiction
  of "prefer strength."
- One rule, not two tier-conditional rules (a "prefer cheap" rule for
  light tiers and a mirrored "prefer expensive" rule for deep tiers) —
  the same "uniform rule over tier-conditional special-casing" reasoning
  §6.3 already applies to its own category grouping.
- An `unknown`-priced model sorting last (rather than, say, in the middle)
  is consistent with §6.1's own "unknown is never treated as good news"
  stance — keryx has no basis to prefer a model it cannot price over one
  it can.

### 6.2 Storage, refresh, and availability

Profiles are stored **per user**, next to the existing per-user provider/
credential state (`src/lib/shell-config.ts`, alongside `apiKeys`/
`modelParams`/`openrouterKey`) — not per-project: a model's price and
context length are facts about the vendor, not about this project, and two
operators on the same project may have different credentials (hence
different actually-reachable models) anyway. A profile is (re)computed
whenever a provider's model list is (re)fetched: on first connect, and on
every `/connect` `[Test]` refresh (`testProviderConnection`) or `keryx
providers test` run — the same trigger points that already call
`fetchOpenAiCompatModelsDetailed` today, extended to also update the
profile store rather than adding a third, separate refresh path.

A refresh is a DIFF against the profiles already stored for that provider,
never a wholesale replace (the operator's decision, 2026-09-25):

- A model id present in the new live list but not previously stored gets a
  fresh profile (curated/reported/guessed per §6.1), `available: true`.
- A model id present in both gets its non-`operator`-sourced fields updated
  (price/context/tier may have changed; `guessed`/`reported`/`curated`
  fields refresh freely) while every `operator`-sourced field — including
  a manually set `priority` — is left untouched; `available` stays `true`
  and `lastSeenAt` advances.
- A model id previously stored but ABSENT from the new live list is marked
  `available: false` — its profile (including any operator overrides) is
  KEPT, not deleted, so a routing entry that still points at it, and the
  reason it stopped resolving, both stay inspectable (§6.3, §7).
- A routing table entry (explicit, per-project, per-user, or derived —
  §5, §6.3) whose resolved model is `available: false` is treated as
  UNRESOLVED at that layer, and resolution falls through to the next layer
  in the precedence chain exactly as if that layer had configured nothing
  for the category — an unavailable model is never silently dispatched to.
  `/routing` and `keryx routing list` show this as `<provider>/<model> —
  unavailable, falling back to <resolved>` (§6.4, §7).

### 6.3 Derived default routing (the `derived` precedence layer)

When the operator has not configured a category themselves, keryx builds
one from the CURRENT SESSION PROVIDER's own model list and their profiles
(§6.1), rather than leaving every category on the literal session model
forever. This is the new `derived` rung in §5's precedence:

**Precedence** (repeated from §5 for context): **explicit per-call
override** (§9.5) > **per-project config** > **per-user config** >
**derived** (this section) > **`default` category** (the bare session
model, used only when derivation itself cannot run — e.g. provider
detection failed, or produced no comparable candidate).

Derivation rule, run against the session's own provider's AVAILABLE models
only (`available: true`, §6.2) and only in v1 against the session's own
provider (see §Non-goals and PLAN.md open questions for cross-provider
derivation):

- **One model**: that model is the derived entry for EVERY category,
  `quick` through `unattended` alike — there is nothing to differentiate,
  so nothing is guessed. This is the operator's literal wording: "if the
  provider has only one model, it becomes the default for every category."
- **Several models** — partitioned by category intent, not by one global
  rule:
  - `quick`, `subagents`, `docs` -> the **lightest, cheapest** model
    (lowest `strengthTier`, tie-broken by lowest `priceInputPerMillion`,
    then highest `priority.value`). These are the high-volume, low-stakes,
    mechanical categories — small edits, parallel subagent work,
    documentation — where a wrong choice costs little, and routing them
    cheap is the single largest aggregate-spend lever available.
  - `planning`, `review` -> the **strongest** model (highest
    `strengthTier`, tie-broken by highest `priceInputPerMillion` as a
    capability proxy when tier ties, then highest `priority.value`). These
    are the
    low-volume, high-stakes categories — a missed finding, a bad
    architecture call — where the cost of a MISTAKE dominates the cost of
    the call, and they run far less often than `default`/`coding`, so
    paying more per call barely moves total spend.
  - `default`, `coding` -> the **session's own model**, unchanged. These
    are the bulk of everyday work — in effect "whatever the operator is
    already running" — so derivation does not second-guess the operator's
    own considered choice of session model for the common case; it only
    fills in the categories the operator has not thought about.
  - A model whose profile is entirely `unknown` (no reported/curated/
    guessed price and an unranked name) is EXCLUDED from the "lightest"/
    "strongest" comparison rather than winning it by an arbitrary
    tie-break; if that leaves no comparable candidate for a category, the
    session's own model is used for that category too, same as the
    one-model case.
- Every field this rule reads carries its `source` (§6.1) forward into the
  derived entry's explanation (§6.4), so "auto-derived, using a *guessed*
  tier" and "auto-derived, using a *reported* price" read as visibly
  different confidence levels, not the same claim.

### 6.4 Visibility

A derived entry is shown in `/routing` (§7) as `auto (derived from
<provider>'s models)` per category — distinct from `session default`
(nothing computed) and from an explicit `<provider>/<model>` (the operator
chose it) — until the operator overrides that category, at which point it
becomes an explicit entry and derivation no longer applies to it. The flat
model picker (§7) also shows each model's profile — tier, price, context
length, priority, and the source of each — so an operator deciding whether
to accept or override a derived entry can see WHY it was picked. A model
marked `available: false` (§6.2) is shown struck through or greyed in the
flat picker (still selectable, since an operator may knowingly want to
point at a model they expect to come back) with an explicit `unavailable`
label; a category CURRENTLY resolving to an unavailable model shows the
fallback it landed on instead (§6.2). The `/connect` `[Test]` result (and
`keryx providers test`) mentions when a refresh updated stored model
profiles — how many were added, how many changed, how many newly went
unavailable — since that is the moment a derived entry, or an explicit one
pointing at a now-vanished model, can silently change underneath the
operator.

## 7. `/routing` TUI modal

`/routing` (new agent-mode-only slash command, registered in
`AGENT_SLASH_COMMANDS`, `src/commands/agent-commands.ts:61-`) opens a
list+detail modal through `modal-host`, same construction as the
Governance/Triggers modals
(`.metaproject/flows/300-2026-09-23-tui-sidebar-and-modals-for-the-governanc/acceptance-criteria.md`
AC3/AC5):

- The list side shows every category from §4, each with its current
  resolution — `session default`, `auto (derived from <provider>'s
  models)` (§6.4), `<provider>/<model>`, or `<provider> (provider
  default)` — and whether it is wired in v1.
- Selecting a category and pressing Enter (or a dedicated key) opens the
  **flat model picker**: ONE searchable/filterable list spanning every
  currently connected provider's models, built the same way
  `pickModelInTui`'s existing type-to-filter list already works
  (`mountFilterList`, `src/tui/tui-shell.ts:3070-3165`, ↑/↓/Enter native,
  printable keys filter live) — except its `items` are
  `"<providerId>/<modelId>"` strings flattened across every entry
  `detectProviders()` returns (`src/commands/select.ts`,
  `DiscoveredProvider`, `model-tier.ts:148-153`) instead of one already-
  chosen provider's models. This is the concrete difference from the
  existing `/model`/`/provider` two-step pickers (§Non-goals): no "pick a
  provider first" screen. Each row also shows that model's profile (§6.1)
  — strength tier, price (or "unknown"), context length — and, where a
  field was guessed rather than reported or curated, a visible marker.
  - A "provider default" row per connected provider is included alongside
    every `provider/model` row for the "pin provider, not model" case
    (§5).
  - A "session default" row clears the category back to unset (which then
    falls through to `derived`, §6.3, if the operator has configured
    nothing else).
- Esc closes the modal; the table is written (per §5's precedence — a
  change made here writes to the per-user layer, per PLAN.md open
  question 2) as soon as a selection is confirmed, not on modal close.

## 8. CLI

`keryx routing <subcommand>`, mirroring `keryx providers`'s
list/test/remove shape (`src/commands/providers.ts:1065-1090`):

- `keryx routing list [--json]` — every category, its resolution
  (including `auto (derived from <provider>'s models)`, §6.4), its source
  layer (project/user/derived/default), and whether it is wired in v1.
- `keryx routing set <category> <provider>/<model>` — writes an explicit
  `{kind:"model"}` entry. `keryx routing set <category> <provider>` (no
  slash) writes a `{kind:"provider-default"}` entry.
- `keryx routing unset <category>` — clears back to `session-default`
  (from which `derived`, §6.3, applies again if nothing else is configured).
- `keryx routing explain "<task>"` — runs classification (§9) against the
  configured classifier (or reports "no classifier configured, would use
  the `default`/derived category" when none is set) and prints the
  category, confidence, the resolved provider/model for that category, and
  — for a Jev classification — usage/cost/latency (mirrors the CLI/TUI
  parity rule in §11). This subsumes the earlier design's standalone
  `keryx route explain` command — one CLI surface, not two.
- `keryx routing profile list [--json]` — every stored model profile
  (§6.1), its fields, each field's source, and its `available` status.
- `keryx routing profile set <provider>/<model> --tier|--price-in|
  --price-out|--context|--priority <value>` — an operator correction
  (§6.1), storing that field with `source: "operator"` so it is never
  overwritten by a later refresh.
- Every write subcommand supports `--user`/`--project` to target a layer
  explicitly, defaulting to `--user` (matching §5/PLAN.md open question 2).

## 9. The classifier: optional and pluggable

The routing table (§5, §6) answers "category -> model". Something must
decide *which category* a given task belongs to when the caller has not
already named one explicitly (the review pipeline and `spawn_subagent`'s
default path always name their own category explicitly in Flow A —
§Non-goals — so classification only matters once Flow B/C/D wire up call
sites that do not already know their category, e.g. an interactive
main-agent turn).

### 9.1 Classifier interface

```ts
// src/harness/decision/classifier.ts (new)
export interface TaskClassifier {
  classify(
    task: string,
    categories: readonly string[],
  ): Promise<
    | { ok: true; category: string; confidence: number; source: "jev" | "main-model" }
    | { ok: false; reason: string }
  >;
}
```

### 9.2 Jev classifier (`JevTaskClassifier`)

Used when the operator has connected Jev: `OPENROUTER_API_KEY` present AND
Jev explicitly enabled as the routing classifier (a `classifier: "jev"`
field in `routing.config.json`, §5). Built on a `DecisionPort` seam
(`src/harness/decision/decision-port.ts`, planned) that stays structurally
separate from `ProviderPort` (`src/harness/provider/types.ts:345-353`)
because Jev's typed noul/choice answers share no method shape with a
chat/completion stream — matching the codebase's existing narrow-seam
convention (`McpClientPort`, `ManagedFlowPort`, `WorktreePort`,
`ExternalSpawnPort`, `MetaprojectPort`). One question, one call: a
`choice` question whose `criteria` are exactly the wired category names
from §4, plus a `confidence` `noul` question. `JevDecisionPort` speaks
`POST https://openrouter.ai/api/v1/systemone` (confirmed against
OpenRouter's TypeSafe SDK guide, 2026-09-25 — see §13 for the full vendor-
fact list), reuses the same `OPENROUTER_API_KEY` resolution as the
`openrouter` compat-provider entry (`providers.ts:312-321`), and is
injected with `fetch` exactly like every other provider adapter (never a
real network call in a test).

### 9.3 Main-model classifier (`MainModelTaskClassifier`)

Used when Jev is not connected/enabled but classification is still wanted:
a small, cheap, structured call to the **session's own current model** —
"which one of these category names best fits this task? Answer with just
the name." Kept deliberately minimal:

- Single-token or short-JSON response, no streaming, no tools.
- A size cap on the task text sent (same order of magnitude as the `state`
  built for Jev, §12 below — a task description and nothing else).
- Only invoked when a caller actually asks for a classification (not on
  every turn speculatively) — same "opportunistic, gated, cancellable
  extra call" shape the existing next-step-suggestion feature already uses
  (`NextStepSuggestionGate`, `src/tui/tui-shell.ts:3737-3742`, flow 268
  AC14): a caller-invalidated, in-flight-deduplicated request, never
  stacked, never blocking the turn it was meant to inform.
- Costs whatever the session's own provider charges for a short
  completion — no new vendor relationship, no new credential (§12: the
  task text never leaves whatever provider the operator already trusts
  for their session).

### 9.4 Fallback

With neither classifier available (no Jev connection AND no main-model
classification attempted or it errored/timed out), classification is
skipped entirely and the `default`/`derived` category resolution is used —
exactly today's behavior, plus §6's improvement to it. Same fail-closed
contract throughout this design: any classifier timeout (default 2000ms),
network/parse error, or confidence below the configured threshold (default
0.6) is treated as "no classification", never a guessed category.

### 9.5 Explicit override always wins

A caller-named category (the review pipeline always names `review`;
`spawn_subagent` always resolves `subagents` unless the dispatcher gave an
explicit provider/model/tier) is never overridden by a classifier — the
classifier only runs when a caller has NOT already named a category, the
same short-circuit shape `resolveChildModel`'s explicit rung already has
over env/tier/inherit (`model.ts:161-`). An operator's manual override
from the `/routing` modal or `keryx routing set` (§7, §8) always wins over
any classifier's recommendation for that category's *table entry* (and
over a `derived`, §6.3, entry); per-turn, a `--model`/`--category` flag or
an explicit `/model` switch always wins over that turn's classification.

## 10. Review integration (shared with the sibling package)

`keryx review tier`'s dispatch-model computation
(`runTier`, `src/commands/review.ts:767-808`) resolves its model from the
`review` category (§4, wired in v1) instead of — or, during a transition,
alongside — its current live-detection-only ranking. The sibling
`docs/requirements/keryx-jev-review/` package's Jev-as-review-triage
design reads the SAME `review` category resolution from this package's
`routing.config.json`/per-user config (§5, including its `derived` entry
per §6 when nothing more specific is configured) rather than defining its
own separate model choice: one config decides "what model does review run
on," this package owns that config, and review-side packages are
consumers of it, not parallel authors of a competing setting.

## 11. TUI visibility (standing rule: sidebar + modal, every feature)

- **Sidebar**: a compact `Routing` row (or a short block, if a single line
  cannot hold it) mounted in `sidebarTop` after the existing `Model` row
  (`sb-model-k`/`sb-model-v`, `src/tui/tui-shell.ts:3857-3858`), showing
  the category -> model mapping compactly — e.g. wired categories only by
  default (`review`, `subagents`), each abbreviated to fit
  `SIDEBAR_TEXT_WIDTH`, marking a `derived` entry distinctly from an
  explicit one, with the full table one click away in the `/routing` modal
  (§7).
- **Per-turn visibility**: whenever a turn or dispatch actually used a
  routed (non-`default`) category, the TUI shows a one-line summary —
  `routed to <provider>/<model> (<category>, <classifier>, <confidence>)`
  — where `<classifier>` is `jev`, `main-model`, `derived` (no classifier
  ran; §6.3's table entry was used), or `explicit` (no classifier ran; the
  category was named directly by the call site), and `<confidence>` is
  omitted for `derived`/`explicit`. Shown as a toast or inline transcript
  note, consistent with how other background decisions (governance runs,
  trigger runs) already surface a toast on completion (flow 300 AC7).
- **Override affordance**: from that per-turn summary or from the
  `/routing` modal, the operator can override — either for just the next
  call (a session-scoped override) or persistently (writes to the table,
  §7/§8). Never silently discarded on the next automatic recommendation.
- **`/routing` modal**: see §7.

## 12. Cost, latency, and privacy

- **Privacy / redaction**: task text sent to `JevTaskClassifier` crosses a
  new vendor boundary (OpenRouter -> TypeSafe) and requires the same
  opt-in this design always required — connecting `openrouter` for chat
  use does not implicitly enable it as a classifier. The text is passed
  through `redactSensitiveText` (`src/security/redact.ts:128`) before
  assembly. `MainModelTaskClassifier` sends task text to whatever provider
  the session is already using for generation — no new vendor
  relationship, no additional redaction requirement beyond what the
  session already accepts by using that provider at all.
- **Cost**: Jev's own price ($0.042/M input tokens, output free — §13) is
  tracked with the same `spendFromTokens` ceiling machinery
  `keryx review budget` uses (`src/review/caps.ts:270-334`), as its own
  small ceiling separate from generation spend. The main-model
  classifier's cost is ordinary generation spend on the session's own
  model — accounted for as such, not separately.
- **Latency**: Jev's independently measured 0.33s median / 1.42s max
  (§13) sets the default classifier timeout at 2000ms; the main-model
  classifier's latency depends entirely on the session's own provider and
  is not separately budgeted.
- **Unattended sandbox egress**: a classification call from inside a
  sandboxed run crosses the same domain-allowlist boundary as before
  (`network: "allowlist"`, `src/harness/process/sandbox/unattended.ts:
  59-68`) — `openrouter.ai` (for Jev) must be an explicit allowlist entry;
  the main-model classifier needs no new allowlist entry since it targets
  whatever provider the run's own dispatch already reaches.

## 13. Jev facts (researched 2026-09-25; re-verify before Flow C)

Confirmed against OpenRouter's own TypeSafe SDK guide and one independent
blog post on 2026-09-25:

- `jev-1.13` / `jev-latest`, released 2026-09-15. `POST
  https://openrouter.ai/api/v1/systemone`, `Authorization: Bearer
  <OPENROUTER_API_KEY>`. Request `{model, state, questions:{key:{type,
  instructions, criteria?}}}`; response `{id, model, provider,
  answers:{key:{type, noul|choice}}, usage:{input_tokens, output_tokens,
  cost}}`.
- `noul` returns a probability 0..1; `choice` picks one of `criteria`. A
  `Score` type is mentioned by the vendor with no documented shape — not
  used by this design.
- Budget: 64k tokens, `state`+`questions` combined.
- Price: $0.042/M input tokens; output free.
- Latency: vendor claims 70–500ms; independent measurement (791 calls via
  OpenRouter): 0.33s median, 1.42s max.
- Vendor use cases: routing, classification, triage, agent oversight,
  context filtering — explicitly not generation, code review, long
  documents, or open-ended reasoning.

## 14. Prior art (brief)

- **RouteLLM** (`lm-sys/routellm`, arXiv:2406.18665) — trains small local
  routers (matrix factorization / BERT) on preference data; ~40% fewer
  strong-model calls at <5% MT-Bench degradation. Keryx's category table +
  pluggable classifier differs in kind: no training pipeline, an
  operator-authored table plus a swappable classifier (hosted Jev, or the
  session's own model) rather than one trained artifact.
- **OpenRouter Auto Router** — market-driven model selection over a
  trailing 7-day usage window across all of OpenRouter; different
  mechanism (aggregate market behavior vs. an operator's own declared
  category table) and different scope (any OpenRouter model vs. the
  operator's own connected set).

## 15. Risks and honest limits

- **Two classifiers can disagree with each other and with a human's
  intuition.** Mitigation: confidence threshold + fallback (§9.4),
  visibility (§11), and Flow A/B/C ship with classification off by
  default and only wired for categories where a caller already names its
  own category explicitly (no classification ambiguity possible yet).
- **"Provider default" repurposes a field not designed for this** (§5) —
  only `ollama` has a documented default model; every compat-registry
  provider's "default" is this design's own new interpretation of an
  existing curated-fallback list. Flag before Flow A ships (PLAN.md open
  questions).
- **A guessed strength tier can be wrong** (§6.1) — a vendor codename that
  carries no size word (e.g. a pure product name) is left `standard` by
  construction rather than mis-ranked, but a size word that does not
  correspond to actual capability for a niche or unfamiliar gateway would
  still mislead. Mitigation: `guessed` is used ONLY for tier, never price
  (an honest "unknown" is always safer than a fabricated cost), it is
  always visibly marked (§6.4), and the operator can correct it (§6.1).
- **A second vendor dependency** (OpenRouter + TypeSafe) is optional, not
  required — the table and Flow A/A2/B work with zero external dependency;
  only enabling `classifier: "jev"` (§9.2) introduces it, and §9.4's
  fallback keeps it from ever being a hard dependency for a turn to
  proceed.
- **Main-model classification is not free** — it is a real extra
  generation call against the session's own (possibly expensive) model,
  which could ironically cost more than just running the task on the
  default model would have, for a trivial task. Mitigation: only invoked
  when actually needed (§9.3), and the operator can disable classification
  entirely and rely on explicit per-call categories only (Flow A's
  baseline).
- **Vendor claims are unverified against a live key** — §13's latency/
  pricing figures are vendor and third-party-blog sourced as of
  2026-09-25, not measured by this team; confirm before committing to the
  2000ms timeout default.

## 16. Metrics

1. **Category-agreement rate** between the main-model classifier and Jev,
   where both run against the same task (useful for deciding whether the
   cheaper local classifier is "good enough" once there is field data).
2. **Override rate** per category — a high rate on a specific category is
   a direct signal that category's table entry, or its classification, is
   wrong. Split out the **derived-table override rate** (§6.3)
   specifically — how often an operator replaces an auto-derived entry
   rather than leaving it — since that is a direct signal on whether the
   light/strong-by-tier default heuristic is actually good, independent of
   classification.
3. **Cost delta**: generation spend with routing/classification enabled
   vs. a comparable window without, via `spendFromTokens`
   (`src/review/caps.ts:319-334`).
4. **Classifier overhead**: added latency/cost per classified turn,
   logged in the same per-turn record the TUI's "routed to..." line reads
   from (§11).
5. **Fallback rate**: how often §9.4's fallback fires per classifier —
   independent of whether the classifier's *answers* are good, this is
   whether it is reachable/fast enough to matter in practice.

## 17. Requirements (numbered, verifiable)

- R1: A routing table exists (`routing.config.json` at project root, plus
  a per-user layer in shell config) mapping each category from §4 to a
  `{kind: "session-default"|"model"|"provider-default", ...}` entry, with
  the precedence order in §5/§6.3 (explicit override > per-project >
  per-user > derived > `default`).
- R2: `keryx routing list|set|unset|explain|profile` (§8) exist, with
  `--json` on `list`/`explain`/`profile list`, and `--user`/`--project` on
  write subcommands.
- R3: `/routing` opens a TUI modal (§7) whose model picker is ONE flat,
  searchable/filterable list spanning every connected provider's models
  (via `detectProviders()`), built on the existing `mountFilterList`
  machinery (`src/tui/tui-shell.ts:3070-3165`) — never a two-step
  provider-then-model flow.
- R4: `keryx review tier`'s dispatch-model computation
  (`src/commands/review.ts:767`) resolves the `review` category from the
  routing table (R1), verified by a test that sets `review` to an
  explicit provider/model and asserts `runTier`'s output reflects it.
- R5: `spawn_subagent` resolves the `subagents` category from the routing
  table when the dispatcher named no explicit provider/model/tier,
  verified by a test, and the result still passes through
  `resolveChildModel`'s unmodified G1 (allowlist)/G2 (network-trust)/G3
  (classifiable) gates (`src/harness/child/model.ts:156-`) — a
  category-resolved provider outside the allowlist is denied exactly as
  an explicit out-of-allowlist request is today.
- R6: A `TaskClassifier` interface (§9.1) exists with `JevTaskClassifier`
  and `MainModelTaskClassifier` implementations and a documented,
  fail-closed "no classification" result on timeout/error/low confidence
  (§9.4) — no caller ever receives a guessed category.
- R7: Classification never runs for a caller that already named its own
  category (review, subagents in v1) — verified by a test asserting zero
  classifier calls in that path.
- R8: `JevTaskClassifier` makes exactly one `POST
  https://openrouter.ai/api/v1/systemone` call per classification, via
  injected `fetch`, reusing `OPENROUTER_API_KEY` resolution identical to
  the `openrouter` compat-provider entry; no test in this package makes a
  real network call.
- R9: `MainModelTaskClassifier`'s call is size-capped, gated (only runs
  when a classification is actually requested), and cancellable/
  deduplicated the same way `NextStepSuggestionGate` already is
  (`src/tui/tui-shell.ts:3737-3742`).
- R10: Task text sent to `JevTaskClassifier` is passed through
  `redactSensitiveText` (`src/security/redact.ts:128`) before assembly,
  verified by a test with planted secret/PII fixtures.
- R11: The TUI sidebar shows the wired categories' current resolution
  compactly after the `Model` row, distinguishing `derived` from explicit;
  a per-turn "routed to X (category, classifier, confidence)" line appears
  whenever a non-`default` category was actually used, both overridable
  per §11.
- R12: A sandboxed/unattended run refuses (named reason, never a silent
  skip) to call `JevTaskClassifier` unless `openrouter.ai` is in that
  run's network allowlist.
- R13: The sibling `docs/requirements/keryx-jev-review/` package's design
  reads the `review` category from this package's routing config rather
  than defining a second, independent review-model setting — confirmed by
  cross-reading both packages' final specs before either ships code.
- R14: `docs/docs/cli-reference.md`, `README.md`, and the docs site
  document `keryx routing`, `/routing`, the category catalogue (marking
  wired-vs-not), the model-profile fields, and the classifier fallback
  chain.
- R15: A `ModelProfile` record (§6.1) is captured/refreshed at both
  `fetchOpenAiCompatModelsDetailed` and `testProviderConnection` call
  sites, stored per-user (§6.2), with every field's `source` one of
  `reported`/`curated`/`guessed`/`operator`/`unknown` — verified by a test
  that a live-response fixture carrying `pricing`/`context_length` fields
  (from any gateway, not only OpenRouter) produces `source:"reported"`,
  and a fixture without them falls through to `guessed`/`unknown`.
- R16: Strength-tier guessing reuses `rankModelId`/`MODEL_RANK_HINTS`
  (`model-tier.ts:205-258`) rather than a second heuristic table —
  verified by a test asserting the same rank -> tier mapping for a shared
  set of model ids.
- R17: A guessed or unreported price/context field is always `"unknown"`,
  never `0` or a fabricated number — verified by a test.
- R18: An operator correction to any profile field (including `priority`)
  is stored with `source: "operator"` and survives the next refresh
  unchanged until the operator explicitly clears it — verified by a test:
  a refresh after an operator-sourced field leaves that field untouched
  while updating every non-`operator` field on the same profile.
- R19: With no per-project/per-user configuration at all, `keryx routing
  list` (R2) reports every category's DERIVED resolution (§6.3) —
  `session default` only when derivation itself could not run — verified
  by tests for: one connected model; several models with known
  (reported/curated) prices; several models with guessed prices/unknown
  fields; and an explicit per-user override winning over a derived entry.
- R20: `/routing` (R3) shows each model's profile (tier, price, context,
  priority, and each field's source) in the flat picker, and marks which
  categories are currently `auto (derived from <provider>'s models)` vs.
  explicit vs. session-default.
- R21: The `/connect` `[Test]` result (and `keryx providers test`)
  mentions when a test refresh updated stored model profiles — added,
  changed, and newly-unavailable counts.
- R22: The curated seed table (§6.1) ships with exactly Anthropic, OpenAI,
  and Gemini entries; connecting ANY other provider (built-in or a custom
  `llm-providers.json` entry) adds its discovered profiles to the SAME
  per-user catalogue store as the curated seed — verified by a test that
  connecting a non-seeded provider results in `keryx routing profile list`
  showing its models alongside the three curated ones, each retaining its
  own `source` per field.
- R23: `priority` is computed automatically — `-priceInputPerMillion` when
  known, a fixed documented sentinel below every known price when
  `unknown` (§6.1 "Auto-priority") — on first profile creation AND on
  every refresh, UNLESS `source: "operator"` (R18) — verified by a test
  asserting: two profiles with known prices sort cheaper-first by
  auto-priority; an operator-set priority is never recomputed by a
  subsequent refresh even when that model's price later becomes known/
  changes.
- R24: A model id no longer present in a provider's live `/models` list is
  marked `available: false` on its stored profile (kept, never deleted);
  a model id newly present gets a fresh profile with `available: true` —
  verified by a test simulating two refreshes with a shrunk and then a
  grown model list.
- R25: A routing table entry (any layer, §5/§6.3) whose resolved model is
  `available: false` is treated as unresolved at that layer and falls
  through to the next layer in the precedence chain — verified by a test
  where an explicit per-user entry names a now-unavailable model and
  resolution falls through to the per-project/derived/default layer below
  it, exactly as if the per-user layer had nothing configured.
- R26: `keryx routing list`/`/routing` show an unavailable-and-falling-back
  entry explicitly (`<provider>/<model> — unavailable, falling back to
  <resolved>`), never silently substituting the fallback with no
  indication anything changed.

## Related modules

- [Keryx Provider Breadth](../keryx-provider-breadth/README.md) —
  `ProviderPort` adapters this design's `DecisionPort` deliberately stays
  separate from.
- [Keryx Provider Auth](../keryx-provider-auth/README.md) — credential
  acquisition; this package reuses `OPENROUTER_API_KEY` resolution as-is.
- `docs/requirements/keryx-jev-review/` (sibling, in progress) —
  Jev-as-review-triage; reads this package's `review` category (§10, R13)
  rather than defining its own model choice.
- `src/harness/child/model.ts` / `src/harness/child/orchestrate.ts` — the
  existing `ChildModelRequest`/`resolveChildModel` fail-closed gate chain
  a routing-table-resolved category must pass through unmodified (R5).
- `src/commands/review.ts` (`runTier`) / `src/gdskills/model-tier.ts` — the
  existing rule-based tiering the `review` category's resolved
  provider/model still ranks a concrete session model against, and the
  `rankModelId`/`MODEL_RANK_HINTS` heuristic §6.1 reuses for guessed
  strength tiers.
