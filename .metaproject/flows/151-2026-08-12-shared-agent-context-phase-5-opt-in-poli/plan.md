# Implementation Plan

Status: approved for implementation

## Approach

Add one SAC-local declarative experiment boundary. The candidate receives only
minimized, already-authorized selection features and may return only a bounded
selection recommendation. Host code owns ledger/outcome verification,
pseudonymization, quarantine, splits, scoring, protected-field validation,
sandbox evidence and activation. The existing deterministic assembler remains
the baseline and the automatic rollback target.

This keeps authorization, roles, security policy, Flow acceptance criteria and
the candidate artifact outside the learned surface. It also makes fixtures and
reports deterministic without teaching the generic security-eval binary
detector API about task outcomes.

Alternatives considered:

- Extend the generic `src/eval` detector corpus directly. Rejected because its
  binary false-negative contract cannot express independent task evidence,
  protected outputs, split leakage or activation pins without broad churn.
- Embed candidate behavior in the Harness security policy engine. Rejected
  because it would put experimental selection next to authorization and hard
  denies, violating the non-authority boundary.
- Launch arbitrary learned code directly from SAC. Rejected because it creates
  a second execution/sandbox path and an avoidable mutation surface.

## Steps

1. Write failing tests for full AccessReceipt hash/chain verification and
   refusal to append/use corrupt ledger state; centralize canonical hashing.
2. Write failing corpus tests for independent outcome digests, self-report
   rejection, field minimization/pseudonymization, revision allowlists,
   quarantine and deterministic disjoint train/holdout/adversarial partitions.
3. Implement the receipt verifier and the SAC policy-experiment corpus/manifest
   builder using only closed, allowlisted data contracts.
4. Write failing evaluation tests for protected output fields, unknown IDs,
   budget escape, non-determinism, sandbox failure, failed holdout/adversarial
   gates and pin mismatches.
5. Implement deterministic baseline/candidate comparison through an injected
   fail-closed read-only/network-off sandbox contract. Require paired successful
   control and denied escape evidence.
6. Implement exact candidate/corpus/baseline/report pins, default-off resolution,
   kill-switch precedence and automatic/explicit baseline rollback.
7. Publish synthetic offline corpus/manifest/evaluation fixtures and a Phase 5
   report that distinguishes mechanism proof from production effectiveness.
8. Run focused tests, full tests, typecheck, build, doc-link checks, Code Health,
   code-verifier and full review. Every remediation receives its own tests and
   review round until no problems remain.
9. Create the draft PR against `feat/shared-agent-context`, wait for required
   checks, merge, confirm every AC with evidence, complete Flow 151 and remove
   the worktree.

## Risks

- A locally mutable receipt ledger is not externally immutable. Report only
  verified hash continuity and quarantine uncertainty; never overclaim.
- Stable pseudonyms can leak through rare feature combinations. Keep the row
  schema minimal and corpus-scoped, with no free-form text.
- A failed sandbox launch can look like perfect containment. Require a passing
  normal-evaluation control alongside denied escape cases.
- Candidate output could become a discovery/authorization channel. Invoke only
  after visibility checks and validate it as a subset of supplied IDs within
  the existing budget.
- Synthetic fixtures prove the gate mechanics, not real-world policy gains.
