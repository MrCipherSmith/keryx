# Shared Agent Context — Source-Owned Projections: Metrics and Validation
Version: 0.1.0

## Measurement principle

This package makes no performance or implementation-completion claim. Validation
tests future owner-port behavior against frozen owner fixtures and independently
verified write receipts; raw source text, self-reported agent success, and
retrieval volume are not substitutes for correctness.

## Required metrics and gates

| Metric | Definition | Release gate |
|---|---|---|
| Flow fidelity | Selected Work fields semantically equal to canonical Flow fixture | 100% of parity corpus |
| Explicit Flow selection | Multi-Flow workspace reads with explicit canonical selection | 100%; 0 positional/first-link selections |
| Evidence integrity | Facts with a visible, resolvable, revision/freshness-valid owner result | 100% of material Facts |
| Owner-derived Know-how | Trust/applicability values sourced from owner result | 100%; 0 regex-derived decisions |
| Source containment | SAC-owned copies of Flow/Wiki/Memory/Skills content | 0 |
| Write-path integrity | Accepted Wiki writes with bound canonical owner receipt | 100%; 0 direct body writes |
| Failure honesty | Incorrect authoritative successful result on denied/stale/unavailable input | 0 |
| Trace ownership | Duplicate SAC assembly/retrieval traces | 0 |

## Fixture and test matrix

| Area | Minimum cases |
|---|---|
| Flow port | Canonical snapshot; unbound workspace; denied Flow; stale/unavailable Flow; revision change; multiple links with/without explicit `workFlowRef`; status/AC/blocker/evidence parity. |
| Evidence port | Visible current evidence; revoked visibility; expired evidence; revision mismatch; unknown type; hash/path supplied without owner resolution; owner trust/provenance extension. |
| Wiki/Memory/Skills read ports | Accepted/reviewed as defined by the owner; withdrawn; stale; not applicable; denied; contract-version mismatch; deceptive Markdown `Status:` text that must not affect the result. |
| Wiki write port | Valid accepted intent; security denial; missing reviewer authority; stale evidence; malformed target; direct-file-writer attempt; idempotent replay; receipt correlation/intent mismatch. |
| Cross-boundary | Context Operations trace is reused; Flow mutation methods are absent; SAC storage contains references/receipts only; disabled/rolled-back port leaves existing owner behavior unchanged. |

## Validation sequence

1. Owners publish versioned contract fixtures and semantic comparators.
2. Unit tests validate each port, including denied/stale/withdrawn/unavailable
   states and contract-version incompatibility.
3. Integration tests assemble FWK through ports and verify the canonical
   Context Operations trace is referenced rather than duplicated.
4. Security tests exercise spoofed actor, cross-workspace source, ACL revocation
   between authorisation and read/write, injected Markdown status, and direct
   Wiki body-write bypass attempts.
5. Migration tests run typed-port and legacy-adapter paths against the same
   fixture corpus; cutover is permitted only on semantic parity and owner sign-off.
6. Rollback tests disable an individual port/capability and confirm no source
   mutation, no fallback to raw parsing, and no change to existing owner APIs.

## Evidence required for cutover

Each owner migration records contract version, fixture set digest, owner
approval, compatibility result, security review, and rollback owner. SAC may
record these as minimised references/receipts only. A metric miss blocks the
affected source migration; it does not authorise a lossy fallback.
