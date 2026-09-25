# Keryx Task Router — PRD

Version: 0.2.0 (draft — reworked per operator direction, 2026-09-25)
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
facing "this kind of task goes to this model" setting anywhere.

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
   per project (§5), with a CLI (§7) and a TUI `/routing` modal (§6) to
   read and edit it.
2. Ship a **flat, searchable, filterable model list** across every
   connected provider for picking a category's model — no "pick a provider
   first, then a model" two-step (§6).
3. Define a **small, code-grounded set of task categories** (§4), marking
   which are actually wired to a real call site in v1 and which are
   catalogue entries for later (§4, PLAN.md Flow A).
4. Make **category classification** — "which category does this task
   belong to" — a **pluggable, optional** decision, with three tiers of
   fallback: Jev (via a `DecisionPort`, §8) -> the session's own main
   model (a cheap structured call, §8) -> today's behavior (the `default`
   category, no classification at all) (§8).
5. Make the **review** category the single source of truth the review
   pipeline (`keryx review tier`) and the sibling Jev-review-triage design
   (`docs/requirements/keryx-jev-review/`) both read — one config, not two
   competing model choices for review (§9).
6. Keep every routing decision **visible, explainable, and overridable** in
   the TUI (§10) and the CLI (§7), fail-closed to today's behavior on any
   classifier error, timeout, or low confidence (§8.4).

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
  are for "change the session's own model"; `/routing`'s flat list (§6) is
  a new, additional picker for a different job (assign a category, not the
  live session).

## 3. Users and scenarios

**Primary user**: the operator who has connected 2+ providers of different
cost/strength (`configuredProviders`, `src/commands/providers.ts:1031-1044`)
and wants different kinds of work to land on different models without
manually running `/model` before every turn.

- **Scenario A — set up the table once.** The operator opens `/routing`,
  sees every category defaulting to "session default", picks a cheaper
  model for `quick`/`review` and a stronger one for `planning`, closes the
  modal. No classifier involved yet.
- **Scenario B — review dispatch reads the table.** `keryx review tier`
  and the review pipeline's dispatch step resolve the `review` category
  from the table (§9) instead of only ranking against the session's own
  model, the same way the sibling `keryx-jev-review` package's triage
  design reads it too.
- **Scenario C — subagent spawn reads the table.** `spawn_subagent`
  resolves the `subagents` category from the table when the dispatcher
  named nothing more specific, instead of plain parent inheritance.
- **Scenario D — classified routing (Flow B/C).** Once a classifier is
  configured, a task description is classified into one of the catalogue
  categories (§4) and the table's entry for that category is used —
  visible in the TUI as "routed to X (category, classifier, confidence)"
  (§10), always overridable.

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
(§8.5) > **per-project config** > **per-user config** > **`default`
category** (today's session model, unconditionally available with nothing
configured). A user sets their routing once, in their own config, for every
project; a project that needs something different — a stronger review
model, a provider its CI can reach — states it in `routing.config.json`,
and that wins inside that project. A project entry that names a provider or
model the user has not connected falls through to the user's entry for that
category (and the modal says so), rather than failing the call.

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
  default for every category the operator has not touched.
- `"kind": "model"` — an explicit `providerId`/`modelId` pair, picked from
  the flat list (§6).
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

## 6. `/routing` TUI modal

`/routing` (new agent-mode-only slash command, registered in
`AGENT_SLASH_COMMANDS`, `src/commands/agent-commands.ts:61-`) opens a
list+detail modal through `modal-host`, same construction as the
Governance/Triggers modals
(`.metaproject/flows/300-2026-09-23-tui-sidebar-and-modals-for-the-governanc/acceptance-criteria.md`
AC3/AC5):

- The list side shows every category from §4, each with its current
  resolution (`session default`, `<provider>/<model>`, or
  `<provider> (provider default)`) and whether it is wired in v1.
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
  provider first" screen.
  - A "provider default" row per connected provider is included alongside
    every `provider/model` row for the "pin provider, not model" case
    (§5).
  - A "session default" row clears the category back to unset.
- Esc closes the modal; the table is written (per §5's precedence — a
  change made here writes to the per-user layer, per PLAN.md open
  question 2) as soon as a selection is confirmed, not on modal close.

