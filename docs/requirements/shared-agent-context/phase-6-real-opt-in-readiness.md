# Shared Agent Context — Phase 6: Production guard and real opt-in data readiness

## Status

Planned (not yet implemented in runtime surface).

## Purpose

Phase 5 validated the experiment mechanism on synthetic fixtures. Phase 6 defines
the strict preconditions for using the same mechanism with real operator-supplied
artifacts. It does **not** authorize automatic online learning.

## Readiness prerequisites

1. Artifact set is complete and immutable by path/hash:
   - `manifest.json` (published corpus manifest with digest, splits, provenance)
   - `corpus.json` (rows + quarantines)
   - `evaluation-report.json` (digest-bound with holdout/adversarial/pass status)
   - `receipts.jsonl` (hash-chain ordered AccessReceipts)
   - Independent verifier outcome artifacts for every accepted row
   - Baseline artifact and candidate artifact bytes
   - Sandbox control artifacts referenced in the evidence process
2. Candidate pin is explicit in operator config:
   - candidate version
   - candidate artifact digest
   - candidate corpus version/digest
   - baseline version/digest
   - evaluation-report digest
3. Rollback plan is documented and approved before enabling non-default path.

## Mandatory verification order (minimum)

1. Validate artifact file existence and declared SHA-256 hashes.
2. Validate corpus manifest integrity:
   - manifest hash check
   - policy/config version allowlists
   - deterministic split signatures
   - quarantine reason counts and excluded-all-splits semantics
3. Rebuild trust chain checks:
   - AccessReceipt ledger integrity (schema + hashes + predecessor checks)
   - outcome linkage and independent-verifier hash checks
4. Verify evaluation report digest and fields:
   - report digest match
   - status/pass and required gates passed
   - securityNonRegression true
5. Verify candidate pin match:
   - candidate version/digest and corpus/digest equality to manifest
   - baseline pins against manifest and report
   - kill switch inactive only when explicitly and review-approved
6. Verify sandbox control/evidence expectations per `PolicyExperimentSandbox` contract.

## Fail-closed rules

If any step fails, candidate policy **must not** be enabled, and baseline behavior
must remain the active decision source.

## Rollback

- Set kill switch active and disable opt-in.
- Preserve immutable audit metadata.
- Do not alter accepted knowledge, roles, security policy objects, or Flow acceptance
  state through this mechanism.

## Exit criteria

- No operator step is skipped.
- Every required gate is evidenced and reviewable.
- The default deny posture is preserved when incomplete evidence or mismatch exists.
