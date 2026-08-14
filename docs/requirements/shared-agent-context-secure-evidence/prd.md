# Shared Agent Context — Secure Minimal Evidence: Product Requirements
Version: 0.1.0

## Problem

The integrated analysis on 2026-08-14 verified that current session evidence is
exported verbatim before security minimisation, a session need not be sealed or
completed before wrap-up use, and a capability TTL does not delete already
persisted evidence. These verified gaps are current-state observations; they
are not resolved by this future requirements package.

## Goal

Allow an authorised completed session or Flow wrap-up to provide only the
minimum reviewed evidence needed for a proposal, while preventing full
transcript, hidden-reasoning, secret, and unbounded-data persistence by default.

## Users

- Agents need a clear, safe wrap-up process and honest denial states.
- Session/Harness and Security owners need enforceable ownership and deletion
  boundaries.
- Knowledge owners and reviewers need evidence provenance without receiving a
  transcript as an implicit write payload.
- Operators need testable retention, incident, and abuse-handling controls.

## Functional requirements

| ID | Requirement |
|---|---|
| RP05-1 | A session-derived wrap-up is eligible only after the session owner emits a terminal `sealed` result with immutable session/revision identity, authenticated actor, close reason/time, and a one-time issuance record. |
| RP05-2 | The persistence payload is schema-closed minimal evidence: explicit summary, declared decision/risk/follow-up fields, typed evidence references/revisions, and provenance. Unknown fields and full-message arrays are rejected. |
| RP05-3 | The Security owner scans and minimises candidate evidence before persistence. A fail, indeterminate result, or required-redaction failure denies persistence; SAC has no bypass. |
| RP05-4 | Full transcript/archive persistence is disabled by default. A restricted opt-in archive requires a distinct policy, explicit authorised purpose, encryption/access controls, finite TTL, deletion job, and audit record. It is never a default proposal input. |
| RP05-5 | Trust, sensitivity, origin, scan decision, and retention class propagate from source evidence into every derived wrap-up, proposal, receipt, and owner write-intent without being upgraded by SAC. |
| RP05-6 | Evidence lifecycle enforces TTL **and deletion**: expired capability, evidence, and archive data are removed or cryptographically rendered inaccessible according to owner policy, with deletion evidence and unresolved references. |
| RP05-7 | Proposals remain immutable, reviewable candidates. A minimal wrap-up cannot auto-promote knowledge, bypass guarded owner writers, or establish a Flow state change. |
| RP05-8 | Maintain a controlled abuse corpus for secret/PII leakage, prompt injection, hidden-reasoning markers, poisoned summaries, policy confusion, and retention/deletion failures. |

## Success criteria

- No default path persists a full session transcript, prompt, or hidden reasoning.
- Every persisted minimal-evidence record is sealed-session or Flow-wrap-up
  bound, schema-valid, scanned, minimised, and retention-labelled.
- Every sensitivity/trust downgrade survives through proposal/review/write
  receipts; no consumer can treat a derived item as more trusted than its source.
- Expiry produces verified deletion/inaccessibility, not merely a stale
  capability while evidence remains readable.
- Security, lifecycle, replay, and abuse-corpus tests pass before a source is
  enabled for proposal creation.

## Risks

- Over-minimisation can remove material evidence; explicit field schemas and
  owner review are needed rather than transcript fallback.
- A privileged archive can become a de facto default store unless usage and
  deletion are independently audited.
- Deletion across backups, encryption keys, and owner systems requires a
  precise authority boundary and may need staged rollout.
- An abuse corpus can itself contain sensitive material; it must use synthetic
  or safely handled fixtures under Security ownership.

## Recommendation

Make the sealed minimal-evidence path the only proposal source first. Add any
restricted archive only after deletion, access, audit, and abuse tests are
proven. Keep all promotions owner-controlled and keep the raw transcript outside
SAC’s normal data plane.