## 7. CLI

`keryx routing <subcommand>`, mirroring `keryx providers`'s
list/test/remove shape (`src/commands/providers.ts:1065-1090`):

- `keryx routing list [--json]` — every category, its resolution, its
  source layer (project/user/default), and whether it is wired in v1.
- `keryx routing set <category> <provider>/<model>` — writes an explicit
  `{kind:"model"}` entry. `keryx routing set <category> <provider>` (no
  slash) writes a `{kind:"provider-default"}` entry.
- `keryx routing unset <category>` — clears back to `session-default`.
- `keryx routing explain "<task>"` — runs classification (§8) against the
  configured classifier (or reports "no classifier configured, would use
  the `default` category" when none is set) and prints the category,
  confidence, the resolved provider/model for that category, and — for a
  Jev classification — usage/cost/latency (mirrors the CLI/TUI parity rule
  in §10). This subsumes the earlier design's standalone
  `keryx route explain` command — one CLI surface, not two.
- Every write subcommand supports `--user`/`--project` to target a layer
  explicitly, defaulting to `--user` (matching §5/PLAN.md open question 2).

## 8. The classifier: optional and pluggable

The routing table (§5) answers "category -> model". Something must decide
*which category* a given task belongs to when the caller has not already
named one explicitly (the review pipeline and `spawn_subagent`'s default
path always name their own category explicitly in Flow A — §Non-goals —
so classification only matters once Flow B/C/D wire up call sites that do
not already know their category, e.g. an interactive main-agent turn).

### 8.1 Classifier interface

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

### 8.2 Jev classifier (`JevTaskClassifier`)

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
OpenRouter's TypeSafe SDK guide, 2026-09-25 — see §12 for the full vendor-
fact list), reuses the same `OPENROUTER_API_KEY` resolution as the
`openrouter` compat-provider entry (`providers.ts:312-321`), and is
injected with `fetch` exactly like every other provider adapter (never a
real network call in a test).

### 8.3 Main-model classifier (`MainModelTaskClassifier`)

Used when Jev is not connected/enabled but classification is still wanted:
a small, cheap, structured call to the **session's own current model** —
"which one of these category names best fits this task? Answer with just
the name." Kept deliberately minimal:

- Single-token or short-JSON response, no streaming, no tools.
- A size cap on the task text sent (same order of magnitude as the `state`
  built for Jev, §11 below — a task description and nothing else).
- Only invoked when a caller actually asks for a classification (not on
  every turn speculatively) — same "opportunistic, gated, cancellable
  extra call" shape the existing next-step-suggestion feature already uses
  (`NextStepSuggestionGate`, `src/tui/tui-shell.ts:3737-3742`, flow 268
  AC14): a caller-invalidated, in-flight-deduplicated request, never
  stacked, never blocking the turn it was meant to inform.
- Costs whatever the session's own provider charges for a short
  completion — no new vendor relationship, no new credential (§11: the
  task text never leaves whatever provider the operator already trusts
  for their session).

### 8.4 Fallback

With neither classifier available (no Jev connection AND no main-model
classification attempted or it errored/timed out), classification is
skipped entirely and the `default` category resolution is used — exactly
today's behavior. Same fail-closed contract throughout this design: any
classifier timeout (default 2000ms), network/parse error, or confidence
below the configured threshold (default 0.6) is treated as "no
classification", never a guessed category.

### 8.5 Explicit override always wins

A caller-named category (the review pipeline always names `review`;
`spawn_subagent` always resolves `subagents` unless the dispatcher gave an
explicit provider/model/tier) is never overridden by a classifier — the
classifier only runs when a caller has NOT already named a category, the
same short-circuit shape `resolveChildModel`'s explicit rung already has
over env/tier/inherit (`model.ts:161-`). An operator's manual override
from the `/routing` modal or `keryx routing set` (§6, §7) always wins over
any classifier's recommendation for that category's *table entry*; per-
turn, a `--model`/`--category` flag or an explicit `/model` switch always
wins over that turn's classification.

## 9. Review integration (shared with the sibling package)

