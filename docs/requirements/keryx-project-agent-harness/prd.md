# Keryx Project Agent Harness PRD
Version: 0.2.0

## Problem

Current coding agents are generally session-oriented. They can read and modify
a repository, but project knowledge, decisions, quality evidence, task state,
and learned constraints are often scattered across prompts, global settings,
agent-specific hooks, terminal history, and provider-specific session files.
This causes repeated discovery, inconsistent behavior between runtimes, poor
resume behavior, and weak proof that a task is complete.

Keryx already materializes a durable `.metaproject/` workspace containing code
graph, compact context, wiki, memory, skills, testing, health, security, flow,
and review artifacts. It currently acts as a project operating layer consumed
by external agents. It does not yet own the model execution loop or the
permissioned tool runtime.

The product opportunity is to make Keryx project-oriented by construction:
the project owns the context, policy, state, artifacts, and completion gates;
the model is a replaceable reasoning backend.

## Product Thesis

Keryx should not be another Claude Code clone. It should be a project-native
harness in which:

1. every run starts from the project's durable brain;
2. every action is represented as a typed, policy-checked event;
3. every task can resume from durable state;
4. every completion claim is backed by test, health, review, and acceptance
   evidence;
5. every model/provider can be replaced without losing project memory or
   workflow state.

## Goal

Build an independent Keryx harness that can execute project tasks from the
terminal without Claude Code, Codex, OpenCode, Pi, or another external agent
runtime, while preserving Keryx's local-first, git-diffable, deterministic
core.

## Users

- **Solo developers** who want an agent that remembers a repository across
  sessions.
- **Teams** who want project rules, skills, decisions, and quality policies
  shared through version-controlled artifacts.
- **Maintainers** who need auditable task execution and evidence.
- **Flow orchestrators** that need to dispatch isolated, resumable child agents.
- **Model experimenters** who want to switch providers without changing the
  project workflow.
- **CI and automation operators** who need headless JSONL/RPC execution with
  explicit policy and bounded budgets.

## Functional Requirements

### R1: Independent Runtime

Keryx must run an agent session without requiring a Claude/Codex/OpenCode/Pi
installation. External runtimes may remain optional adapters, but no core
execution path may depend on them.

### R2: Project-First Startup

Before the first model request, the harness must resolve project root,
Metaproject manifest, enabled modules, applicable rules, project skills,
orientation context, active flows, relevant memory, and a bounded code scope.
Missing optional artifacts must degrade explicitly rather than block startup.

### R3: Provider-Neutral Model Contract

The runtime must expose one internal model contract for streaming text,
structured tool calls, usage, finish reasons, transient errors, and provider
capabilities. Provider-specific response shapes must not leak into domain or
tool code.

### R4: Typed Tool Runtime

All model-invoked actions must be registered tools with stable names, versioned
input schemas, bounded output, cancellation, timeout, provenance, and policy
metadata. Built-in project tools must be backed by existing Keryx service
facades where possible.

### R5: Permission and Approval Engine

Every mutating, shell, network, external-directory, credential, subagent, or
high-cost action must resolve through `allow`, `ask`, or `deny`. Policy must
support defaults, path/command patterns, tool-level rules, agent-role rules,
session overrides, and non-interactive behavior.

### R6: Durable Sessions

Sessions must be append-only, JSONL-compatible, resumable, branchable, and
safe to inspect after interruption. A session must preserve user input,
assistant output, tool calls/results, approvals, policy decisions, compaction
entries, retries, errors, and evidence references without storing hidden
chain-of-thought.

### R7: Context Engineering

The harness must assemble bounded context from project artifacts rather than
copying the entire repository. Context must be addressable by path, hash,
scope, freshness, and source reliability.

### R8: Agent Roles and Child Agents

The runtime must support primary roles such as `plan`, `build`, `review`, and
`verify`, plus child agents with isolated prompts, tool permissions, budgets,
and task contracts. Child agents must report through the existing
`subagent-result` protocol.

### R9: Project Workflow Integration

The harness must be able to create, resume, and advance a Keryx flow. It must
respect frozen acceptance criteria, use Task Manager transitions, and never
edit `flow.json` directly.

### R10: Quality-Gated Completion

The runtime must not mark work complete only because the model emitted a final
message. Completion must evaluate acceptance criteria, tests, health, security,
review coverage, unresolved findings, artifact validity, and policy-specific
requirements.

### R11: Evidence Ledger

Every meaningful action must be linked to evidence: commands, files read,
files changed, test reports, health reports, review findings, decisions,
approvals, and model/provider usage. Evidence must be redacted before durable
publication.

### R12: Recovery and Bounded Loops

Transient provider failures, malformed tool calls, tool failures, context
overflow, blocked permissions, and incomplete work must have typed recovery
paths. Retry counts, budgets, and loop detection must prevent infinite runs.

### R13: Multi-Transport Operation

The same runtime core must support interactive CLI, headless JSONL/RPC, and a
future TUI without duplicating execution logic. MCP remains an optional
external protocol surface over Keryx services and, later, the harness control
surface.

### R14: Local-First and Offline Floor

Existing deterministic Keryx commands must remain usable without a model,
network, or optional runtime dependency. The harness is explicitly opt-in and
must not alter the byte-identical deterministic floor.

### R15: Security Boundary

Untrusted repository text, issue text, external documents, model output, and
third-party skills must be treated as data, not policy. The harness must
separate trusted policy from untrusted context and route writes, shell,
network, and credentials through security seams.

### R16: Model and Cost Visibility

The runtime must record requested and actual provider/model identifiers,
planned and actual tokens when available, retries, latency, budget reservation,
and unknown values honestly.

