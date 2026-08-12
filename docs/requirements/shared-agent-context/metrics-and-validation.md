# Keryx Shared Agent Context — Metrics and Validation
Version: 1.1.0

## Baseline and measurement principles

No performance claim is implied by this package. Before default enablement,
future implementation compares SAC-disabled and SAC-enabled runs on a fixed,
versioned offline corpus. Task success must be judged by independent project
verification, not agent self-report or retrieval volume.

## Required metrics

| Metric | Definition | Gate |
|---|---|---|
| Evidence completeness | material Facts with resolvable visible evidence / material Facts | 100% for acceptance corpus. |
| Work fidelity | normalized Work equality with Flow snapshot | 100% for corpus. |
| Permission containment | hidden refs disclosed in listing/read output | 0. |
| Unsafe persistence | raw transcript/secret/PII accepted as Know-how | 0. |
| Proposal integrity | proposals with actor/evidence/security/review fields | 100%. |
| Context efficiency | token/tool/time cost per independently verified task | Reported against baseline; no v1 improvement claim. |
| Freshness correctness | invalidated derived artifacts marked stale | 100% in fixtures. |
| Contract time correctness | UTC parsing, temporal ordering and monotonic transitions | 100% in fixtures/property tests. |
| Mandatory-context integrity | required item omitted from a successful overview | 0; return `context_overflow`. |
| Optional-context disclosure | omitted optional item without `partial` + `omittedOptional` ID | 0. |
| Availability | deterministic fallback when SAC disabled/unavailable | Existing outputs unchanged. |

## Validation suite

1. JSON Schema positive/negative fixture validation using a pinned validator
   with format assertion, followed by application semantic validation.
2. Property tests for canonical `SubjectId` ACL, forbidden content fields,
   workspace-relative realpath/root containment, UTC/temporal ordering,
   stale transitions and proposal state machine.
3. Integration tests for Flow projection, source-resolution and guarded target
   writes using fakes; no network dependency.
4. CLI/MCP semantic parity tests over the same contract fixtures.
5. Security tests for secrets, PII, prompt injection, spoofed actor,
   cross-workspace disclosure, revoked role, authorization/use TOCTOU and
   denied MCP tool and resource egress.
6. Fixed evaluation corpus of unfamiliar-component, handoff and blocked-work
   scenarios, each with independent verifier expectations.

## Minimum contract-fixture matrix

The first implementation must provide labelled fixtures/tests in addition to
the currently illustrative examples. Each negative fixture has exactly one
documented violating assertion where isolation is feasible.

| Contract | Required cases |
|---|---|
| Workspace | valid manifest; malformed ID; duplicate/conflicting `SubjectId` role; unsafe/escaping URI; invalid UTC or timestamp ordering. |
| FWK | valid receipt; missing evidence revision; bound Work missing canonical Flow ref; unbound Work carrying forbidden task/evidence fields; stale evidence. |
| Access | valid allowed/denied receipt; spoofed viewer mutation; revoked role; cross-workspace request; MCP resource/tool egress denial; Context Operations trace with selected/omitted items and policy/config revision. |
| Overview budget | required item overflow returns only typed `context_overflow`; optional omission returns `partial` and all `omittedOptional` IDs. |
| Proposal/review | valid proposed record; accepted proposal blocked by failed security gate, missing reviewer authority, stale evidence, missing policy version, missing target-write receipt, replayed idempotency key or causal-order violation. |
| Lifecycle | reject/dismiss/stale, target-write failure, retention/archival minimisation and immutable correction-link behavior. |
| Learning | independent outcome absent, hash/immutable receipt mismatch, unknown policy version, incomplete corpus manifest, holdout/adversarial failure and quarantine exclusion. |

## Rollout

Roll out in opt-in capability stages: schema-only → local read-only CLI →
read-only MCP → proposals/review → optional clients. Each stage has a feature
flag, owner, test evidence and documented rollback described in the
[implementation plan](implementation-plan.md). Default enablement requires all
mandatory acceptance criteria and no security regression.

Phase 5 remains blocked until the learning-fixture row is implemented and the
offline corpus has independently verifiable outcomes, hash/immutable receipt
links, policy versions, corpus selection/redaction/provenance manifest,
holdout/adversarial evaluation and quarantine handling. AccessReceipt `outcome`
alone is never sufficient learning ground truth.

## Rollback and incident triggers

Immediately disable the affected SAC capability on secret/PII persistence,
visibility bypass, Flow mutation path, untraceable Fact, or target-write
bypass. Preserve redacted audit evidence, invalidate derived outputs and use
the source owner's correction workflow. A learned-policy experiment rolls back
to the pinned deterministic policy on any quality or security non-regression
failure.
