# Shared Agent Context — Identity and Capability Metrics and Validation
Version: 0.1.0

## Status

**Future / planned validation.** These are security gates and proposed measures, not evidence that any remote mode is ready. Execution metrics for this documentation run are disabled.

## Mandatory security suites

| Suite | Required proof |
|---|---|
| Mode selection | Each ingress resolves exactly one declared mode; remote/HTTP/unknown transport is denied before routing or workspace discovery. |
| Trusted identity | Client-supplied subject/role/reviewer/owner/capability fields cannot change authority; same-UID multi-agent executions are distinguishable. |
| Live strict policy | Provider outage, exception, advisory result, stale revision, fabricated pass, and `needs-approval` deny every protected operation. |
| Capability scope | Wrong action, resource, workspace, owner, target, audience, workflow binding, expiry, or status denies without disclosure. |
| Delegation | Child capability cannot outlive or broaden parent; chain cycles, aliasing, revocation, and parent mismatch fail closed. |
| Continuous authorization | Revoke capability, revise role, change ACL/target/policy after issue and before use; next read/write is denied. |
| Transport abuse | Replay, confused deputy, token passthrough, cross-workspace probing, and attempted remote capability use fail before target access. |

## Remote abuse gates

`remote` remains denied unless a future, separately authorised release demonstrates all gates below against the exact future verifier and deployment model. Passing a unit test alone is insufficient and does not activate remote transport.

1. Verified-principal verification is independent of caller-provided claims.
2. Capability replay and token passthrough are rejected across processes/adapters.
3. Confused-deputy cases cannot turn a local service audience into another owner/service audience.
4. Cross-workspace enumeration and direct access return no hidden existence signal.
5. Revocation, expiry, policy revision, and role revision take effect at the next use.
6. Rate/abuse controls, audit minimisation, incident handling, and key/issuer lifecycle are designed and independently reviewed.
7. A human approval explicitly enables a bounded remote rollout; no default or migration enables it.

## Acceptance gates

- All suites run through CLI, Harness, MCP, and owner-adapter call paths with identical authorization outcomes for equivalent requests.
- Fault injection at live policy-provider and capability-store boundaries proves fail-closed behavior.
- Same-UID local multi-agent fixtures prove distinct `executionSubject` provenance and cross-agent capability denial.
- A revoked capability and changed role/ACL/policy revision are denied on the next operation, not merely after cache expiration.
- No HTTP/remote listener, route, or remote capability acceptance is enabled by these tests or package artifacts.

## Proposed operational measures

Record minimised counters for central transport denials, policy-provider failures, capability issue/use/revocation outcomes, audience/scope mismatches, stale-role denials, and same-UID cross-agent attempts. Segment by mode and action class, retain no tokens or raw identities in aggregate metrics, and set future thresholds only after representative local baseline data exists.
