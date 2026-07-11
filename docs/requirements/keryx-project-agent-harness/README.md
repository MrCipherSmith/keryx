# Keryx Project Agent Harness Requirements Package
Version: 0.7.0

## Purpose

Define the implementation-ready requirements for turning Keryx into an
independent, project-oriented agent harness. Keryx must own the execution
loop, project context, tool runtime, permissions, sessions, subagents,
quality gates, evidence, and resumable orchestration without depending on
Claude Code, Codex, OpenCode, Pi, or another external coding-agent runtime.

The core product thesis is:

> The agent is ephemeral; the project brain is durable.

The `.metaproject/` workspace is the durable source of truth. Model providers,
terminal UI, IDE integrations, and MCP are replaceable interfaces around that
project brain.

## Status

`specification ready — implementation handoff`. The package is contract-complete
for a later implementation flow: managed review iteration 2 reports zero
BLOCKER/P0/P1 findings and all documentation/fixture gates pass. No runtime
implementation is claimed by this package; all runtime behavior is future work.

The implementation handoff is recorded in
[flow-orchestrator-handoff](../../../.metaproject/jobs/requirements-remediation--keryx-project-agent-harness/flow-orchestrator-handoff.md)
and remains subject to the runtime evidence gates listed there.

## Release Boundaries

Scope is split into three boundaries so that the first slice is small, offline,
and verifiable. A capability is in a later release until its release's success
criteria are met with source and tests.

### Release 0 — Offline read-only vertical slice (target of the first implementation flow)

Includes only: an offline fake provider; a read-only registered tool; a
provider-neutral event loop; a minimal append-only session; a context manifest;
evidence-linked output; CLI plus JSONL/RPC semantic parity; and deterministic
replay using recorded provider/tool fixtures.

Excludes (deferred to Release 1+): production provider adapter, filesystem
mutation, unrestricted shell, network tools, child agents, parallel tool calls,
executable extensions/plugins, provider-side session storage, and the TUI.

Measurable success criteria:

- deterministic Keryx floor is byte-identical with the harness disabled;
- a fake-provider transcript drives a complete read-only tool loop offline with
  no network socket opened;
- all Release 0 schemas accept valid and reject invalid fixtures under the chosen
  Draft 2020-12 validator;
- CLI and JSONL/RPC produce semantically equivalent normalized events and output;
- offline replay reproduces policy/orchestration state transitions and reports
  mismatches, executing no network, provider, or mutating tool;
- completion is rejected when required evidence is missing.

### Release 1 — Durable, guarded, coordinated

Adds: durable resume across process restart; branching and compaction; guarded
filesystem mutation and the approval engine; single-coordinator flow integration;
child agents over canonical contracts; bounded parallel scheduling; the first real
provider adapter behind an optional capability.

Measurable success criteria:

- resume never duplicates accepted events or evidence and creates new attempts on
  stale fingerprints;
- guarded mutation is path-checked, security-scanned, approval-bound, and
  evidence-recorded;
- managed-flow completion advances only through the Task Manager API;
- child dispatch/result validate the canonical `subagent-dispatch`/`subagent-result`.

### Release 2+ — Later scope

Adds: additional real provider adapters; network broker-mediated tools;
third-party executable extensions with capability grants; the interactive TUI;
external compatibility adapters. Each requires its own security and policy gates.

## Decisions and Open Questions

Release-shaping decisions adopted for this package (full evidence in the job
`decisions.md`; runtime contracts in [specification.md](specification.md)):

| ID | Decision |
|---|---|
| D1 | Release 0 is the offline read-only slice above; the listed exclusions are deferred. |
| D2 | A single coordinator (`flow-orchestrator`/Task Manager) owns managed-flow task state, retries, review/fix, and completion. The harness supplies execution primitives, sessions, tools, events, evidence, and typed gate results; it never edits `flow.json` and never runs a second plan/execute/verify/review loop. |
| D3 | At least three security profiles exist — `read-only-review`, `monitored-trusted-local`, `unattended-untrusted`. Release 0 permits only `read-only-review`. Unattended/untrusted mutation fails closed without a real OS/container/remote sandbox. A permission prompt is not a containment boundary. |
| D4 | The local Keryx event/session log is authoritative state. Provider-side storage and continuation are off by default and out of Release 0; enabling them later requires a dedicated capability, policy, retention, and deletion contract. System/project instructions are reconstructed locally each request. |
| D5 | Session storage is an append-only tree; a branch has `branchId`, `forkEntryId`, a current leaf, and immutable ancestors; branch merge is excluded from v1; compaction is a typed derived entry that never removes evidence or history. |
| D6 | The canonical durable child object is the versioned `subagent-result`. The platform-native textual `STATUS:` line is adapter framing, not a separate domain contract; the adapter converts framing into the canonical object before persistence and validation. `harness-agent-task` is deprecated as a parallel source of truth. |
| D7 | A separate Task Manager evolution requirement (dependencies, attempts, blocked/failed/skipped disposition states, acceptance-criteria references, evidence/artifact references, budgets, run/session linkage, backward-compatible migration) is a prerequisite before the implementation flow. See [implementation-plan.md](implementation-plan.md). |

