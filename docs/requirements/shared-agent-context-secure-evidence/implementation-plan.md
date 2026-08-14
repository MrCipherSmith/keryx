# Shared Agent Context — Secure Minimal Evidence: Implementation Plan
Version: 0.1.0

## Delivery status

**Future / planned; not implemented by this package.** The plan responds to
verified current gaps: verbatim session export before scan/minimisation, no
sealed terminal session requirement, and capability TTL without evidence
deletion. It does not claim those gaps are already fixed.

## Dependencies

- Harness/session supplies canonical terminal sealing and immutable revision
  identity; SAC does not invent session completion.
- Security owns schema validation, scan/minimisation, sensitivity rules,
  archive approval, and incident decisions.
- Parent SAC ACL/proposal/receipt contracts and Context Operations trace remain
  authoritative.
- Flow, Wiki, Memory, and Skills owners retain their write/lifecycle authority.

## Phased delivery

| Phase | Deliverable | Dependencies | Exit gate |
|---|---|---|---|
| 0 — contract alignment | Vocabulary, schemas, retention classes, owner matrix, abuse-corpus ownership. | Harness, Security, SAC, knowledge owners. | Signed fixtures; default archive disabled. |
| 1 — seal/provenance | Harness terminal sealing and one-time `WrapUpProvenance` verification. | Phase 0; identity/ACL. | Open/replayed/expired/cross-workspace cases deny before persistence. |
| 2 — minimal evidence | Schema-closed builder, Security scan/minimisation, trust/sensitivity propagation, minimised receipts. | Phase 1; Security strict gate. | Forbidden/unknown fields and non-pass scan states persist no payload. |
| 3 — lifecycle/delete | Retention scheduler, revocation, derivative/cache deletion, deletion receipts, incident handling. | Phase 2; protected storage. | Expired/revoked evidence becomes deleted/inaccessible in fixtures and drill. |
| 4 — proposal cutover | Proposal accepts only minimal sealed evidence and guarded owner receipt path. | Phases 1–3; parent lifecycle. | No auto-promotion, direct owner write, or Flow mutation path. |
| 5 — restricted archive | Separate protected archive exception, only if justified. | Phase 3; Security/Harness approval. | Access, encryption, expiry, delete, audit, and abuse gates all pass. |
| 6 — retirement | Disable legacy verbatim export as normal proposal evidence; inventory/restrict legacy data. | Phases 2–4; rollback readiness. | Compatibility window closed with owner sign-off. |

## Migration rules

1. Ship seal/provenance before consuming session output in a new proposal path.
2. Run scan/minimisation before the first durable candidate write; do not stage
   an unscanned transcript in a temporary SAC location.
3. Start with archive disabled. A request for archives is a separate Phase 5
   decision, not a fallback for an insufficient minimal schema.
4. Dual-read/dual-write is prohibited for raw transcript payloads. A temporary
   compatibility adapter may return typed `legacy-unavailable` metadata only.
5. Roll back by disabling the affected secure-evidence capability, revoking
   provenance, blocking reuse, and invoking owner deletion/incident policy;
   never roll back by altering Flow or accepted knowledge directly.

## Future work items

- Define JSON-schema/semantic validators and safe synthetic abuse fixtures.
- Add Harness seal state and proof issuance/consumption API.
- Implement strict Security-backed minimisation with bounded fields.
- Implement propagation types, deletion scheduler/receipt, and operator drill.
- Integrate proposal lifecycle with only sealed minimal evidence.
- Add protected archive only after a separately approved need and tests.

## Explicit deferrals

- Default transcript retention, chat-history search, and hidden-reasoning
  storage.
- Remote archive sharing, external egress, and cross-project federation.
- Automatic knowledge acceptance, self-authorised retention changes, or SAC
  administration of session/Flow/knowledge-owner lifecycles.