`keryx review tier`'s dispatch-model computation
(`runTier`, `src/commands/review.ts:767-808`) resolves its model from the
`review` category (§4, wired in v1) instead of — or, during a transition,
alongside — its current live-detection-only ranking. The sibling
`docs/requirements/keryx-jev-review/` package's Jev-as-review-triage
design reads the SAME `review` category resolution from this package's
`routing.config.json`/per-user config (§5) rather than defining its own
separate model choice: one config decides "what model does review run
on," this package owns that config, and review-side packages are
consumers of it, not parallel authors of a competing setting.

## 10. TUI visibility (standing rule: sidebar + modal, every feature)

- **Sidebar**: a compact `Routing` row (or a short block, if a single line
  cannot hold it) mounted in `sidebarTop` after the existing `Model` row
  (`sb-model-k`/`sb-model-v`, `src/tui/tui-shell.ts:3857-3858`), showing
  the category -> model mapping compactly — e.g. wired categories only by
  default (`review`, `subagents`), each abbreviated to fit
  `SIDEBAR_TEXT_WIDTH`, with the full table one click away in the
  `/routing` modal (§6).
- **Per-turn visibility**: whenever a turn or dispatch actually used a
  routed (non-`default`) category, the TUI shows a one-line summary —
  `routed to <provider>/<model> (<category>, <classifier>, <confidence>)`
  — where `<classifier>` is `jev`, `main-model`, or `explicit` (no
  classifier ran; the category was named directly by the call site), and
  `<confidence>` is omitted for `explicit`. Shown as a toast or inline
  transcript note, consistent with how other background decisions
  (governance runs, trigger runs) already surface a toast on completion
  (flow 300 AC7).
- **Override affordance**: from that per-turn summary or from the
  `/routing` modal, the operator can override — either for just the next
  call (a session-scoped override) or persistently (writes to the table,
  §6/§7). Never silently discarded on the next automatic recommendation.
- **`/routing` modal**: see §6.

## 11. Cost, latency, and privacy

- **Privacy / redaction**: task text sent to `JevTaskClassifier` crosses a
  new vendor boundary (OpenRouter -> TypeSafe) and requires the same
  opt-in this design always required — connecting `openrouter` for chat
  use does not implicitly enable it as a classifier. The text is passed
  through `redactSensitiveText` (`src/security/redact.ts:128`) before
  assembly. `MainModelTaskClassifier` sends task text to whatever provider
  the session is already using for generation — no new vendor
  relationship, no additional redaction requirement beyond what the
  session already accepts by using that provider at all.
- **Cost**: Jev's own price ($0.042/M input tokens, output free — §12) is
  tracked with the same `spendFromTokens` ceiling machinery
  `keryx review budget` uses (`src/review/caps.ts:270-334`), as its own
  small ceiling separate from generation spend. The main-model
  classifier's cost is ordinary generation spend on the session's own
  model — accounted for as such, not separately.
- **Latency**: Jev's independently measured 0.33s median / 1.42s max
  (§12) sets the default classifier timeout at 2000ms; the main-model
  classifier's latency depends entirely on the session's own provider and
  is not separately budgeted.
- **Unattended sandbox egress**: a classification call from inside a
  sandboxed run crosses the same domain-allowlist boundary as before
  (`network: "allowlist"`, `src/harness/process/sandbox/unattended.ts:
  59-68`) — `openrouter.ai` (for Jev) must be an explicit allowlist entry;
  the main-model classifier needs no new allowlist entry since it targets
  whatever provider the run's own dispatch already reaches.

## 12. Jev facts (researched 2026-09-25; re-verify before Flow C)

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

## 13. Prior art (brief)

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

## 14. Risks and honest limits

- **Two classifiers can disagree with each other and with a human's
  intuition.** Mitigation: confidence threshold + fallback (§8.4),
  visibility (§10), and Flow A/B/C ship with classification off by
  default and only wired for categories where a caller already names its
  own category explicitly (no classification ambiguity possible yet).
- **"Provider default" repurposes a field not designed for this** (§5) —
  only `ollama` has a documented default model; every compat-registry
  provider's "default" is this design's own new interpretation of an
  existing curated-fallback list. Flag before Flow A ships (PLAN.md open
  questions).
