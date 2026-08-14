# Shared Agent Context — Secure Minimal Evidence (RP-05)
Version: 0.1.0

## Purpose

RP-05 defines future security and lifecycle requirements for session-derived
evidence used by Shared Agent Context (SAC). It replaces unsafe transcript-like
evidence handling with sealed-session, schema-closed, minimised evidence that
is scanned before persistence and governed by deletion rather than TTL alone.

## Status

**Future / planned requirements package.** No behavior in this package is a claim
about the current runtime or an authorization to persist transcripts.

## Document index

- [Package index](README.md)
- [Product requirements](prd.md)
- [Technical specification](specification.md)
- [Security policies](policies.md)
- [Agent protocol](agent-protocol.md)
- [Artifact lifecycle](artifact-lifecycle.md)
- [Metrics and validation](metrics-and-validation.md)
- [Implementation plan](implementation-plan.md)

## Scope

- Sealed terminal sessions and minimal, schema-closed wrap-up evidence.
- Security scan, redaction/minimisation, trust/sensitivity propagation, and
  restricted archive handling before any persistence.
- Explicit retention, deletion, revocation, and abuse-corpus validation.
- Owner-bound proposal inputs without automatic promotion.

## Non-goals

- Default full transcript storage, storage of prompts or hidden reasoning.
- An SAC-owned session system, Flow tracker, or durable-knowledge store.
- Automatic acceptance/promotion of a wrap-up into Wiki, Memory, or Skills.
- Weakening Security, Harness/session, Flow, or knowledge-owner boundaries.

## Related modules

- Parent SAC: [agent protocol](../shared-agent-context/agent-protocol.md) and
  [artifact lifecycle](../shared-agent-context/artifact-lifecycle.md).
- Owners/integrations: Harness/session, Security, Context Operations, Flow,
  Wiki, Memory, Skills, MCP, and the proposal lifecycle.
- Evidence baseline: [integrated analysis report](../../analysis/keryx-improvements-1/2026-08-14/report/ru/report.md).
