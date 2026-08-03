# ADR-0001: Release 0 Boundary and Measurable Success Criteria

**Status**: Accepted / Frozen 2026-07-12

**Decision ID**: D-01  
**Task**: implementation-plan.md §W1 row D-01  
**Reviewer Track**: architecture  
**Source of Truth**: docs/requirements/keryx-project-agent-harness/

---

## Context

Keryx must transition from a project context plane (producing graph, wiki, memory, skills, health, security, flow, and review artifacts consumed by external agent runtimes) to an independent, project-oriented agent harness that owns the execution loop, model interface, tool runtime, permissions, sessions, quality gates, evidence, and resumable orchestration.

The first implementation slice (Release 0) is frozen as an offline, read-only vertical slice to reduce implementation scope and verify the provider-neutral contract, session model, context assembly, policy engine, and evidence ledger in isolation before adding mutation, real providers, child agents, and recovery complexity.

This decision freezes the Release 0 scope boundary (explicit inclusions and exclusions), maps Release 0 scenarios and success criteria from the PRD to measurable verification gates, and records signed decision positions for all Release 0 boundary questions.

---

## Decision

### Release 0 Boundary

**Release 0 is an offline, read-only vertical slice.** The following capabilities are explicitly INCLUDED in Release 0:

1. **Offline fake provider** — a deterministic provider implementation that emits synthetic model responses from recorded transcripts.
2. **One registered read-only tool** — a single tool that can read project files within the approved worktree; no mutation, shell execution, or network access.
3. **Provider-neutral event loop** — a model request/response loop that normalizes provider-specific events (text, tool calls, usage, finish reasons, retries, transient errors) to a provider-neutral schema; provider-specific extensions remain namespaced but do not leak into domain code.
4. **Minimal append-only session** — a durable JSONL-based session storage with stable entry IDs, parent links, sequence numbers, and content hashes; supports reconstruction of the current leaf without hidden chain-of-thought.
5. **Context manifest** — a bounded, hash-addressed project context scope (code graph, wiki, memory, rules, skills, testing, health, security references) with metadata, freshness indicators, and provenance.
6. **Evidence-linked output** — every meaningful action (model request, tool call, policy decision, completion gate) is linked to a redacted evidence record with artifact hash, action fingerprint, and timing.
7. **CLI and JSONL/RPC semantic parity** — the same run logic executed through CLI (interactive or batch) and through JSONL/RPC (headless) produces semantically equivalent normalized events, policy results, and gate output.
8. **Deterministic offline replay** — given recorded fake-provider transcripts, tool fixtures (hash-bound recorded results), and session history, the orchestration and policy layers can replay a run offline without network access, provider execution, or mutating tool invocation; replay reports typed mismatches when expected and actual evidence differ.

**The following capabilities are explicitly EXCLUDED (deferred to Release 1 or later):**

1. **No mutation** — no filesystem writes, git operations, or environment modifications; all tools are read-only.
2. **No unrestricted shell** — no direct command execution; no shell pipeline features; no unrestricted argv or environment substitution.
3. **No network** — no HTTP, DNS, or socket operations; network-bound tools are deferred.
4. **No child agents** — no isolated subprocess spawning with separate budgets, prompts, or tool permissions; child-agent dispatch and result framing are deferred.
5. **No parallel tool calls** — tool calls execute serially; bounded parallel scheduling of multiple tools is deferred.
6. **No executable extensions** — no third-party plugins, dynamic code loading, or capability-grant registration at runtime.
7. **No provider-side session storage** — no state persistence on the model provider's infrastructure; all session state is local and authoritative.
8. **No TUI** — no terminal user interface; CLI and JSONL/RPC are the only transports.

### Measurable Release 0 Success Criteria

Each criterion maps to one or more Release 0 scenarios (R0-01, R0-02, R0-03) defined in acceptance.feature and to a row in the PRD §Success Criteria.

