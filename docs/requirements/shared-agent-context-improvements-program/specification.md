# Shared Agent Context Improvements Program — Specification
Version: 0.1.0

## Program identity

Package ID: `shared-agent-context-improvements-program` (`SAC-IP`). It is a
documentation and orchestration contract. Runtime state remains owned by the
child packages, Flow, and their implementation modules.

## Package registry

| ID | Package | Priority | Size | Hard prerequisites |
|---|---|---:|---:|---|
| RP-12a | Documentation taxonomy/evidence/coverage | P0 | S | none |
| RP-01 | Runtime Truth | P0 | M | RP-12a baseline characterization |
| RP-04 | Promotion Integrity | P0 | M–L | RP-12a characterization |
| RP-05 | Secure Evidence | P0 | M–L | RP-12a characterization |
| RP-06a | Live Local Policy slice | P0/P1 | M | RP-12a characterization |
| RP-02 | Source-owned Projections | P0/P1 | M–L | RP-01 contracts |
| RP-03 | Lifecycle Binding | P1 | M | RP-04, RP-02 contracts |
| RP-09 | Unified Operations | P1 | M | RP-01, RP-03, RP-06a contracts |
| RP-12b | Generated operation docs/examples/CI | P0/P1 | S–M | RP-09 registry |
| RP-10 | Receipts and Provenance | P1 | M–L | RP-01 receipt contract |
| RP-07 | Generational Memory | P1/P2 | L | RP-05, RP-02 |
| RP-08 | Collaboration and Worktrees | P2 | L | RP-03, RP-06a |
| RP-11 | Evaluation and Orchestration | P1/P2 | M–L | measurable outputs from prior packages |
| RP-06b | Remote capabilities | conditional | L | RP-06a, RP-08, RP-11 evidence plus separately governed post-evaluation approval |

RP-12 is one documentation package delivered in two slices: RP-12a establishes
taxonomy, evidence pinning, and graph/wiki coverage before runtime work;
RP-12b consumes the future RP-09 operation registry to generate executable
operation documentation, examples, and CI drift gates. RP-06 is one documentation package but must be delivered as separate local and
remote implementation slices. RP-06b is not part of the first three milestones.

## Dependency graph

```text
RP-12a
  +--> RP-01 --> RP-02 --> RP-03 --> RP-09
  |       |         |        |
  |       +--> RP-10|        +--> RP-08
  |                 +--> RP-07       |
  +--> RP-04 ------------^            |
  +--> RP-05 --------> RP-07          |
  +--> RP-06a -------> RP-03/RP-08 ---+
                                       v
                           RP-09 --> RP-12b
                                       |
                                     RP-11
                                       |
                         retain/remove/defer evidence
                                       |
                  separate governed approval, if any
                                       |
                       RP-06b / learned policy / UI
```

## Status contract

Allowed package and phase states:

- `not-started` — requirements exist, no Flow accepted;
- `planning` — Flow exists, scope and acceptance are not yet frozen;
- `ready` — dependencies pass and acceptance is frozen;
- `implementing` — bounded implementation is active;
- `review` — implementation complete, adversarial review active;
- `verification` — review blockers fixed, quality/security/evidence gates active;
- `blocked` — a named dependency, decision, or failed gate prevents progress;
- `complete` — implementation, review, verification, docs, and rollback evidence pass;
- `rolled-back` — delivered behavior was disabled/reverted with evidence;
- `deferred` — owner explicitly postponed work with rationale;
- `removed` — owner rejected the capability after evaluation.

Only `complete`, `rolled-back`, `deferred`, and `removed` are terminal. A child
package's documentation status does not advance runtime state.

## Progress record

Each dashboard row contains:

- package and current phase;
- owner and Flow ID;
- dependency status and waivers;
- planned/started/updated/completed timestamps;
- blocker and risk counts by severity;
- acceptance criteria passed/total;
- review blockers/warnings and reopened count;
- verification gates passed/total;
- test/security/health evidence references;
- rollback readiness and evidence;
- product outcome baseline/delta where applicable;
- next action and responsible subject.

The dashboard is a human-readable projection, not the source of truth. Flow and
verification artifacts remain authoritative.

## Aggregate statistics

- **Package completion:** terminal-complete packages / accepted packages.
- **Weighted completion:** sum of passed phase weights / total accepted phase
  weights; P0 blocker presence is always shown separately.
- **Acceptance progress:** passed child AC / total child AC.
- **Gate pass rate:** passed required verification gates / executed required
  gates.
- **Cycle time:** active time from `ready` to `complete`, excluding blocked time.
- **Blocked ratio:** blocked active time / total elapsed active time.
- **Review escape rate:** findings discovered after package completion / total
  findings.
- **Reopen rate:** reopened findings / closed findings.
- **Risk retirement:** closed accepted risks / baseline accepted risks.
- **Outcome delta:** independently verified task/security/UX metric versus the
  frozen baseline.

No aggregate percentage may hide an unresolved P0 blocker. Unknown values stay
`unknown`; they do not become zero.

## Wave rules

Work may run in parallel only when:

1. all hard prerequisites are complete or an owner waiver is recorded;
2. packages do not mutate the same source contracts or shared documentation;
3. each package has a separate Flow and worktree;
4. integration checkpoints and merge order are named;
5. one package cannot silently redefine another package's accepted contract.

The initial documentation creation may be parallel because outputs are isolated.
Runtime implementation follows the stricter dependency graph.

## Evidence contract

Every completed package links:

- accepted requirements version and commit;
- Flow completion record;
- implementation diff/PR;
- review verdict and resolved blockers;
- tests, security, health, and migration evidence;
- updated current-behavior documentation;
- rollback command/procedure and proof;
- baseline and post-change outcome report when the package claims improvement.

Agent statements, test counts without commit/date, and screenshots without
machine-readable results are not sufficient evidence.

## Integration checkpoints

- **IC-1:** RP-01 descriptor/plan contracts agree with RP-02 owner projections.
- **IC-2:** RP-04 link-back agrees with RP-03 lifecycle and RP-09 operations.
- **IC-3:** RP-05 trust/sensitivity states agree with RP-07 memory transitions.
- **IC-4:** RP-06 capabilities agree with RP-08 handoff/worktree scope.
- **IC-5:** RP-10 receipts expose the measurements RP-11 evaluates.
- **IC-6:** RP-12 truth-sync gates cover every shipped operation and package.

## Acceptance criteria

- **AC-01:** all twelve child packages are linked with dependency, priority,
  owner placeholder, state, and evidence fields.
- **AC-02:** every implementation phase has a copy-ready prompt and exit gate.
- **AC-03:** the dashboard calculates completion and blocked/risk statistics
  without treating unknown as zero.
- **AC-04:** unresolved P0 blockers remain visible independent of aggregate
  completion.
- **AC-05:** a package cannot become complete without requirements, review,
  verification, documentation, and rollback evidence.
- **AC-06:** dependency waivers name approver, rationale, risk, expiry, and
  compensating verification.
- **AC-07:** parallel waves have isolated worktrees and explicit integration
  checkpoints.
- **AC-08:** conditional expansion cannot start from an RP-11 decision alone.
  RP-11 may record only `retain`, `remove`, or `defer`; `retain` authorizes only
  further bounded shadow evaluation. Activation requires a separate,
  independently governed post-RP-11 approval and a new/major requirements package.
- **AC-09:** removed/deferred packages retain rationale and do not count as
  completed implementation.
- **AC-10:** final program closure report reconciles roadmap, dashboard, child
  package status, runtime docs, and evidence.
