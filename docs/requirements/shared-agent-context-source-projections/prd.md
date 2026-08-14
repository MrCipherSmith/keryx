# Shared Agent Context — Source-Owned Projections: Product Requirements
Version: 0.1.0

## Problem

The 2026-08-14 integrated analysis verified several current integration gaps:

- SAC reads a Flow resource as raw JSON, uses only the first linked Flow, and
  maps it into a lossy Work projection.
- Evidence is read as a resource/hash rather than resolved through an
  owner-defined typed contract.
- Wiki, Memory, and Skills Know-how is discovered from Markdown with a status
  regex, so trust and applicability are inferred rather than owner-derived.
- Wiki acceptance writes its body directly instead of using a canonical
  Wiki-owned body-write capability.

These are observations of the current runtime, not defects this document
claims have already been fixed.

## Goal

Enable SAC to consume FWK through stable, typed source-owned ports and to
request durable-knowledge writes only through canonical owner APIs. SAC stays a
reference/receipt layer; it neither becomes a work tracker nor a knowledge
store.

## Users

- Agents need bounded, trustworthy project context with source provenance.
- Flow, Wiki, Memory, and Skills maintainers need their invariants preserved.
- Reviewers/operators need predictable migration, failure behavior, and audit
  evidence.

## Functional requirements

| ID | Requirement |
|---|---|
| RP02-1 | Provide typed read ports for Flow, evidence, Wiki, Memory, and Skills. Each port returns an owner-defined snapshot/result plus stable identity, revision, visibility decision, and typed unavailable/denied/stale result where applicable. |
| RP02-2 | Build Work only from a selected canonical Flow snapshot. Preserve the owner’s semantics for status, acceptance criteria, next actions, blockers, and verification evidence; SAC may add projection metadata but may not invent, collapse, or mutate Flow state. |
| RP02-3 | Resolve Facts through an evidence port that validates typed references, revision, visibility, observed time, expiry/freshness, and provenance. A hash alone is not an authoritative evidence contract. |
| RP02-4 | Resolve Know-how through owner ports. Wiki, Memory, and Skills must return owner-derived lifecycle/trust, applicability, revision, withdrawal/staleness, and visibility rather than SAC parsing Markdown status text. |
| RP02-5 | Route a Wiki decision/body acceptance through a canonical Wiki-owned write capability. SAC supplies a reviewed, evidence-bound intent; Wiki validates and returns its target-write receipt. |
| RP02-6 | Retain owner boundaries: Context Operations remains assembly/trace owner; Flow remains work-state writer; Wiki, Memory, and Skills remain durable-knowledge owners; Security remains the guard authority. |
| RP02-7 | Support an incremental, fail-closed migration. During a per-owner compatibility window, an adapter may expose a typed result backed by existing owner functionality, but no raw SAC reader/direct writer may be the long-term contract. |

## Success criteria

- Every FWK entry identifies its owner, canonical subject/reference, revision,
  and explicit projection state.
- Flow parity fixtures show no semantic loss for the selected canonical Flow
  fields; multiple links never silently choose an arbitrary Flow.
- Know-how trust and applicability are returned by owner ports, with no
  acceptance decision based on a SAC Markdown-status regex.
- Accepted Wiki decisions create/update the body only through the canonical
  Wiki writer and return a correlation- and intent-bound receipt.
- A port failure yields a typed denied/unavailable/stale result and does not
  silently promote unverified fallback content into authoritative FWK.

## Risks

- Owner APIs may expose incompatible lifecycle vocabulary or incomplete
  revision semantics.
- An adapter can accidentally preserve the old lossy behavior behind a new
  type name; parity fixtures and owner review are required.
- Migration can create two sources of truth if SAC caches owner content instead
  of retaining references and regenerable receipts.
- Canonical Wiki write work must not bypass current security, idempotency, or
  review gates.

## Recommendation

Deliver ports and fixtures before expanding SAC ergonomics. Migrate Flow and
evidence reads first, then Know-how reads, then canonical Wiki decision/body
writes. Keep the existing parent SAC package as the cross-cutting contract;
RP-02 specifies only the source-projection seam.
