# Shared Agent Context — Generational Memory
Version: 0.1.0

## Status

Future / planned requirements package. It specifies a lifecycle contract; it
does not claim a new SAC memory runtime exists.

## Purpose

Define how SAC may safely carry short-lived observations through a bounded
workspace working set into explicit owner-controlled durable knowledge. The
model preserves temporal correctness, contradiction visibility, abstention,
and selective forgetting without making SAC a durable knowledge store.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package scope and navigation. |
| [prd.md](prd.md) | Product requirements and success measures. |
| [specification.md](specification.md) | Planned generations, data contracts, integrations, and surfaces. |
| [policies.md](policies.md) | Admission, retrieval, retention, privacy, and abstention policy. |
| [artifact-lifecycle.md](artifact-lifecycle.md) | State transitions, supersession, tombstones, and deletion. |
| [metrics-and-validation.md](metrics-and-validation.md) | Multidimensional evaluation corpus and release gates. |
| [implementation-plan.md](implementation-plan.md) | Incremental delivery plan and safety gates. |

## Scope

- Ephemeral Session observations, TTL-bound workspace working sets, and
  accepted durable knowledge owned by Wiki, Memory, or Skills.
- Temporal validity, contradiction sets, applicability, evidence diversity,
  source trust, abstention, and selective forgetting.
- An evaluation corpus covering retrieval, temporal updates, contradictions,
  false premises, deletion, forgetting, and abstention.

## Non-goals and invariants

- SAC owns no durable knowledge body; durable artifacts remain with their owner
  systems and SAC retains only bounded references/receipts.
- No automatic promotion, acceptance, or overwrite is permitted.
- A global vector database is not a default dependency or authority. Any
  optional retrieval accelerator must be owner-scoped, disposable, and unable
  to bypass lifecycle, visibility, or temporal checks.
- No complete Session transcript, hidden reasoning, or workspace contents are
  injected into model context because an item is remembered.

## Related modules

This future package composes SAC FWK boundaries, Context Operations, trusted
Session/Harness evidence, workspace manifests, and durable owners: Keryx
Memory, Wiki, and project Skills.