Open questions still tracked (do not block the remediation, but must be answered
before the corresponding capability leaves draft):

- Exact first-release supported provider adapter and its credential-config shape (Release 1).
- Concrete numeric budgets per role/profile beyond the SLO ceilings below.
- Retention windows per artifact class under team vs solo policy.
- Whether `src/harness` relocation lands as a rename to `src/eval/` or a staged
  alias (see [specification.md](specification.md) module map).

## Startup and Resume Preconditions

Startup criteria are explicit preconditions, not implicit assumptions:

- **Disabled floor:** with `harness.enabled=false`, no provider is loaded, no
  network socket is opened by the harness, and deterministic command behavior is
  byte-identical. This is the only mode with zero preconditions.
- **Enabled run preconditions:** a resolvable project root with
  `.metaproject/metaproject.json`; a configured provider id and model id; a
  reachable credential **reference** (env var or user-config pointer, never an
  inline secret) for that provider; a named policy profile; and a resolvable
  role. A missing provider/model/credential/policy precondition is a typed
  `environment_blocked` result at startup, not a partial run.
- **Resume preconditions:** resume requires the **same worktree identity and
  toolchain** used to create the session. Resume recomputes project, scope,
  context, policy, role, provider/model, skill/rule, and schema fingerprints;
  any mismatch preserves prior attempts for audit and creates a new attempt
  rather than reusing a stale accepted decision. Resume never infers
  "already done" from a missing artifact.

## Service-Level Objectives (SLOs)

Quantitative ceilings the implementation must meet. Values are targets for the
Release 0 slice on a developer-class machine unless noted; each is exact,
estimated, or unknown per [metrics-and-validation.md](metrics-and-validation.md).
These are contract ceilings, not benchmarks — the implementation may be faster.

| SLO | Ceiling | Notes |
|---|---|---|
| Disabled startup overhead | ≤ 5 ms added to a deterministic command vs. pre-harness baseline | measured on a warm process; harness code must not import provider SDKs when disabled |
| Context manifest maximum size | ≤ 2 MiB bytes and ≤ 200,000 estimated tokens rendered | hard cap; exceeding it fails context build with `context_overflow`, never silent truncation |
| Session append latency | ≤ 10 ms p95 per event append (local disk) | append-only JSONL with atomic strategy |
| Resume latency | ≤ 750 ms p95 to reconstruct current leaf for a ≤ 5,000-event session | excludes re-running any tool/provider |
| RPC overhead | ≤ 15 ms p95 added per normalized event vs. in-process | JSONL/RPC parity must not change policy or gate behavior |
| Memory ceiling | ≤ 512 MiB RSS for a Release 0 fake-provider run | excludes external module processes |
| Budget compliance | 0 runs exceed the reserved hard token/time/tool-call budget | budget reservation is enforced, not advisory |

## Document Index

- [PRD](prd.md) — product problem, users, requirements, success criteria,
  risks, and recommendation.
- [Specification](specification.md) — architecture, runtime lifecycle,
  storage, manifest/config, CLI, contracts, integrations, and acceptance
  criteria.
- [Brainstorm and Decisions](brainstorm.md) — alternatives considered and
  decisions derived from open-source harness research.
- [Best Practices and Research](best-practices.md) — selected patterns from
  Pi, OpenCode, oh-my-claude, oh-my-claudecode, MCP, Anthropic, and OpenAI
  Agents SDK materials.
- [Agent Protocol](agent-protocol.md) — deterministic protocol for the
  project harness, flow-orchestrator, and child agents.
- [Provider Protocol](provider-protocol.md) — model/provider abstraction,
  streaming, tool calls, retries, and capability negotiation.
- [Security Protocol](security-protocol.md) — permission, approval, sandbox,
  prompt-injection, secret, and egress rules.
- [Artifact Lifecycle](artifact-lifecycle.md) — session, event, evidence,
  cache, resume, retention, and migration rules.
- [Metrics and Validation](metrics-and-validation.md) — quality, cost,
  reliability, performance, replay, and regression validation.
- [Implementation Plan](implementation-plan.md) — phased delivery and atomic
  implementation tasks for `flow-orchestrator`.
- [Implementation Prompt](implementation-prompt.md) — copy-paste prompt for
  starting the managed implementation flow.
- [Feature Summary](feature-summary.md) — concise runtime and integration
  overview for project and Metaproject users.
