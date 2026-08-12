# Shared Agent Context — Phase 6: Opt-in readiness (runtime guard + real-data readiness)

## Status

Partially implemented.

- **Part A — Runtime enforcement guard:** implemented in the runtime surface
  (`src/sac/fwk-service.ts` → `resolvePolicySelection`). AC1–AC6 met; full SAC
  suite `bun test src/sac/` → 88 pass / 0 fail.
- **Part B — Real operator-data readiness:** planned. Governs enabling the same
  mechanism with real, non-synthetic operator-supplied artifacts.

## Purpose

Phase 5 validated the experiment mechanism on synthetic fixtures. Phase 6 makes
opt-in to the candidate policy safe in two complementary parts: **(A)** a
fail-closed runtime guard that switches from the deterministic baseline to the
candidate policy only when explicit pins and a complete integrity chain succeed,
and **(B)** the operator readiness process and evidence prerequisites required
before that guard is fed real, non-synthetic artifacts. Neither part authorizes
automatic online learning.

## Part A — Runtime enforcement guard (implemented)

Code: `src/sac/fwk-service.ts` → `resolvePolicySelection` / `resolvePolicySelectionSafely`,
wired into `FwkReadService.resolve` and `createLocalFwkReadService`. Config path:
`.metaproject/context-operations/policy-experiment/config.json`.

### Behavior

- **Explicit typed pins** in workspace config for candidate/baseline artifacts,
  corpus manifest and evaluation report (each: ref + sha256 digest + immutable
  version), plus `enabled`, `killSwitch`, optional `rollbackReason` /
  `rollbackBaselineVersion`.
- **Strict fixed-order integrity chain** (hard fail → baseline on any failure):
  1. Load config.
  2. Baseline artifact pin → verify sha256, parse, version/kind match.
  3. Candidate artifact pin → verify sha256, parse, kind match.
  4. Corpus artifact pin → verify sha256, full corpus verifier + manifest invariants.
  5. Evaluation report pin → verify sha256, structure, recompute report digest.
  6. Deterministic activation via `resolvePolicyExperiment`; candidate applied
     only when `source === "candidate"`.
- **Fail-closed:** any error / mismatch / parse / hash / schema / activation
  failure returns the deterministic baseline; candidate is never partially enabled.
- **Candidate-off-by-default:** absent config, `enabled !== true`, or
  `killSwitch !== false` → baseline.
- **Rollback** (`rollbackPolicyExperiment`) forces `enabled: false, killSwitch: true`.
- **Local-only:** does not change public CLI/MCP schemas.

### Acceptance criteria (met)

- **AC1** — refuse candidate on malformed / missing pins, pin mismatch,
  unreadable files, or digest mismatch.
- **AC2** — candidate only when the full integrity chain and phase-order checks pass.
- **AC3** — any single-file or schema failure is fail-closed to deterministic baseline.
- **AC4** — candidate off by default; kill-switch blocks activation.
- **AC5** — rollback keeps candidate disabled and kill-switch active.
- **AC6** — existing CLI/MCP parity tests still pass.

Evidence: `src/sac/fwk-service.test.ts`; full SAC suite `bun test src/sac/` →
88 pass / 0 fail.

## Part B — Real operator-data readiness (planned)

Part A enforces the runtime integrity chain on whatever artifacts are pinned.
Part B governs what must be true of the **real, non-synthetic** artifacts and the
operator process before that path is enabled outside synthetic evidence.

### Readiness prerequisites

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

### Mandatory verification order (minimum)

Steps 1, 2, 4 and 5 are enforced today by the Part A runtime guard for the pinned
artifacts; Part B additionally requires the real-data evidence in steps 3 and 6
(receipts hash-chain, independent-verifier outcome linkage, sandbox controls,
`securityNonRegression`).

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

### Fail-closed rules

If any step fails, candidate policy **must not** be enabled, and baseline behavior
must remain the active decision source.

### Rollback

- Set kill switch active and disable opt-in.
- Preserve immutable audit metadata.
- Do not alter accepted knowledge, roles, security policy objects, or Flow acceptance
  state through this mechanism.

### Exit criteria

- No operator step is skipped.
- Every required gate is evidenced and reviewable.
- The default deny posture is preserved when incomplete evidence or mismatch exists.
