# Keryx Task Router
Version: 0.2.0 (draft — reworked per operator direction, 2026-09-25)

## Purpose

Give keryx a user-configured **routing table** that maps a task category
(`review`, `subagents`, `quick`, `coding`, `planning`, `docs`,
`unattended`, plus the always-available `default`) to a model — the piece
of infrastructure keryx does not have today. On top of that table, an
optional, pluggable **classifier** decides which category an unlabeled
task belongs to: TypeSafe's Jev (a "System One" structured-decision model
reached via OpenRouter, `POST https://openrouter.ai/api/v1/systemone`)
when connected and enabled, the session's own main model as a cheap
fallback classifier when Jev is not available, and today's plain default
model when neither runs or either fails. The table works with zero
classifier configured; the classifier only decides which table entry
applies when a caller has not already named its own category.

## Status

**draft** — PRD and implementation plan reworked 2026-09-25 against
`origin/main` @ `e04715a2` (keryx `0.2.161`), branch `docs/jev-prd`, draft
PR #701. No code has been written; no flow has been opened. See `PLAN.md`'s
"Open questions for the operator" before scheduling Flow A.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [PRD.md](PRD.md) | Problem, goals/non-goals, users/scenarios, the task-category catalogue, the routing table's config and precedence, the `/routing` TUI modal, the CLI, the pluggable classifier (Jev / main-model / none), review integration, TUI visibility, cost/latency/privacy, metrics, risks, numbered requirements. |
| [PLAN.md](PLAN.md) | Flow split — A: routing table + `/routing` modal + CLI, wiring review and subagents; B: classifier abstraction + main-model classifier; C: Jev classifier via `DecisionPort`; D: wider auto-routing, TUI visibility, metrics — draft acceptance criteria, sized tasks, test strategy, open questions. |

## Scope (this version)

- A routing table (`ROUTING_CATEGORIES`, `CategoryAssignment`,
  `resolveCategory`), configurable per-project (`routing.config.json`) and
  per-user (shell config), with the precedence: explicit override >
  per-project > per-user > `default`.
- `keryx routing list|set|unset|explain` and a `/routing` TUI modal whose
  model picker is ONE flat, searchable/filterable list across every
  connected provider's models — no "pick a provider first" step.
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
  never a guessed category — and the routing table's `default` entry is
  always available with nothing configured.
- TUI visibility: a compact category -> model row in the sidebar, and a
  per-turn "routed to X (category, classifier, confidence)" line with an
  override affordance, per the project's standing "every feature visible
  in the TUI" rule.
- Privacy: task text sent to `JevTaskClassifier` is opt-in and passed
  through the existing redaction pipeline (`src/security/redact.ts`)
  before it crosses the OpenRouter/TypeSafe boundary; the main-model
  classifier introduces no new vendor relationship.

## Non-goals (this version)

- Replacing `src/gdskills/model-tier.ts`'s existing light/standard/deep
  ranking of a concrete model within whatever provider a category
  resolves to — this design sits one level above it.
- Auto-classifying every interactive main-agent turn before Flow D; Flow A
  ships with categories chosen explicitly by the call site only.
- Training or fine-tuning any classifier model.
- Routing `/delegate`'s external-agent-CLI dispatch.
- Redesigning the existing `/model`/`/provider`/`/connect` two-step
  pickers — `/routing`'s flat list is a new, separate picker for a
  different job (assigning a category, not changing the live session).

## Related modules

- [Keryx Provider Breadth](../keryx-provider-breadth/README.md) — the
  `ProviderPort` adapters this design's `DecisionPort` deliberately stays
  separate from.
- [Keryx Provider Auth](../keryx-provider-auth/README.md) — credential
  acquisition; this package reuses `OPENROUTER_API_KEY` resolution as-is.
- `docs/requirements/keryx-jev-review/` (sibling, in progress) —
  Jev-as-review-triage; reads this package's `review` category rather than
  defining its own model choice (PRD §9, R13).
- `src/harness/child/model.ts` / `src/harness/child/orchestrate.ts` — the
  existing `ChildModelRequest`/`resolveChildModel` fail-closed gate chain
  a routing-table-resolved category must pass through unmodified.
- `src/commands/review.ts` (`runTier`) / `src/gdskills/model-tier.ts` — the
  existing rule-based tiering the `review` category's resolved
  provider/model still ranks a concrete session model against.
