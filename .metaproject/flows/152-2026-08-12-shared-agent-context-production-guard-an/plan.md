# Implementation Plan

Status: draft (to be finalized after context collection)

## Approach

This flow is a delivery-hardening phase: keep all runtime gates unchanged and add
explicit production-readiness documentation and operator process for real data opt-in.

The policy-evaluation core (Phase 5) already enforces digest pinning, candidate/corpus
verifier requirements, sandbox constraints and rollback behavior. For the next phase we
turn this into an operator-run path by documenting exact artifact requirements, verification
steps, and rollout controls.

## Steps

1. Update requirements status: mark Phase 5 as complete and add explicit Phase 6 entry
   for production guard and real opt-in.
2. Add a dedicated runbook for real opt-in readiness:
   - canonical artifact set (`corpus`, `manifest`, `evaluation-report`, outcome artifacts, candidate/context baselines, sandbox-control artifacts)
   - exact verification order
   - pin matching requirements
   - gating gates and kill-switch semantics
   - rollback criteria
3. Extend existing phase prompt index to include the next phase so future work starts
   consistently.
4. Update README/metrics references so the package-level status is truthful:
   production mode remains synthetic-only mechanism until real operator process is completed.
5. Review all touched docs for consistency and close flow ACs with references to concrete
   evidence.

## Risks

- Overstating readiness from synthetic fixtures without operational evidence can
  accidentally become a launch precedent.
- Missing explicit operator process can cause accidental default-policy drift.
- Unclear evidence chain for real artifacts can make later incident response harder.
