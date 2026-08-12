# Shared Agent Context — Phase 5: Opt-in policy experiment

Status: approved for implementation
Source: user description

## Problem

Shared Agent Context emits metadata-only, SHA-256-linked AccessReceipts, but it
has no verifier for the ledger, no independently grounded task-outcome
contract, no minimized offline learning corpus, and no safe policy-experiment
activation boundary. A receipt's optional self-reported outcome cannot serve as
training or evaluation truth. Without an explicit corpus/evaluation protocol,
a learned policy could be enabled from unverifiable data or gain authority over
security-sensitive state.

## Expected Outcome

Phase 5 provides an offline, deterministic and default-disabled experiment:
receipt chains are verified before use, independently hash-bound outcomes are
the only labels, corpus output is allowlisted and pseudonymized, suspicious
records are quarantined, and a published manifest records provenance,
selection, redaction, splits and adversarial cases. A pinned candidate is
compared with the deterministic baseline only through a fail-closed sandbox
contract. Exact pins, passing holdout/adversarial gates, an explicit opt-in and
an inactive kill switch are all required; every failure rolls back to the
baseline.

## Out of Scope

- Online learning or model-weight updates.
- Default activation or automatic exposure of a candidate policy.
- Candidate authority over roles, ACLs, security gates, Flow acceptance
  criteria/state, policy configuration, or candidate code.
- Raw prompt, transcript, hidden-reasoning, secret, PII or retrieved-content
  persistence.
- Remote corpus transport, cloud sync, MCP mutation tools or a new policy
  engine/sandbox.
- Claims that a local hash chain is externally signed or tamper-proof.
