# Shared Agent Context — Production guard and real opt-in data readiness

Status: draft (flow-init skill formalizes this)
Source: prior phase completion + operator readiness request

## Problem

Phase 5 proves the offline mechanism for learned-policy candidate evaluation, but all
published artifacts are synthetic and intentionally non-production. The current code
surface is not yet ready for real opt-in rollout without explicit operator process:
real candidate artifacts, verified outcome evidence, and rollout/rollback controls are
not yet operationally documented or standardized for use.

The immediate gap is not the cryptographic or sandbox gate mechanics — those are in
place. The gap is production-readiness and trust posture: how operators prepare,
verify, and load real evaluation data without weakening the mandatory off-by-default,
kill-switch-first posture.

## Expected Outcome

After this flow:

- `Shared Agent Context` phase status is updated to reflect completion of Phase 5.
- The requirement package contains a dedicated production guard + real opt-in readiness
  playbook.
- The playbook defines strict prerequisites and exact artifact verification steps before
  any candidate policy can be considered for any non-default experiment path.
- A concrete phase sequence is documented so real data can be introduced in a bounded,
  auditable, rollback-friendly way.
- A clear boundary remains: default behavior is unchanged unless explicit opt-in is
  applied and all gates pass.

## Out of Scope

- Online policy learning, automatic policy deployment, autonomous model updates.
- Changes to existing SAC authorization, Flow state mutation paths, or security policy engines.
- New runtime candidate egress or persistence channels before this guard is separately
  approved.
- Claims that synthetic evidence implies production outcome improvement.
