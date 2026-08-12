# Shared Agent Context — Phase 6 Runtime Opt-in Readiness

Version: 1.0.0
Date: 2026-08-12
Status: planned

## Purpose

Phase 5 prepared an offline opt-in policy experiment with synthetic artifacts and an activation gate. Phase 6 makes runtime opt-in safe and practical: the FWK read path must only switch from deterministic baseline to candidate policy when explicit artifact pins, explicit hashes, and complete integrity validation succeed.

## Background from Phase 5

Phase 5 guarantees:
- corpus/outcome provenance and hash integrity,
- holdout/adversarial gate checks,
- candidate can be enabled only with exact pins and explicit rollback.

Phase 6 adds the missing runtime binding: no silent fallback to candidate on configuration drift, no ad-hoc artifact loading, and no execution when any dependency in the activation chain fails.

## Functional scope (runtime guard)

1) **Explicit artifact pins in workspace config**
- Add a runtime policy config file with explicit, typed pins for:
  - candidate artifact: `version`, `artifactRef`, `artifactDigest`
  - baseline artifact: `version`, `artifactRef`, `artifactDigest`
  - corpus manifest: `corpusVersion`, `corpusRef`, `corpusDigest`
  - evaluation report: `corpusVersion` (implicit via manifest), `reportRef`, `reportDigest`
- Config must also carry:
  - `enabled`, `killSwitch`, `rollbackReason?`, `rollbackBaselineVersion?`
  - `source` / revision marker for auditability.

2) **Strict integrity chain validation in fixed order**
- **Order (hard fail on any failure):**
  1. Load config.
  2. Resolve baseline artifact pin, verify sha256, parse and version/digest match.
  3. Resolve candidate artifact pin, verify sha256.
  4. Resolve corpus artifact pin, verify sha256.
  5. Resolve evaluation report pin, verify sha256.
  6. Validate corpus structure + manifest invariants via full corpus verifier.
  7. Validate report structure + recompute report digest.
  8. Resolve policy selection by calling deterministic activation logic.
- Any error, mismatch, parse failure, hash mismatch, schema failure, or activation mismatch returns baseline path and logs/records only metadata; no candidate selection is allowed.

3) **Fail-closed behavior**
- All errors are treated as **deny / baseline only**.
- If any artifact or digest is missing/mutated/invalid, do not partially enable candidate.
- If evaluation is unavailable or fails, selected policy is deterministic baseline.

4) **Kill-switch / rollback are mandatory controls**
- Runtime resolves candidate only when `enabled === true` and `killSwitch === false`.
- `rollbackReason`/`rollbackBaselineVersion` must be handled as explicit metadata.
- Rollback function still updates policy state to:
  - `enabled: false`
  - `killSwitch: true`

5) **No candidate-by-default**
- Default runtime config is disabled + kill-switch active.
- Candidate policy is never active unless config integrity chain and all checks pass.

6) **Compatibility and locality**
- Phase 6 is local-only and does not change public CLI/MCP schemas.
- It only affects policy-experiment selection at FWK read time.

## Non-goals for this phase

- Runtime online learning.
- Candidate policy self-modification.
- Candidate changes to roles/security/acceptance/Flow state.
- New policy editing UX beyond pin/config file editing.

## Acceptance criteria

- **AC1:** Runtime refuses candidate policy when config is malformed, missing pins, pin mismatch, unreadable files, or digest mismatch.
- **AC2:** Runtime resolves candidate only when artifact integrity chain and phase-order checks pass.
- **AC3:** Any single-file or schema failure is fail-closed to deterministic baseline.
- **AC4:** Candidate output is disabled by default; kill-switch blocks all activation.
- **AC5:** Rollback keeps candidate disabled and kill-switch active.
- **AC6:** Existing CLI/MCP parity tests still pass.

## Implementation tasks

1) Extend `PolicyExperimentConfig` with explicit artifact pins and source-references.
2) Add runtime loader in `createLocalFwkReadService`:
   - parse policy config from workspace policy-experiment path,
   - resolve referenced refs with strict containment,
   - verify sha256 for each pinned artifact,
   - parse and validate baseline/corpus/evaluation artifacts.
3) Integrate fail-closed `resolvePolicySelection` into `FwkReadService.resolve`:
   - apply candidate-selected IDs only when candidate activation fully passes,
   - otherwise fallback to deterministic baseline selector.
4) Add focused tests for:
   - valid pinned candidate activation path,
   - corrupted/missing pin chain failure baseline fallback,
   - invalid config/digest mismatch fail-closed,
   - kill-switch rollback keeps baseline behavior.
5) Update `implementation-plan.md` and `prd.md` phase status.
6) Document artifact pin file example for rollout ops.

## Suggested rollout

- Phase 6 remains optional until owner enables config `enabled: true` with valid pins.
- Keep candidate off-by-default in all repos.
- For a rollout, operator applies full 4-artifact config + report/corpus/baseline/candidate artifact files and restart service.