### R17: Deterministic Replays

Given a recorded session, tool fixtures, provider event fixture, and policy
configuration, the orchestration and policy layers must be replayable without
network access. Provider generations themselves are not required to be
deterministic.

### R18: Explicit Extension Surface

New tools, providers, roles, policies, and transports must register through
stable contracts. Runtime extensions must not silently gain unrestricted
access or mutate project source-of-truth files during discovery.

## Release Boundaries

### Release 0 — Offline, read-only vertical slice

Release 0 contains only an offline fake provider, one registered read-only
tool, a provider-neutral event loop, a minimal append-only session, a context
manifest, evidence-linked output, CLI and JSONL/RPC semantic parity, and
deterministic replay from recorded provider/tool fixtures.

It excludes production providers, filesystem mutation, unrestricted shell,
network tools, child agents, parallel tool calls, executable extensions,
provider-side session storage, and a TUI.

### Release 1 — Durable, guarded, coordinated operation

Release 1 may add guarded mutation, durable resume, branching and compaction,
the approval engine, a first real provider adapter, and Task Manager-mediated
flow integration. Child agents and bounded parallel scheduling remain gated by
the Task Manager evolution prerequisite and canonical gdskills contracts.

### Release 2+ — Deferred capability families

Additional providers, network broker-mediated tools, executable extensions,
and the TUI are deferred until their independent security, policy, and
verification contracts are accepted.

## Decisions and Open Questions

The package adopts the remediation baseline D1–D7: Release 0 is offline and
read-only; Task Manager is the sole managed-flow coordinator; the local event
log is authoritative; security profiles and fail-closed containment are
mandatory for higher-risk operation; the session model is append-only; canonical
gdskills dispatch/result contracts remain the source of truth; and Task Manager
evolution is a prerequisite. The decision record is maintained in the
remediation job and reflected normatively in the specification.

The following questions are deliberately deferred and do not authorize an
implementation worker to guess: the concrete first real provider and credential
shape, per-role budget values beneath the global ceilings, artifact retention
windows, and the exact compatibility migration for moving the existing corpus
harness to `src/eval/`.

## Success Criteria

### Release 0

- With the harness disabled, deterministic command behavior is byte-identical
  and no provider is loaded or network socket opened by the harness.
- An explicitly enabled run with a configured fake provider, model identifier,
  credential reference, policy profile, and role produces a typed
  `environment_blocked` result when any required precondition is missing.
- A bounded, hash-addressed context manifest stays within the documented byte
  and token ceilings.
- A fake-provider transcript completes a read-only tool loop offline; CLI and
  JSONL/RPC produce equivalent normalized events and output.
- Every Release 0 schema accepts positive fixtures and rejects negative
  fixtures under a Draft 2020-12-capable validator.
- Offline replay never invokes a provider, network, or mutating tool and emits
  a typed mismatch result when recorded evidence differs.
- Completion is rejected when a required gate or evidence reference is absent.

### Release 1 and later

- Resume uses the same worktree and toolchain, preserves prior attempts, and
  never duplicates accepted evidence or side effects.
- A guarded mutation is path-checked, scan-state-aware, approval-bound, and
  evidence-recorded; unattended/untrusted mutation fails closed without the
  required isolation boundary.
- Managed-flow completion advances only through the Task Manager API and its
  single coordinator.
- Canonical `subagent-dispatch` and `subagent-result` contracts round-trip
  across their adapter framing before child-agent capability is enabled.

## Non-Goals

- A hosted agent service or multi-user control plane in the first release.
- A fully autonomous “YOLO” mode that bypasses approvals by default.
- Automatic application of learned skills or review findings.
- Replacing Git, GitHub, CI, or project test runners.
- Treating model confidence or a natural-language “done” as proof.

## Risks

### Scope Risk

An agent runtime, workflow engine, and project knowledge system together form a
large surface. The implementation must ship in vertical slices, beginning with
a single-agent loop and deterministic tool/policy/session contracts.

### Security Risk

The runtime will execute shell commands and edit repositories. A policy bug is
a privilege-boundary bug, not a normal feature defect. Security review and
fixture-based red-team tests are mandatory for every write seam.

### Context Risk

Project-oriented context can become too large or stale. Context must be sliced,
hash-addressed, freshness-aware, and generated through existing graph/ctx/wiki
facilities.

### Provider Drift

Model APIs differ in streaming, tool calls, usage, retries, and reasoning
metadata. The provider contract must normalize only stable semantics and keep
provider-specific extensions behind capability flags.

### Orchestration Duplication

Keryx already has `flow-orchestrator`, `review-orchestrator`, and worker
contracts. The harness must compose them instead of creating a second hidden
orchestrator implementation.

### Existing Quality Baseline

The current health artifact reports a failing strict gate due to unavailable
TypeScript and a regression baseline. This package must not claim a clean
baseline; implementation work must first establish a reproducible verification
environment or explicitly classify baseline failures.

## Recommendation

Implement a Keryx-owned runtime with five strict layers:

1. **Core execution** — model event loop, cancellation, retries, and budgets.
2. **Project context** — context providers over existing Keryx services.
3. **Tool/policy boundary** — typed tools, approval, sandbox, and redaction.
4. **Durable orchestration** — sessions, flows, child tasks, evidence, and
   completion gates.
5. **Transports** — CLI first, JSONL/RPC second, TUI later.

Borrow design ideas, not runtime ownership: Pi is the closest inspiration for
the small core and session/RPC discipline; OpenCode is the strongest reference
for tools and permissions; oh-my-claude is the strongest reference for hard
quality gates; oh-my-claudecode is the strongest reference for staged parallel
orchestration.
