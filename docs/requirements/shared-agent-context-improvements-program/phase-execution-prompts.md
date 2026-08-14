# Shared Agent Context Improvements Program — Phase Execution Prompts
Version: 0.1.0

## How to use

Replace angle-bracket placeholders and run one package prompt at a time unless
the program plan explicitly permits a parallel wave. Every prompt assumes the
project root, accepted package version, target branch, and Flow ID are explicit.
Use the project-local `flow-orchestrator`; never edit managed Flow state by hand.

## Common initialization prompt

```text
Run the project-local flow-orchestrator for <PACKAGE_ID> from
docs/requirements/<PACKAGE_PATH>/ at accepted version <VERSION>.

Project/worktree root: <ABSOLUTE_ROOT>.
Target branch: <TARGET_BRANCH>. Create or resume Flow <FLOW_ID>.

Before planning, read .metaproject/index.md, the complete package, the SAC
Improvements Program implementation plan and progress dashboard. Verify every
hard prerequisite from the program registry. If a prerequisite is incomplete,
stop with BLOCKED unless I provide a documented waiver.

Freeze package acceptance criteria, characterize current behavior with failing
falsifiers, propose the smallest dependency-safe vertical slices, and show the
plan, integration checkpoints, verification gates, rollback, files likely
affected, and agent count before implementation. Do not broaden scope.
```

## Common implementation/resume prompt

```text
Resume Flow <FLOW_ID> for <PACKAGE_ID> in <ABSOLUTE_WORKTREE>.
Read .metaproject/index.md and the accepted package first. Report current phase,
passed/total acceptance criteria, open blockers and required evidence. Execute
only the next unblocked phase. Use separate subagents only for independent
tasks, preserve owner boundaries, run package-directed tests and reviews, and
update the program dashboard from authoritative Flow evidence at safe boundary.
Stop on any program stop condition.
```

## Common review and completion prompt

```text
Run the completion pipeline for Flow <FLOW_ID> / <PACKAGE_ID>.
Review logic, architecture, security, project conventions and package-specific
contracts; run a strict meta-pass. Fix blockers through bounded iterations.
Then run required tests, type/lint/build, security, health, migration, docs and
rollback verification. Do not mark complete from test count alone.

Publish: requirements version/commit, implementation diff/PR, review verdict,
resolved and residual findings, verification evidence, rollback proof, outcome
baseline/delta, current-behavior docs update and program dashboard update.
If any required evidence is absent, return BLOCKED instead of completing.
```

## RP-12a — Documentation Taxonomy, Evidence, and Coverage

```text
Initialize RP-12 from docs/requirements/shared-agent-context-documentation-truth/.
Deliver Wave 0 only: add SAC graph/wiki coverage, capability/status taxonomy,
commit-pinned evidence, and current-behavior claim checks. Characterize
the obsolete propose guide, stale test totals, missing command discovery and
missing graph edges before changing generators/docs. Do not generate final
operation docs/examples or operation-registry CI yet; those depend on RP-09.
Exit only when current behavior claims are source-backed and taxonomy/evidence/
coverage drift checks fail on deliberate drift.
Do not change SAC runtime semantics in this Flow.
```

## RP-12b — Generated Operation Documentation

```text
Resume RP-12 from docs/requirements/shared-agent-context-documentation-truth/
only after RP-09 operation registry passes. Generate CLI/MCP/Harness operation
documentation and executable examples from that registry; pin evidence and add
CI gates for schema/default/risk/transport/auth/status parity and deliberate
drift. Do not hand-maintain a competing operation list. Exit only when all
shipped operations and examples are registry-derived and executable in CI.
```

## RP-01 — Runtime Truth

```text
Initialize RP-01 from docs/requirements/shared-agent-context-runtime-truth/
after RP-12a passes. First add falsifiers for policy metadata without output
change, candidate-derived baseline, 33/32 overflow, positional ID retargeting,
unpinned freshness, metadata-only detail and fake zero cost. Implement an
independent deterministic retrieval plan, mandatory core plus ranked optional
items, stable IDs, executed selection, useful bounded detail and measured-or-
unknown cost. Keep candidate disabled/shadow-only. Exit on output-level parity,
security non-regression, migration and rollback evidence.
```

## RP-04 — Promotion Integrity

```text
Initialize RP-04 from docs/requirements/shared-agent-context-promotion-integrity/
after RP-12a characterization and integrate final identity with RP-01 stable IDs.
Characterize mutable note, self-review, cross-proposal idempotency recovery,
new-correlation restart, crash boundaries, path/workspace confusion, hidden
kind-to-Skill fallback and missing link-back. Implement exhaustive target intent,
owner preview digest, independent-review policy, exact intent binding, restart-
safe recovery, receipt-bound owner write and workspace link-back. Run fault
injection at every persistence boundary. Never auto-accept.
```

## RP-05 — Secure Evidence

```text
Initialize RP-05 from docs/requirements/shared-agent-context-secure-evidence/
after RP-12a. Characterize live/unsealed sessions, transcript secret/PII/injection,
oversize, post-seal mutation, TTL expiry and deletion. Implement sealed sessions
and a schema-closed minimal wrap-up that is scanned before persistence. Default
to typed evidence references and schema-allowed minimised summary, not full
transcript. Full archive is
explicit restricted opt-in with retention/deletion. Exit at zero unsafe default
persistence and verified recovery/cleanup.
```