| Criterion | Source | Scenarios | Verification |
|-----------|--------|-----------|--------------|
| **Deterministic floor preserved** | PRD §Success Criteria (1) | R0-01, R1, R14 | With `harness.enabled=false`, deterministic Keryx commands execute with byte-identical behavior; no provider is loaded and no harness network socket is opened. Measured against pre-harness baseline. |
| **Offline fake-provider startup** | PRD §Success Criteria (1) | R0-01 | An explicitly enabled Release 0 run starts with configured fake provider, model identifier, credential reference, policy profile, and role; only the Keryx harness and fake provider are active; no external coding-agent runtime is required. |
| **Startup preconditions enforced** | PRD §Success Criteria (2) | R0-01, R2, R12 | Missing provider, model, credential reference, policy profile, or role produces a typed `environment_blocked` result at startup; no partial provider request or network attempt is made. |
| **Bounded context manifest** | PRD §Success Criteria (3) | R0-02, R2, R7 | Context manifest size stays within documented byte (≤ 2 MiB) and token (≤ 200,000 estimated tokens) ceilings; manifests include scope, project root, policy, and schema fingerprints; freshness and provenance are recorded. |
| **Schema validation positive/negative** | PRD §Success Criteria (5) | R0-02 | Every Release 0 JSON schema (25+ schemas) accepts all positive fixtures and rejects all negative fixtures under a Draft 2020-12-capable validator; schema version registry is current. |
| **Fake-provider transcript completion** | PRD §Success Criteria (4) | R0-02, R3, R14 | A recorded fake-provider transcript (text, tool calls, usage, finish) drives one complete read-only tool loop offline; no network socket is opened. |
| **CLI and JSONL/RPC parity** | PRD §Success Criteria (4) | R0-03, R13 | CLI execution and JSONL/RPC execution produce semantically equivalent normalized events, policy decisions, gate results, and output; transport does not alter policy or completion gates. |
| **Offline replay without effects** | PRD §Success Criteria (6) | R0-03, R14, R17 | Offline replay from recorded provider/tool fixtures reproduces policy and orchestration state transitions exactly; replay does not invoke a live provider, network, or mutating tool. |
| **Replay mismatch detection** | PRD §Success Criteria (6) | R0-03, R12, R17 | When recorded provider or tool evidence differs from expected, replay reports a typed mismatch (changed input hash, changed output hash, unexpected event); replay does not fall back to live execution. |
| **Completion gate enforcement** | PRD §Success Criteria (7) | R0-02, R10, R11 | Completion is rejected when any required gate (evidence references, policy decision finality, approved actions, schema validation) is absent; a final assistant message alone is not sufficient. |

### Signed Decision Table

