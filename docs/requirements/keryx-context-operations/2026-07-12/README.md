# Keryx Context Operations
Version: 1.1.0

## Purpose

This package specifies the future implementation of **Context Operations**: a
governed layer that assembles a minimal, verifiable and safe context for a
coding agent out of code, wiki, memory, skills and quality artifacts. It extends
the current `.metaproject/` rather than replacing its deterministic, local-first
core.

## Status

`specification ready — future implementation`. No new runtime, CLI or database
provider is declared implemented by this package.

## Problem and outcome

An agent today has good individual sources: `gdgraph`, `gdwiki`, `memory`,
`gdskills`, `health`, `testing` and `security`. But the *selection* of context is
spread across commands and rules, so there is no uniform way to answer **which
facts were handed to the agent, why they were chosen, which source won, and
whether it helped**. Context Operations turns that selection into a versioned,
observable and measurable product contract.

## Package contents

- [PRD](prd.md) — users, requirements, risks and success criteria.
- [Specification](specification.md) — architecture, contracts, CLI and integrations.
- [Implementation plan](implementation-plan.md) — delivery sequence.
- [Agent protocol](agent-protocol.md) — how agents must behave when reading,
  writing and applying context.
- [Artifact lifecycle](artifact-lifecycle.md) — source of truth, retention and
  supersession of artifacts.
- [Metrics and validation](metrics-and-validation.md) — evals, SLOs and gates.
- [Research and positioning](research-and-positioning.md) — competitive landscape
  and architectural decisions.
- [Schemas](schemas/) — machine-readable contracts:
  [manifest](schemas/context-assembly-manifest.schema.json),
  [candidate](schemas/context-candidate.schema.json),
  [trace](schemas/retrieval-trace.schema.json),
  [error](schemas/context-error.schema.json) and
  [external adapter](schemas/external-adapter.schema.json).

## Language variants

**These English documents are canonical.** Version 1.1.0 translated the package
in place: it was previously authored in Russian with abbreviated English and AI
views alongside, which meant the detailed source and the readable source were
different documents.

Two derived views remain, and both are summaries rather than translations:

- [AI contract view](ai/README.md) · [AI PRD](ai/prd.md) · [AI specification](ai/specification.md)
- [Condensed English view](en/README.md) — retained for its shorter framing;
  where it disagrees with this package, this package wins.

Every functional requirement carries a stable `CO-*` identifier, which is what
lets the views and the acceptance criteria be checked against each other.

## Scope

- Assembling a bounded context package with provable provenance for every item.
- One hybrid retrieval path: lexical, optional semantic, and code-graph proximity.
- Retrieval trace, feedback and memory lifecycle without losing the original
  Markdown sources.
- A security/policy gate before new knowledge is written and before context is
  handed over.
- A local CLI/MCP surface; external memory systems are opt-in adapters only.

## Non-goals

- Not to build a mandatory cloud or multi-tenant memory database.
- Not to replace Graphiti, Cognee, Mem0, Letta or OpenViking with a runtime core
  of our own.
- Not to introduce a new LLM agent runtime — that is the
  [Keryx Project Agent Harness](../../keryx-project-agent-harness/README.md).
- Not to record untrusted web or tool output as accepted memory automatically.

## Related modules

`src/memory`, `src/wiki`, `src/gdgraph`, `src/ctx`, `src/gdskills`,
`src/security`, `src/health`, `src/testing`, `src/mcp`, `src/flow` and
`src/capability`.