- [Acceptance Scenarios](acceptance.feature) — executable behavioral contract.
- [JSON Schemas](schemas/) — machine-readable runtime and orchestration
  contracts referenced by the specification (the deprecated agent-task schema
  remains linked for migration traceability):
  - [Shared envelope](schemas/harness-envelope.schema.json)
  - [Harness config](schemas/harness-config.schema.json)
  - [Run input](schemas/harness-run-input.schema.json)
  - [Run output](schemas/harness-run-output.schema.json)
  - [Event](schemas/harness-event.schema.json)
  - [Tool call](schemas/harness-tool-call.schema.json)
  - [Tool definition](schemas/tool-definition.schema.json)
  - [Tool registry snapshot](schemas/tool-registry-snapshot.schema.json)
  - [Tool execution state](schemas/tool-execution-state.schema.json)
  - [Tool result](schemas/tool-result.schema.json)
  - [Execution receipt](schemas/execution-receipt.schema.json)
  - [Policy profile](schemas/policy-profile.schema.json)
  - [Policy decision](schemas/harness-policy-decision.schema.json)
  - [Approval request](schemas/approval-request.schema.json)
  - [Approval result](schemas/approval-result.schema.json)
  - [Context manifest](schemas/harness-context-manifest.schema.json)
  - [Session manifest](schemas/session-manifest.schema.json)
  - [Session entry](schemas/session-entry.schema.json)
  - [Checkpoint](schemas/checkpoint.schema.json)
  - [Branch metadata](schemas/branch-metadata.schema.json)
  - [Compaction entry](schemas/compaction-entry.schema.json)
  - [Evidence record](schemas/evidence-record.schema.json)
  - [Evidence ledger](schemas/evidence-ledger.schema.json)
  - [Provider descriptor](schemas/provider-descriptor.schema.json)
  - [Model request](schemas/model-request.schema.json)
  - [Model response](schemas/model-response.schema.json)
  - [Model error](schemas/model-error.schema.json)
  - [Completion gate result](schemas/completion-gate-result.schema.json)
  - [RPC/JSONL envelope](schemas/rpc-jsonl-envelope.schema.json)
  - [Fake-provider transcript](schemas/fake-provider-transcript.schema.json)
  - [Replay fixture](schemas/replay-fixture.schema.json)
  - [Replay mismatch](schemas/replay-mismatch.schema.json)
  - [Child-contract extension](schemas/harness-child-contract-extension.schema.json)
  - [Deprecated agent task](schemas/harness-agent-task.schema.json)
  - [Schema version registry](schemas/schema-version-registry.json)
  - [Schema fixtures](schemas/fixtures/README.md)
  - [Fixture index](schemas/fixtures/fixture-index.json)
  - [Fixture matrix](schemas/fixtures/fixture-matrix.json)
  - [Positive contract catalog](schemas/fixtures/positive-contract-catalog.json)
  - [Negative contract catalog](schemas/fixtures/negative-contract-catalog.json)
  - [Implementation handoff](../../../.metaproject/jobs/requirements-remediation--keryx-project-agent-harness/flow-orchestrator-handoff.md)

## Scope

- A first-party Keryx agent runtime with a provider-neutral model interface.
- Project-aware context assembly from graph, wiki, memory, rules, skills,
  testing, health, security, and flows.
- A schema-driven tool registry and execution loop.
- Explicit `allow`, `ask`, and `deny` permissions with path, command, tool,
  network, and resource controls.
- Durable append-only sessions, event streams, compaction, branching, resume,
  and evidence ledgers under `.metaproject/`.
- Managed-flow plan/execute/verify/review/fix integration and bounded child agents.
- Quality gates that prevent an agent from claiming completion without evidence.
- CLI-first operation, JSONL/RPC integration, and optional TUI.
- Reuse of existing Keryx services and contracts rather than duplicating them.

## Non-Goals

- Reimplementing or embedding Claude Code, Codex, OpenCode, or Pi.
- Making a model, provider, or hosted service mandatory.
- Building a general-purpose personal assistant outside project workspaces.
- Replacing existing `gdgraph`, `gdwiki`, `memory`, `testing`, `health`,
  `security`, `flow`, or `review` modules with parallel implementations.
- Enabling autonomous destructive actions by default.
- Persisting raw secrets, hidden chain-of-thought, or unrestricted environment
  snapshots.

## Related Modules

- `src/capability/` — opt-in capabilities and deterministic fallback policy.
- `src/flow/` — durable task lifecycle and completion state machine.
- `src/gdskills/` — skills, worker contracts, routing, and learning.
- `src/gdgraph/` — structural project context.
- `src/ctx/` — bounded command, search, and read context.
- `src/wiki/` — project architecture and domain knowledge.
- `src/memory/` — durable lessons, decisions, constraints, and history.
- `src/testing/` and `src/health/` — verification evidence and quality gates.
- `src/security/` — redaction, injection, secret, PII, egress, and policy
  enforcement.
- `src/mcp/` — external protocol adapter; it remains an adapter, not the
  execution core.
- `src/harness/` — currently a fixture-corpus evaluation harness. The
  implementation must relocate that concern to `src/eval/` (recommended) before
  reserving `src/harness/` for the agent runtime. This relocation is an explicit
  prerequisite task in [implementation-plan.md](implementation-plan.md), not an
  incidental refactor.

## Source and Assumptions

This package is grounded in the current Keryx source and documentation as of
2026-07-10. External research links are listed in `best-practices.md`.
Research findings are design input, not claims that Keryx already implements
the referenced behavior.
