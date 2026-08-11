# Managed Review Report — PR #265

## Scope and verdict

- Target: draft PR #265, `feat/sac-phase0-contract-alignment` → `feat/shared-agent-context`.
- Scope: complete merge-base range `feat/shared-agent-context...feat/sac-phase0-contract-alignment`.
- Context: Flow 143 frozen ACs; SAC specification, agent protocol, implementation plan, normative schemas; graph, accepted memory, testing and health baselines.
- Verdict: **REQUEST_CHANGES**. One major defect violates AC-1 and AC-2, so the PR is not ready to merge until it is remediated and re-reviewed.

## Stage 1 — acceptance-criteria compliance

All Phase 0 responsibilities are present and remain isolated from Flow state, MCP, persistence and knowledge stores. The UTC validation defect below means AC-1 and AC-2 are not satisfied.

## Findings

### [F-001] Impossible UTC calendar timestamps pass contract validation

- **Severity**: major
- **File**: `src/sac/index.ts:137,179,189,380`
- **Problem**: both the Draft 2020-12 `format: date-time` implementation and semantic UTC validator accept a syntactically UTC-looking but impossible date when `Date.parse` normalizes it. For example, a valid workspace fixture with `createdAt: "2026-02-30T00:00:00Z"` is returned as `{ valid: true, errors: [] }`.
- **Why it matters**: the specification requires the pinned format assertion/application parser to reject invalid UTC timestamps before persistence or egress. Accepting normalized dates also makes ordering and ledger causality operate on a different instant than the asserted artifact.
- **Fix**: replace `Date.parse` acceptance with one strict RFC3339 UTC parser: parse components, construct the UTC instant, require exact canonical component round-trip, and use it for schema format assertion, semantic UTC checks, ordering and ledger transition ordering. Add invalid day/month/hour cases and valid leap-day coverage.
- **Evidence**: `bun -e` reproduced `new Date("2026-02-30T00:00:00Z").toISOString()` normalizing the value; `validateSacContract` accepted the mutated checked-in valid workspace fixture. Focused suite did not cover impossible calendar values.
- **class_scope**:
  - **sites**: `src/sac/index.ts:137`, `src/sac/index.ts:179`, `src/sac/index.ts:189`, `src/sac/index.ts:380`
  - **enumeration_method**: `keryx ctx rg 'Date\\.parse' src/sac/index.ts` found exactly these four timestamp-validation and ordering sites.

## Review coverage

- Logic / architecture: reviewed. Isolation and ownership boundary are sound; no separate finding.
- Security / highload: reviewed. Trusted `ActorContext`, root containment, revalidation and fail-closed guard contracts are correctly scoped for Phase 0; no additional finding.
- Testing: reviewed. Focused test suite covers the required spoofing, cross-workspace, revocation, TOCTOU, symlink and guard-state paths, but misses invalid calendar-value coverage noted above.
- Style / clean code / performance: reviewed. No merge-blocking finding for this isolated, non-runtime-surface foundation.
- Strict synthesis: confirms F-001 is a major because it directly fails frozen AC-1/AC-2.

## Verification evidence

- `bun test src/sac/contracts.test.ts`: 12 pass, 0 fail.
- `bunx tsc --noEmit`: pass.
- CI checks for PR #265: all required checks successful.
- `git diff --check feat/shared-agent-context...feat/sac-phase0-contract-alignment`: pass.
- Health baseline: PASS, score 93 (pre-existing project baseline; no SAC-specific health regression claimed).

## Required disposition before merge

1. Remediate F-001 and add targeted invalid-calendar plus valid leap-day tests.
2. Run focused tests, typecheck and a fix-round managed review of the full merge-base range.
3. The fix round must resolve F-001 before the draft PR is made ready or merged into `feat/shared-agent-context`.
