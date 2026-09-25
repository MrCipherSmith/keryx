# Keryx Jev Router
Version: 0.1.0 (draft)

## Purpose

Route keryx's task-to-model decisions — starting with `spawn_subagent`
dispatches and `keryx review tier`'s existing rule-based tiering — through
an optional, opt-in call to TypeSafe's Jev, a "System One" structured-
decision model reached via OpenRouter (`POST
https://openrouter.ai/api/v1/systemone`). Jev answers a small typed
question set (`tier`: light/standard/deep, `confidence`: 0..1) from a task
description and the operator's connected-provider catalogue; keryx's
existing tier-to-model resolution (`src/gdskills/model-tier.ts`,
`src/harness/child/model.ts`) does the rest. Off by default, fail-closed to
today's behavior on any error, timeout, or low-confidence answer, and never
able to bypass the existing subagent authorization gates (allowlist,
network/trust, classifiability).

## Status

**draft** — PRD and implementation plan written 2026-09-25 against
`origin/main` @ `e04715a2` (keryx `0.2.161`). No code has been written; no
flow has been opened. See `PLAN.md`'s "Open questions for the operator"
before scheduling Flow A.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [PRD.md](PRD.md) | Problem, goals/non-goals, users/scenarios, the routing decision design, the new `DecisionPort`, configuration, privacy, cost/latency budget, TUI visibility, CLI, metrics, risks, numbered requirements. |
| [PLAN.md](PLAN.md) | Flow split (A–E, plus a deferred Flow F), draft acceptance criteria per flow, sized tasks, test strategy, open questions. |

## Scope (this version)

- A new `DecisionPort` (`src/harness/decision/decision-port.ts`, planned),
  structurally separate from `ProviderPort` — Jev's typed
  noul/choice-question shape is not a chat/completion stream.
- `JevDecisionPort` over OpenRouter's `/api/v1/systemone`, reusing the
  existing `OPENROUTER_API_KEY` credential; `FakeDecisionPort` as the
  always-available, no-network default.
- Routing wired into `spawn_subagent` dispatch (auto-applied, gated by the
  existing fail-closed model-resolution chain) and into `keryx review
  tier` (an additional, clearly-labeled signal alongside the existing
  rule-based tier).
- `keryx route explain "<task>"` and a TUI `Routing` sidebar section +
  modal, following the project's standing "every feature visible in the
  TUI" rule and the same sidebar/modal shape as the Governance/Triggers
  panels (flow 300).
- Opt-in configuration, a redaction pass over everything sent as `state`
  (reusing `src/security/redact.ts`), and a routing-specific spend
  ceiling separate from the generation spend ceiling.

## Non-goals (this version)

- Replacing `src/gdskills/model-tier.ts`'s rule-based `assignTier` — Jev is
  an additional signal, not a rewrite.
- Auto-applying routing to a live interactive main-agent turn or to an
  unopposed unattended dispatch (scheduled tasks / `flow-next`) — both stay
  explain-only pending field evidence (see PRD §5.1, §11, and Flow F in
  `PLAN.md`).
- Training or fine-tuning any router model (RouteLLM-style). Jev is a
  hosted, pre-trained decision model reached over the network.
- Routing `/delegate`'s external-agent-CLI dispatch — a different agent
  binary, not a model choice in keryx's own provider layer.

## Related modules

- [Keryx Provider Breadth](../keryx-provider-breadth/README.md) — the
  `ProviderPort` adapters this design deliberately does not extend or
  reuse for the decision call.
- [Keryx Provider Auth](../keryx-provider-auth/README.md) — credential
  acquisition; this package reuses `OPENROUTER_API_KEY` resolution as-is.
- `src/harness/child/model.ts` / `src/harness/child/orchestrate.ts` — the
  existing `ChildModelRequest`/`resolveChildModel` fail-closed gate chain
  that a routing-supplied tier must pass through unmodified.
- `src/commands/review.ts` (`runTier`) / `src/gdskills/model-tier.ts` — the
  existing rule-based tiering this version adds Jev alongside, not instead
  of.
