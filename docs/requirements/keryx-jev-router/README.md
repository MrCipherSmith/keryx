# Keryx Task Router
Version: 0.4.0 (draft — reworked per operator direction, 2026-09-25)

## Purpose

Give keryx a user-configured **routing table** that maps a task category
(`review`, `subagents`, `quick`, `coding`, `planning`, `docs`,
`unattended`, plus the always-available `default`) to a model — the piece
of infrastructure keryx does not have today. Keryx also discovers what it
can honestly know about each connected model — strength tier, price,
context length, each field's source (reported by the gateway, curated,
guessed from the name, or unknown) — and uses that to **build a sensible
default table automatically** when the operator has configured nothing.
On top of both, an optional, pluggable **classifier** decides which
category an unlabeled task belongs to: TypeSafe's Jev (a "System One"
structured-decision model reached via OpenRouter, `POST
https://openrouter.ai/api/v1/systemone`) when connected and enabled, the
session's own main model as a cheap fallback classifier when Jev is not
available, and the derived/plain-default model when neither runs or either
fails. The table (and its auto-derived defaults) work with zero classifier
configured; the classifier only decides which table entry applies when a
caller has not already named its own category.

## Status

**draft** — PRD and implementation plan reworked 2026-09-25 against
`origin/main` @ `e04715a2` (keryx `0.2.161`), branch `docs/jev-prd`, draft
PR #701 (latest commit at last edit: `e349ed9c`). No code has been
written; no flow has been opened. See `PLAN.md`'s "Open questions for the
operator" before scheduling Flow A.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [PRD.md](PRD.md) | Problem, goals/non-goals, users/scenarios, the task-category catalogue, the routing table's config and precedence, model-profile discovery and derived default routing, the `/routing` TUI modal, the CLI, the pluggable classifier (Jev / main-model / none), review integration, TUI visibility, cost/latency/privacy, Jev facts, prior art, risks, metrics, numbered requirements. |
| [PLAN.md](PLAN.md) | Flow split — A: routing table + `/routing` modal + CLI, wiring review and subagents (no classifier); A2: model-profile discovery + derived default routing (still no classifier); B: classifier abstraction + main-model classifier; C: Jev classifier via `DecisionPort`; D: wider auto-routing, TUI visibility, metrics — draft acceptance criteria, sized tasks, test strategy, open questions. |

## Scope (this version)

- A routing table (`ROUTING_CATEGORIES`, `CategoryAssignment`,
  `resolveCategory`), configurable per-project (`routing.config.json`) and
  per-user (shell config), with the precedence: explicit override >
  per-project > per-user > **derived** > `default`.
- **Model profile discovery**: a per-`<provider>/<model>` record of
  strength tier, price per million input/output tokens, context length,
  and a priority, captured/refreshed whenever a provider connects or its
  model list is tested/refreshed, with an honest `source` per field
  (reported by the gateway, a curated table, guessed from the model name,
  set by the operator, or explicitly unknown — never a fabricated price).
  The curated table seeds with exactly Anthropic/OpenAI/Gemini (the three
  providers keryx has no live `/models` source for today) and GROWS as
  every other connected provider's discovered profiles are added to the
  same per-user catalogue. `priority` is computed automatically from
  price on every connect/refresh unless the operator has set it, and is
  never recomputed once they do. A model that disappears from a
  provider's live list is marked unavailable and kept, not deleted, so a
  routing entry pointing at it falls back visibly instead of silently
  breaking or silently pointing at a ghost.
- **Derived default routing**: when the operator has configured nothing,
  keryx builds a category table from the session's own connected
  provider's models and their profiles — one model means that model for
  every category; several models means the lightest/cheapest for
  `quick`/`subagents`/`docs`, the strongest for `planning`/`review`, and
  the session's own model for `default`/`coding`.
- `keryx routing list|set|unset|explain|profile` and a `/routing` TUI
  modal whose model picker is ONE flat, searchable/filterable list across
  every connected provider's models — no "pick a provider first" step —
  showing each model's profile and marking derived vs. explicit entries.
- Wiring the `review` and `subagents` categories into real call sites
  (`keryx review tier`, `spawn_subagent`) in Flow A, with zero classifier
  involved.
- A pluggable `TaskClassifier` interface with two implementations:
  `MainModelTaskClassifier` (a cheap, capped, gated call to the session's
  own model) and `JevTaskClassifier` (over a new `DecisionPort`,
  structurally separate from `ProviderPort`, since Jev's typed
  noul/choice answers share no shape with a chat/completion stream).
- Fail-closed fallback at every layer: classifier unavailable, timed out,
  erroring, or under-confident all resolve to "no classification" —
  never a guessed category — and the routing table's derived/`default`
  entry is always available with nothing configured.
- TUI visibility: a compact category -> model row in the sidebar
  (marking derived entries), and a per-turn "routed to X (category,
  classifier, confidence)" line with an override affordance, per the
  project's standing "every feature visible in the TUI" rule.
- Privacy: task text sent to `JevTaskClassifier` is opt-in and passed
  through the existing redaction pipeline (`src/security/redact.ts`)
  before it crosses the OpenRouter/TypeSafe boundary; the main-model
  classifier introduces no new vendor relationship; model-profile
  discovery reads only a provider's public `/models` listing, never task
  text.

## Non-goals (this version)

- Replacing `src/gdskills/model-tier.ts`'s existing light/standard/deep
  ranking of a concrete model within whatever provider a category
  resolves to — this design sits one level above it (though it DOES reuse
  that module's `rankModelId`/`MODEL_RANK_HINTS` for guessing a model's
  strength tier from its name, PRD §6.1).
- Auto-classifying every interactive main-agent turn before Flow D; Flow A
  ships with categories chosen explicitly by the call site only.
- Training or fine-tuning any classifier model.
- Routing `/delegate`'s external-agent-CLI dispatch.
- Redesigning the existing `/model`/`/provider`/`/connect` two-step
  pickers — `/routing`'s flat list is a new, separate picker for a
  different job (assigning a category, not changing the live session).
- **Cross-provider derivation**: deriving a default table using models
  from a provider other than the session's own current one. v1 derives
  from the session's own provider only.

## Related modules

- [Keryx Provider Breadth](../keryx-provider-breadth/README.md) — the
  `ProviderPort` adapters this design's `DecisionPort` deliberately stays
  separate from.
- [Keryx Provider Auth](../keryx-provider-auth/README.md) — credential
  acquisition; this package reuses `OPENROUTER_API_KEY` resolution as-is.
- `docs/requirements/keryx-jev-review/` (sibling, in progress) —
  Jev-as-review-triage; reads this package's `review` category rather than
  defining its own model choice (PRD §10, R13).
- `src/harness/child/model.ts` / `src/harness/child/orchestrate.ts` — the
  existing `ChildModelRequest`/`resolveChildModel` fail-closed gate chain
  a routing-table-resolved category must pass through unmodified.
- `src/commands/review.ts` (`runTier`) / `src/gdskills/model-tier.ts` — the
  existing rule-based tiering the `review` category's resolved
  provider/model still ranks a concrete session model against, and the
  source of `rankModelId`/`MODEL_RANK_HINTS`, reused for guessed strength
  tiers (PRD §6.1).
- `src/commands/providers.ts` (`fetchOpenAiCompatModelsDetailed`,
  `testProviderConnection`) — the two existing live model-discovery call
  sites this package extends to also capture model profiles (PRD §6).
