# Keryx Project Agent Harness Metrics and Validation
Version: 0.2.0

## Purpose

Define measurable targets for correctness, safety, project orientation,
resumability, performance, and model cost. Metrics must distinguish exact,
estimated, and unknown values.

## Runtime Metrics

| Metric | Target |
|---|---|
| Tool schema validity | 100% accepted calls validate before execution |
| Policy coverage | 100% tool calls have a persisted decision |
| Approval integrity | 0 executions for rejected or unresolved approvals |
| Evidence linkage | 100% mutating calls link to evidence |
| Session durability | 0 accepted events lost across process restart tests |
| Resume safety | 100% stale fingerprints create a new attempt |
| Completion integrity | 0 completion outputs without gate result |
| Child result validity | 100% accepted child results validate schemas |
| Budget compliance | 0 runs exceed reserved hard budget |
| Retry boundedness | 0 unbounded retry loops |
| Project context | 100% runs contain project and context fingerprints |
| Redaction | 0 seeded secrets survive in protected artifacts |

## Release 0 Quantitative SLOs

| SLO | Ceiling | Verification |
|---|---:|---|
| Disabled startup overhead | ≤ 5 ms warm-process delta | paired disabled baseline |
| Context manifest | ≤ 2 MiB and ≤ 200,000 estimated tokens | hard fail on overflow |
| Session append p95 | ≤ 10 ms/event | local-disk fixture benchmark |
| Resume p95 | ≤ 750 ms for 5,000 events | deterministic session fixture |
| JSONL/RPC overhead p95 | ≤ 15 ms/event over in-process | parity fixture |
| Release 0 memory | ≤ 512 MiB RSS | fake-provider vertical slice |
| Budget compliance | 0 hard-budget exceedances | reserved/consumed ledger |

## Project-Oriented Quality Metrics

- startup context completeness: required project artifacts present or explicit
  skip reason;
- context freshness: percentage of references whose source artifact is current;
- context compression: rendered prompt bytes versus raw candidate bytes;
- repeated discovery avoided: reused context/artifacts on resume;
- decision continuity: accepted project decisions referenced in later runs;
- evidence completeness: changed files mapped to tests/review/gate evidence;
- task continuity: resumed runs continue from the current flow/session state.

## Model and Cost Metrics

- provider/model id;
- prompt and completion token counts when reported;
- estimated token counts only when explicitly labelled;
- model request count and tool call count;
- child-agent count and parallel peak;
- planned, reserved, consumed, and remaining budgets;
- retry count by taxonomy;
- wall time, active time, approval wait time, and environment wait time.

## Required Test Layers

### Unit

- event validation and sequencing;
- state transitions;
- provider event normalization;
- tool schema validation;
- policy precedence and hard denies;
- approval state machine;
- path and command normalization;
- context fingerprints;
- retry/backoff classification;
- budget reservation;
- completion gate evaluation;
- compaction metadata.

### Integration

- fake provider drives a complete tool loop;
- temporary project workspace builds context;
- session interruption and resume;
- approval pause and continuation;
- tool timeout/cancellation;
- child dispatch and result persistence;
- flow task lifecycle through service/CLI;
- testing/health/security evidence attachment;
- JSONL/RPC transport parity with in-process execution.

### Security and Red Team

- prompt injection corpus;
- secrets/PII corpus;
- path traversal/symlink corpus;
- shell injection corpus;
- policy bypass attempts;
- unauthorized network/external-directory access;
- oversized model/tool payloads;
- malicious skill/package loading.

### Replay and Regression

- replay recorded event fixture offline;
- deterministic policy decisions from the same input;
- same fake-provider transcript produces same state/evidence graph;
- provider adapter changes do not change normalized tool semantics;
- harness disabled preserves deterministic Keryx behavior.

## Fixture and Failure-Injection Contract

Every public or durable schema has positive, negative, mutation, and migration
fixtures. Fixtures use deterministic clock, id, and random sources. Semantic
validation supplements JSON Schema for sequence/causality, hash, transition,
budget, and cross-record invariants. Failure matrices cover crash before/after
append, approval consumption, side effect, receipt/result append, current-leaf
update, compaction switch, and finalization, plus torn writes, disk-full,
lock/contention, backpressure, oversized output, and cancellation races.

The validator must support every JSON Schema Draft 2020-12 keyword used by the
package or reject the schema at build time. This job specifies the capability;
it does not install a validator dependency.

## Baseline Handling

The current project health artifact reports `FAIL` because TypeScript is
unavailable and the health baseline has a regression. The implementation must
record this as a baseline/environment condition rather than silently treating
it as a harness regression. A release gate must compare baseline and changed
scope explicitly.

## Release Gate

Implementation is acceptable only when:

1. all Gherkin scenarios pass;
2. all schemas have valid and invalid fixtures;
3. focused and full test commands pass in a reproducible environment;
4. no new P0/P1 or security blocker is introduced;
5. policy and redaction tests pass;
6. replay/resume tests pass;
7. documentation review has no blockers;
8. roadmap status is upgraded only after source evidence exists.
9. parser validation passes and requirements → scenarios → schemas → tasks
   coverage has no unexplained gap.