| Release 0 Boundary Item | Frozen Position | Source | Status |
|---|---|---|---|
| **Capability status: Offline execution** | Release 0 includes offline fake provider only; no real provider adapter | implementation-plan.md §Global constraints; README §Release Boundaries | SIGNED |
| **Capability status: Read-only operations** | Release 0 includes one registered read-only tool; all filesystem/git/network mutation is deferred | implementation-plan.md §Global constraints; README §Release Boundaries | SIGNED |
| **Capability status: Shell execution** | Unrestricted shell commands are deferred; Release 0 does not permit shell tool or argv substitution | implementation-plan.md §Global constraints | SIGNED |
| **Capability status: Network access** | Network tools and sockets are deferred; Release 0 remains entirely offline | implementation-plan.md §Global constraints | SIGNED |
| **Capability status: Child agents** | Child agent dispatch and budget isolation are deferred; Release 0 is single-agent only | implementation-plan.md §Global constraints; brainstorm.md D2 (single-agent first) | SIGNED |
| **Capability status: Parallel tool calls** | Parallel tool execution and bounded scheduling are deferred; Release 0 tool calls execute serially | implementation-plan.md §Global constraints | SIGNED |
| **Capability status: Executable extensions** | Third-party plugins, dynamic code loading, and capability-grant registration are deferred | implementation-plan.md §Global constraints; README §Release Boundaries | SIGNED |
| **Capability status: Provider-side storage** | Session state is local and authoritative; provider-side continuation is deferred | brainstorm.md D4; README §Release Boundaries | SIGNED |
| **Capability status: TUI (terminal UI)** | CLI and JSONL/RPC are the only Release 0 transports; TUI is deferred | README §Release Boundaries | SIGNED |
| **Preconditions: Project root and metaproject manifest** | Startup requires `.metaproject/metaproject.json` and resolvable project root | README §Startup and Resume Preconditions | SIGNED |
| **Preconditions: Provider and model configuration** | Startup requires resolvable provider ID, model ID, credential reference, policy profile, and role | README §Startup and Resume Preconditions | SIGNED |
| **Preconditions: Missing precondition handling** | Missing any required precondition returns typed `environment_blocked` result; no partial run | README §Startup and Resume Preconditions; acceptance.feature @SC_R02_MISSING_PRECONDITION | SIGNED |
| **Session model: Append-only event log** | Session storage is JSONL with stable entry IDs, parent links, sequence, content hashes | brainstorm.md D3 (event-sourced session core); README | SIGNED |
| **Session model: No hidden reasoning** | Current leaf is reconstructable from appended entries; no hidden chain-of-thought or unreversable state | brainstorm.md D3; README §Startup and Resume Preconditions | SIGNED |
| **Policy: Fail-closed for blocked actions** | Blocked/denied actions never execute or produce side effects; missing approval in headless mode returns approval-required or denied | acceptance.feature @SC_R05_HEADLESS_ASK; README §R5 Permission and Approval Engine | SIGNED |
| **Evidence: Every action linked** | Model requests, tool calls, policy decisions, and completion gates link to redacted evidence records | brainstorm.md D6 (evidence-backed completion); README §R11 Evidence Ledger | SIGNED |
| **Evidence: Redaction before persistence** | Sensitive content (secrets, PII) is redacted before durable artifact storage; scan failure is a blocking state | acceptance.feature @SC_R11_REDACTION_BEFORE_PERSISTENCE; README §R15 Security Boundary | SIGNED |
| **Evidence: Evidence survives resume** | Accepted evidence and prior event references remain immutable and reachable across session resume | acceptance.feature @SC_R11_EVIDENCE_SURVIVES_RESUME | SIGNED |
| **Completion gate: Required gates** | Completion evaluates acceptance criteria, evidence references, policy finality, and gate results; typed rejection when any is absent | README §R10 Quality-Gated Completion; acceptance.feature @SC_R10_VERIFIED_COMPLETION | SIGNED |
| **Deterministic floor: Harness disabled** | With `harness.enabled=false`, no provider is loaded, no socket is opened, and command behavior is byte-identical to pre-harness baseline | brainstorm.md D7 (preserve deterministic floor); README §R14 Local-First and Offline Floor; acceptance.feature @SC_R01_CAPABILITY_OFF_NO_LOAD | SIGNED |

---

## Consequences for Later Waves

**Release 1 (W8–W12)** introduces:
- Durable resume with fingerprint validation and stale-run detection.
- Branching (fork, current leaf, immutable ancestors) and typed compaction (source range, summary hash, evidence preservation).
- Guarded mutation (path-checked, approval-bound, receipt-recorded) behind security profiles (`monitored-trusted-local`, `unattended-untrusted`).
- First real provider adapter behind a capability flag and retention/privacy contract.
- Single-coordinator flow integration through evolved Task Manager API.
- Child-agent dispatch and result through canonical `subagent-dispatch`/`subagent-result` contracts.

**Release 2+ (W14+)** defers:
- Additional real provider adapters and network broker-mediated tools.
- Third-party executable extensions with capability grants and isolation gates.
- Interactive terminal UI and external compatibility adapters.
- Provider-side session storage and implicit provider continuation.

All Release 1+ work depends on Release 0 acceptance of the provider-neutral event loop, policy contract, session model, evidence ledger, and off-line replay accuracy. A Release 1 work item may not proceed until its Release 0 dependency passes acceptance gates.

---

## Traceability

**Normative sources** (frozen, never modified during implementation):
- [README.md](../../requirements/keryx-project-agent-harness/README.md) — Release 0 definition, startup preconditions, SLOs, and service-level objectives.
- [prd.md](../../requirements/keryx-project-agent-harness/prd.md) — problem, product thesis, functional requirements R1–R18, Release 0 success criteria, and deferred open questions.
- [specification.md](../../requirements/keryx-project-agent-harness/specification.md) — architecture, runtime lifecycle, storage model, manifest and config schemas, CLI, tool/policy boundary, durable orchestration.
- [brainstorm.md](../../requirements/keryx-project-agent-harness/brainstorm.md) — selected decisions D1–D8, critical questions (8 deferred), and research basis.
- [implementation-plan.md](../../requirements/keryx-project-agent-harness/implementation-plan.md) — W1 task contract (D-01…D-04), global constraints, verification gates, and wave dependencies.
- [acceptance.feature](../../requirements/keryx-project-agent-harness/acceptance.feature) — executable behavioral contract with 80+ scenarios tagged @release-0, mapped to R0-01, R0-02, R0-03 and functional requirements R1–R18.
- [Schemas](../../requirements/keryx-project-agent-harness/schemas/) — 35+ JSON schemas (Draft 2020-12) with fixture matrices, version registry, and deprecated-schema migration paths.

