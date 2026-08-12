# Review Report — Round 1

## Verdict: REQUEST_CHANGES

### F-001: Activation trusted a stale report digest and unbounded IDs

- Severity: blocker
class_scope:
- sites: `src/sac/policy-experiment.ts:555`
- enumeration_method: routed search enumerated all `resolvePolicyExperiment`, `reportDigest`, and `candidateSelectedIds` uses.
- File: `src/sac/policy-experiment.ts:563`
- Problem: activation did not recompute the report digest or constrain report IDs to the current deterministic baseline.
- Impact: tampered evaluation content could widen runtime selection.
- Suggested fix: recompute canonical digest and require a duplicate-free runtime subset.
- Evidence: the sole resolver returned `candidateSelectedIds` verbatim.
- Confidence: high
- Class scope: `src/sac/policy-experiment.ts:555`; enumerated all `resolvePolicyExperiment`, `reportDigest`, and `candidateSelectedIds` uses with routed search.

### F-002: Independent outcome evidence was caller-attested

- Severity: blocker
class_scope:
- sites: `src/sac/policy-experiment.ts:218`, `src/sac/policy-experiment.ts:245`, `src/sac/policy-experiment.ts:259`
- enumeration_method: routed search enumerated all outcome ingestion and verifier checks.
- File: `src/sac/policy-experiment.ts:245`
- Problem: malformed or fabricated outcome/artifact metadata could be self-hashed and admitted.
- Impact: receipt self-report could be disguised as independent corpus evidence.
- Suggested fix: closed outcome validation plus owner-resolved artifact bytes and opaque trusted evidence.
- Evidence: the only admission path checked strings and hash syntax without artifact resolution.
- Confidence: high
- Class scope: `src/sac/policy-experiment.ts:218`, `src/sac/policy-experiment.ts:245`, `src/sac/policy-experiment.ts:259`; enumerated all outcome ingestion and verifier checks.

### F-003: Pseudonyms were linkable across corpus versions

- Severity: blocker
class_scope:
- sites: `src/sac/policy-experiment.ts:265`, `src/sac/policy-experiment.ts:268`, `src/sac/policy-experiment.ts:269`, `src/sac/policy-experiment.ts:270`
- enumeration_method: routed search enumerated every `pseudonym` call.
- File: `src/sac/policy-experiment.ts:265`
- Problem: HMAC domains omitted corpus and pseudonymizer revisions.
- Impact: key reuse linked identities across otherwise separate corpora.
- Suggested fix: bind both immutable revisions into every pseudonym domain.
- Evidence: all four pseudonym sites used only the caller key plus entity value.
- Confidence: high
- Class scope: `src/sac/policy-experiment.ts:265`, `src/sac/policy-experiment.ts:268`, `src/sac/policy-experiment.ts:269`, `src/sac/policy-experiment.ts:270`; enumerated every `pseudonym` call.

### F-004: Evaluation did not detect candidate nondeterminism

- Severity: blocker
class_scope:
- sites: `src/sac/policy-experiment.ts:455`
- enumeration_method: routed search enumerated all sandbox execution sites.
- File: `src/sac/policy-experiment.ts:455`
- Problem: each case executed once.
- Impact: a stateful/random candidate could pass holdout and fail on replay.
- Suggested fix: execute canonical requests twice and fail on differing outputs.
- Evidence: one production `sandbox.run` call existed.
- Confidence: high
- Class scope: `src/sac/policy-experiment.ts:455`; enumerated all sandbox execution sites.

### F-005: Baseline pin was not bound end-to-end

- Severity: blocker
class_scope:
- sites: `src/sac/policy-experiment.ts:318`, `src/sac/policy-experiment.ts:505`, `src/sac/policy-experiment.ts:579`
- enumeration_method: routed search enumerated every `baselineVersion` use.
- File: `src/sac/policy-experiment.ts:505`
- Problem: caller-selected evaluation baseline was not required to equal the corpus manifest baseline.
- Impact: evaluation and activation could refer to different deterministic baselines.
- Suggested fix: enforce manifest/report/config baseline equality at evaluation and activation.
- Evidence: all baseline publication/consumption sites were enumerated.
- Confidence: high
- Class scope: `src/sac/policy-experiment.ts:318`, `src/sac/policy-experiment.ts:505`, `src/sac/policy-experiment.ts:579`; enumerated every `baselineVersion` use.

### F-006: Sandbox controls were self-attested

- Severity: major
class_scope:
- sites: `src/sac/policy-experiment.ts:424`, `src/sac/policy-experiment.ts:455`
- enumeration_method: routed search enumerated sandbox validation and invocation.
- File: `src/sac/policy-experiment.ts:424`
- Problem: free booleans and a profile object stood in for paired containment evidence.
- Impact: an in-process callback could claim kernel containment.
- Suggested fix: require opaque candidate/profile-bound paired-control evidence.
- Evidence: `validSandbox` trusted two booleans and a free callback.
- Confidence: high
- Class scope: `src/sac/policy-experiment.ts:424`, `src/sac/policy-experiment.ts:455`; enumerated sandbox validation and invocation.

### F-007: Receipt append reverified the complete ledger

- Severity: major
class_scope:
- sites: `src/sac/fwk-service.ts:121`
- enumeration_method: routed search enumerated every ledger read, verify, and append site.
- File: `src/sac/fwk-service.ts:121`
- Problem: every append parsed and rehashed all historical receipts under the lock.
- Impact: cumulative O(N²) work and growing lock contention.
- Suggested fix: use an atomic protected checkpoint with full-audit recovery.
- Evidence: this was the sole live AccessReceipt append writer.
- Confidence: high
- Class scope: `src/sac/fwk-service.ts:121`; enumerated every ledger read/verify/append site.

### F-008: Candidate execution had no deadline

- Severity: major
class_scope:
- sites: `src/sac/policy-experiment.ts:455`
- enumeration_method: routed search enumerated the sole sandbox execution site and the absence of timeout primitives.
- File: `src/sac/policy-experiment.ts:455`
- Problem: a hung candidate blocked the offline evaluation indefinitely.
- Impact: no evaluation gate or rollback decision could be produced.
- Suggested fix: enforce an abortable per-case deadline and typed fail-closed timeout.
- Evidence: no timeout or AbortSignal existed around the only sandbox invocation.
- Confidence: high
- Class scope: `src/sac/policy-experiment.ts:455`; enumerated the sole sandbox execution site and absence of timeout primitives.

### F-009: Receipt validation duplicated the canonical schema owner

- Severity: minor
- File: `src/sac/receipt-integrity.ts:113`
- Problem: ledger integrity validation mirrors the access-receipt contract.
- Impact: future schema evolution may drift between validators.
- Suggested fix: share a synchronous canonical validation primitive in a follow-up refactor.
- Evidence: pattern and exact-key validators exist in both receipt-integrity and SAC contract modules.
- Confidence: high

## Stats

- blocker: 5
- major: 3
- minor: 1
- info: 0

## Skill Learning

- none
