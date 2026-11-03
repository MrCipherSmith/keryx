# Understandable Hub acceptance
Version: 0.1.1

Status: draft specification; runtime implementation is not started by this package.

A reviewer should understand what changed, how to try it, what each criterion is supported by, and what accepting or returning actually does. Hashes remain enforceable but move out of the primary reading path.

## Documents

- [PRD](prd.md): problem, requirements and success criteria.
- [Specification](specification.md): screen, metadata, lifecycle and acceptance criteria.
- [Implementation plan](plan.md): delivery sequence and verification matrix.
- [Review guide schema](schemas/review-guide.schema.json): optional immutable explanatory artifact.
- [Review report schema](schemas/review-report.schema.json): explicit canonical guide selector in the existing report string.
- [Legacy review schema](schemas/legacy-review.schema.json): proposed return, receipt and resubmission contracts.

## Scope

Canonical Work Flow/Intent/Attempt acceptance and a compatible review experience for existing legacy Flows. Preserve current authorization, immutable Evidence and exact-target acceptance. Add a real commented request-changes path for legacy review. No execution, Git publication, agent orchestration or automatic product acceptance.

## Related contracts

- [Work metadata](../hub-work-management/specification.md) and [protocol](../hub-work-management/metadata-protocol.md).
- [Hub status example](../hub-status/report.md): the real usability trigger.

The completed hub-status Flow is a read-only regression example, never reopened for this feature. Implementation and user-facing tests use disposable seeded fixtures.
