# Shared Agent Context — Source-Owned Projections: Implementation Plan
Version: 0.1.0

## Delivery status

**Future plan; not implemented by this package.** The verified current gaps
that motivate this plan are raw Flow JSON projection, positional/first-Flow
selection and lossy Work mapping; resource/hash evidence handling; Markdown
status-regex Know-how trust; and direct Wiki body writes. Completion must be
recorded by future owner-approved Flows and tests, not by this document.

## Prerequisites

- Parent SAC identity, ACL, receipt, proposal, and fail-closed security
  contracts remain authoritative.
- Flow, evidence, Wiki, Memory, and Skills owners nominate their port and
  compatibility maintainers.
- Context Operations exposes/reuses its canonical assembly trace boundary.
- Wiki has an approved canonical decision/body write capability before any
  direct path is removed.

## Phased migration

| Phase | Deliverable | Dependencies | Exit gate |
|---|---|---|---|
| 0 — ownership and contracts | Shared error taxonomy; versioned typed contracts; frozen owner fixtures and comparators. | Owner maintainers, Security, Context Operations. | Owner sign-off; no SAC-owned source-content schema. |
| 1 — Flow and evidence ports | Read-only `FlowProjectionPort` and `EvidenceProjectionPort`; explicit canonical Flow selection. | Phase 0; Flow/evidence identity and revision semantics. | AC-1–AC-4 fixture parity; no Flow mutator in SAC. |
| 2 — Know-how read ports | Separate Wiki, Memory, Skills projection ports returning lifecycle, trust, applicability, visibility, revision. | Phase 0; each owner’s lifecycle contract. | AC-1 and AC-5; Markdown text cannot affect trust/applicability. |
| 3 — FWK/assembly cutover | SAC resolves all FWK sources through ports and delegates bounded assembly to Context Operations. | Phases 1–2; parent SAC ACL/receipt contract. | AC-2–AC-5 and AC-7; no second assembly trace/store. |
| 4 — canonical Wiki write | `WikiDecisionWritePort` plus guarded receipt/idempotency integration in proposal review. | Phase 2; canonical Wiki writer; Security and proposal lifecycle. | AC-6 with adversarial write-bypass tests. |
| 5 — retirement | Remove raw Flow JSON/first-link projection, Markdown-regex trust, and direct Wiki body-write production paths. | Phases 3–4; migration telemetry and rollback test. | All ACs, owner acceptance, compatibility window closed. |

## Dependency and migration rules

1. Do not begin consumer cutover until the relevant owner port and fixtures are
   versioned and approved.
2. Run legacy compatibility adapters only behind an explicit contract version,
   feature flag, and telemetry that contains no raw source content. An adapter
   must expose typed errors; it must not hide old heuristic decisions.
3. Migrate read paths independently by source owner; a failure in one owner
   cannot cause SAC to treat another source as an equivalent substitute.
4. Introduce canonical Wiki writing before disabling direct writes, then prove
   replay/idempotency, security, and receipt parity before removal.
5. Keep rollback source-local: disable the affected SAC adapter/capability,
   preserve owner data, invalidate derived receipts, and never roll back by
   editing Flow or durable knowledge outside its owner correction path.

## Work breakdown for future Flows

- Define public owner-port type packages and contract-fixture locations.
- Implement the Flow semantic comparator and explicit Flow-selection resolver.
- Implement evidence resolution semantics and negative security fixtures.
- Implement each Know-how owner adapter with applicability/trust vocabulary.
- Integrate port results into the existing Context Operations assembly path.
- Implement and owner-review canonical Wiki decision/body writer integration.
- Add migration dashboard/checks, cutover flag, rollback exercise, and removal
  change only after all owner gates pass.

## Explicit deferrals

- New Flow authoring/tracking capabilities.
- Copying/synchronising durable knowledge into SAC.
- Automatic proposal acceptance, remote source ports, and cross-project
  federation.
- Learned-policy changes or any policy that overrides owner trust, ACL, or
  security decisions.
