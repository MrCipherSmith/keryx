# Flow Reviewer Model and Token Policy
Version: 0.1.0

## Purpose

Minimize review cost and context duplication without weakening high-risk review
quality or hiding which model performed each task.

## Strategies

| Strategy | Behavior |
|---|---|
| `economy` | Prefer the cheapest compatible coding model for all reviewers; escalate only on explicit policy triggers. |
| `current` | Use the current session model for every reviewer. |
| `adaptive` | Assign model classes by reviewer complexity and target risk. This is the standalone flow-review default. |
| `explicit` | Use caller-provided per-reviewer assignments; reject missing assignments unless fallback is configured. |

If runtime model assignment is unavailable, use the current session model and
record `assignmentStatus: fallback-current-session`. Never claim that a cheaper
model ran unless the runtime confirms the actual model id.

## Adaptive Model Classes

| Class | Typical work | Default reviewer examples |
|---|---|---|
| `economy` | Bounded, mechanical, formatting, naming, documentation, convention checks | `review-style`, `review-clean-code`, docs-only convention reviewers, legacy/profile checks |
| `standard` | Normal framework/domain review with bounded context | `review-frontend`, `review-backend`, `review-testing-practices`, project convention reviewers |
| `strong` | Complex correctness, trust boundaries, concurrency, architectural blast radius | `review-logic`, `review-security-code`, `review-architecture`, `review-highload`, strict synthesis |

Overrides:

- Security/auth/permissions/cryptography changes require `strong` unless the
  caller explicitly accepts a lower class.
- A small documentation-only diff should not trigger `strong` reviewers.
- Blocker/major conflicts between reviewers may escalate consolidation to
  `strong` without rerunning all reviewers.
- A reviewer returning `NEEDS_CONTEXT` does not automatically require a stronger
  model; supply the missing bounded evidence first.

## Reviewer Selection Before Model Selection

Cost optimization begins by not dispatching irrelevant reviewers. The plan must:

1. classify changed files and risks;
2. include explicit user-requested reviewers;
3. select domain reviewers supported by evidence;
4. skip unrelated reviewers with reasons;
5. apply model routing only to the selected set.

`--all` is never inferred from uncertainty.

## Context Budget Policy

| Review size | Detection | Shared context | Reviewer delivery |
|---|---|---|---|
| Small | Up to 5 files and 300 changed lines | Light | Relevant full diff plus direct files |
| Medium | Up to 20 files or 2,000 changed lines | Light | Domain-filtered diff and graph slice |
| Large | Over 20 files or 2,000 changed lines | Full, staged | Per-domain waves with bounded artifacts |
| High-risk | Security, auth, API, core, migrations, concurrency | Full where relevant | Strong reviewer plus strict synthesis gate |

The input budget may set:

- total prompt tokens;
- total output tokens;
- per-reviewer prompt/output tokens;
- maximum diff/file characters;
- maximum findings;
- concurrency;
- retry reserve percentage.

The orchestrator must reserve retry and consolidation capacity before dispatch.
It must stop and request a policy decision instead of silently exceeding the
total budget.

## Context Reuse

- Generate the shared context manifest once per scope fingerprint.
- Store compact artifacts and pass path/hash/summary references.
- Use `gdgraph` to select reviewer-specific files.
- Use `gdctx` to filter and compress diff/search/read output.
- Include wiki, memory, health, and testing artifacts only when they answer a
  reviewer requirement.
- On `NEEDS_CONTEXT`, append only the missing evidence.
- Do not resend accepted results to independent reviewers.

## Cache Reuse

A reviewer result is reusable only when the complete cache fingerprint matches
the specification. Cache reuse must record `reusedFromAttempt` and zero new
model tokens. A stale result is evidence for planning only, not an accepted
review result.

## Observability

Every reviewer task records:

- requested strategy and model class;
- actual model id/class when available;
- prompt/output budget;
- actual prompt/output tokens;
- context artifact count and hash;
- duration, retries, and cache reuse;
- findings count by severity.

The final report aggregates planned versus actual totals and explains every
fallback or budget-driven skip.