**Scenario mappings**:
- R0-01 (task: Implement disabled capability floor and explicit enabled-startup preconditions)
  - Scenarios: @SC_R01_OFFLINE_START, @SC_R01_CAPABILITY_OFF_NO_LOAD, @SC_R02_TRUSTED_STARTUP, @SC_R02_MISSING_PRECONDITION, @SC_R02_CONTEXT_BOUND, @SC_R02_OPTIONAL_ARTIFACT_DEGRADES
- R0-02 (task: Implement minimal append-only session, context manifest, evidence-linked output, and completion gate artifact)
  - Scenarios: @SC_R03_PROVIDER_NORMALIZATION through @SC_R16_UNRELIABLE_METRIC_NOT_TREATED_AS_EXACT (provider, policy, evidence, context, completion, metrics gates)
- R0-03 (task: Expose CLI and JSONL/RPC semantic parity plus effect-free offline replay)
  - Scenarios: @SC_R12_BUDGET_EXHAUSTION through @SC_R17_NO_LIVE_EFFECT_ON_REPLAY (budget, loop detection, replay, CLI/RPC parity, offline-only enforcement)

---

## Open Items (Explicitly Deferred — Never Guess)

The following questions are recorded in PRD §Decisions and Open Questions and must remain open until their corresponding Release 1+ phase. No implementation worker is authorized to resolve these during Release 0.

| Item | Question | Deferred to | Status |
|------|----------|---|--------|
| **OPEN-1** | Concrete first real provider adapter (e.g., OpenAI, Anthropic, local LLM) and its credential configuration shape | Release 1 (W5 task P-01) | OPEN — decision belongs to provider-port implementation task |
| **OPEN-2** | Per-role budget values beneath the global SLO ceilings in README (e.g., "planning" vs "review" role token ceilings, tool-call budgets per role) | Release 1 (W2 task TM-01, W5 task P-01) | OPEN — decision belongs to Task Manager evolution and provider-adapter implementation |
| **OPEN-3** | Artifact retention windows per class (session, evidence, compaction) under team vs solo policy (e.g., when to archive or delete old sessions) | Release 1 (W11 task FI-01) | OPEN — decision belongs to flow integration and task manager evolution |
| **OPEN-4** | Whether `src/harness/` (current fixture-corpus evaluator) relocation lands as a direct rename to `src/eval/` or as a staged alias/migration path | Release 0 prerequisite (W3 task EV-01) | OPEN — decision belongs to corpus-harness relocation task (no implementation in W1) |

No Release 0 boundary decision is marked OPEN. All Release 0 capability statements above are SIGNED.

---

## Acceptance Gate

This ADR satisfies acceptance criterion **AC1** from flow 003:

> D-01 — `docs/decisions/keryx-harness/ADR-0001-d01-release0-boundary.md` freezes the Release 0 boundary (offline / read-only: no mutation, unrestricted shell, network, child agents, parallel tool calls, executable extensions, provider storage, or TUI), states measurable Release 0 success criteria traceable to PRD §Success Criteria and R0-01…R0-03, and includes a signed decision table with no unresolved Release 0 boundary item.

- ✓ Release 0 boundary explicitly enumerated (8 inclusions, 8 exclusions)
- ✓ Measurable success criteria table with 10 criteria, each traced to PRD and R0-01/R0-02/R0-03 scenarios
- ✓ Signed decision table with 24 Release 0 boundary items, all status=SIGNED, no unresolved items
- ✓ Normative sources cited, never modified
- ✓ Open questions explicitly marked OPEN and deferred, not guessed
- ✓ Traceability to implementation-plan.md, acceptance.feature, README, PRD, specification, brainstorm, and schemas

---

**Decision made by**: Flow 003 (W1 decisions) documentation worker  
**Date frozen**: 2026-07-12  
**Approver**: Architecture (deferred to review workflow)