## RP-06a — Live Local Identity and Policy

```text
Initialize the local slice of RP-06 from
docs/requirements/shared-agent-context-identity-capabilities/ after RP-12a.
Replace constant strict-pass composition with a live server-owned provider,
declare local-single-user semantics, distinguish delegated execution identity,
centralize transport denial and continuously recheck role/policy revision.
Exercise spoofing, revoke, downgrade, cross-workspace and missing-policy cases.
HTTP/remote remains disabled. Complete RP-06a only; defer remote capabilities.
```

## RP-02 — Source-owned FWK Projections

```text
Initialize RP-02 from docs/requirements/shared-agent-context-source-projections/
after RP-01 contracts pass. Replace raw Flow JSON and Markdown status regex trust
with typed read-only owner ports for Flow, Evidence, Wiki, Memory and Skills.
Deliver canonical Work dispositions/evidence/AC, owner trust/applicability and a
canonical Wiki decision/body writer. Prove internal owner-format changes do not
break SAC. Do not add a Flow tracker or SAC knowledge store.
```

## RP-10 — Receipt Operability and Provenance

```text
Initialize RP-10 from docs/requirements/shared-agent-context-receipts-provenance/
after RP-01 receipt/cost contracts pass. Add metadata-only context capsules,
replay/drift reasons, explicit D0-D3 durability, sampling/batching boundaries,
retention/rotation/prune/verify/repair/quota and read-path SLOs. Label local hash
chains operational integrity only; add protected anchors solely for an explicit
cross-principal trust boundary. Benchmark 1/100/10k reads and verify recovery.
```

## RP-03 — Lifecycle Binding

```text
Initialize RP-03 from docs/requirements/shared-agent-context-lifecycle-binding/
after RP-02 and RP-04 contracts pass. Add optional immutable session/workspace/
Flow binding, shell --workspace, --session current and agent-native current/list.
Support side-effect-free Flow/worktree workspace preview and receipt-bound accepted
target link-back. Resume must preserve binding and least disclosure. Do not inject
all workspace/session content or auto-promote/modify Flow.
```

## RP-09 — Unified Operations and UX

```text
Initialize RP-09 from docs/requirements/shared-agent-context-unified-operations/
after RP-03 and RP-06a pass. Define one operation registry and derive CLI, MCP,
Harness, help and docs schemas/defaults/risk/transport/auth/normalization. Add
consistent capability enablement, workspace current/list/doctor, proposal inbox/
show/preview and public handoff. Preserve non-disclosure errors. Execute parity
and documentation examples in CI and provide deprecation aliases.
```

## RP-07 — Generational Memory

```text
Initialize RP-07 from docs/requirements/shared-agent-context-generational-memory/
after RP-02 and RP-05 pass. Implement explicit ephemeral observation -> TTL
workspace working set -> accepted owner knowledge transitions. Add temporal
validity/supersession, contradiction sets, abstention, tombstones, selective
forgetting/privacy deletion, applicability and evidence diversity. Evaluate
retrieval, update, contradiction, forgetting and abstention independently. Do
not add automatic promotion, SAC-owned durable memory or a default global vector DB.
```

## RP-08 — Collaboration and Worktrees

```text
Initialize RP-08 from docs/requirements/shared-agent-context-collaboration-worktrees/
after RP-03 and RP-06a pass. First split or safely envelope collaboration and
proposal ledgers; add a public metadata-only handoff writer and mixed lifecycle
tests. Then add causal events, TTL reservations as hints, explicit Project/Clone/
Checkout identity and portable immutable bundles. Evaluate shared read-only base
plus private overlays only after bundles work. Never share raw transcripts,
duplicate Flow state or infer authority from Git/filesystem proximity.
```

## RP-11 — Evaluation and Topology-aware Orchestration

```text
Initialize RP-11 from docs/requirements/shared-agent-context-evaluation-orchestration/
after Milestone 3. Freeze SAC-off, deterministic and candidate corpora with
independent verifier ownership. Measure task success, grounding, duplicate work,
handoff loss, unsafe persistence, tokens/time/tools and coordination overhead.
Run causal ablations for memory/provenance/reservations/multi-agent split and
compare single/sequential/parallel topology. Run candidate shadow-only. Publish
explicit retain/remove/defer decisions; agent self-report is never ground truth.
```

## Program reconciliation prompt

```text
Reconcile the Shared Agent Context Improvements Program from
docs/requirements/shared-agent-context-improvements-program/.
Read every child Flow/evidence bundle and the requirements roadmap. Recompute
dashboard status and aggregate metrics; keep unknown values unknown and every
P0 blocker visible. Check integration checkpoints IC-1..IC-6, identify dependency
or status contradictions, update roadmap/current docs, and produce the next
dependency-safe wave with owners, prompts, risks and explicit decisions. Treat
RP-11 retain/remove/defer as evaluation outcomes only; activation requires a
separate governed approval and a new/major requirements package.
Do not implement code during reconciliation.
```