- **A second vendor dependency** (OpenRouter + TypeSafe) is optional, not
  required — the table and Flow A/B work with zero external dependency;
  only enabling `classifier: "jev"` (§8.2) introduces it, and §8.4's
  fallback keeps it from ever being a hard dependency for a turn to
  proceed.
- **Main-model classification is not free** — it is a real extra
  generation call against the session's own (possibly expensive) model,
  which could ironically cost more than just running the task on the
  default model would have, for a trivial task. Mitigation: only invoked
  when actually needed (§8.3), and the operator can disable classification
  entirely and rely on explicit per-call categories only (Flow A's
  baseline).
- **Vendor claims are unverified against a live key** — §12's latency/
  pricing figures are vendor and third-party-blog sourced as of
  2026-09-25, not measured by this team; confirm before committing to the
  2000ms timeout default.

## 15. Metrics

1. **Category-agreement rate** between the main-model classifier and Jev,
   where both run against the same task (useful for deciding whether the
   cheaper local classifier is "good enough" once there is field data).
2. **Override rate** per category — a high rate on a specific category is
   a direct signal that category's table entry, or its classification, is
   wrong.
3. **Cost delta**: generation spend with routing/classification enabled
   vs. a comparable window without, via `spendFromTokens`
   (`src/review/caps.ts:319-334`).
4. **Classifier overhead**: added latency/cost per classified turn,
   logged in the same per-turn record the TUI's "routed to..." line reads
   from (§10).
5. **Fallback rate**: how often §8.4's fallback fires per classifier —
   independent of whether the classifier's *answers* are good, this is
   whether it is reachable/fast enough to matter in practice.

## 16. Requirements (numbered, verifiable)

- R1: A routing table exists (`routing.config.json` at project root, plus
  a per-user layer in shell config) mapping each category from §4 to a
  `{kind: "session-default"|"model"|"provider-default", ...}` entry, with
  the precedence order in §5 (explicit override > per-project > per-user >
  `default`).
- R2: `keryx routing list|set|unset|explain` (§7) exist, with `--json` on
  `list`/`explain`, and `--user`/`--project` on write subcommands.
- R3: `/routing` opens a TUI modal (§6) whose model picker is ONE flat,
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
- R6: A `TaskClassifier` interface (§8.1) exists with `JevTaskClassifier`
  and `MainModelTaskClassifier` implementations and a documented,
  fail-closed "no classification" result on timeout/error/low confidence
  (§8.4) — no caller ever receives a guessed category.
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
  compactly after the `Model` row; a per-turn "routed to X (category,
  classifier, confidence)" line appears whenever a non-`default` category
  was actually used, both overridable per §10.
- R12: A sandboxed/unattended run refuses (named reason, never a silent
  skip) to call `JevTaskClassifier` unless `openrouter.ai` is in that
  run's network allowlist.
- R13: The sibling `docs/requirements/keryx-jev-review/` package's design
  reads the `review` category from this package's routing config rather
  than defining a second, independent review-model setting — confirmed by
  cross-reading both packages' final specs before either ships code.
- R14: `docs/docs/cli-reference.md`, `README.md`, and the docs site
  document `keryx routing`, `/routing`, the category catalogue (marking
  wired-vs-not), and the classifier fallback chain.

## Related modules

- [Keryx Provider Breadth](../keryx-provider-breadth/README.md) —
  `ProviderPort` adapters this design's `DecisionPort` deliberately stays
  separate from.
- [Keryx Provider Auth](../keryx-provider-auth/README.md) — credential
  acquisition; this package reuses `OPENROUTER_API_KEY` resolution as-is.
- `docs/requirements/keryx-jev-review/` (sibling, in progress) —
  Jev-as-review-triage; reads this package's `review` category (§9, R13)
  rather than defining its own model choice.
- `src/harness/child/model.ts` / `src/harness/child/orchestrate.ts` — the
  existing `ChildModelRequest`/`resolveChildModel` fail-closed gate chain
  a routing-table-resolved category must pass through unmodified (R5).
- `src/commands/review.ts` (`runTier`) / `src/gdskills/model-tier.ts` — the
  existing rule-based tiering the `review` category's resolved
  provider/model still ranks a concrete session model against.
