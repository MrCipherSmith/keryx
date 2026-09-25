# Keryx Agent Platform Expansion
Version: 0.1.1

## Status

`draft` — spec ready for Wave 0 only after review. Nothing described as
`planned` in this package exists in code today unless a specific section cites
a file path as proof. See [prd.md](prd.md) for the problem this package solves
and [implementation-plan.md](implementation-plan.md) for the wave gate that
turns `draft` into an implementable spec.

## Purpose

This package is the program-level control plane for eight workstreams (W1–W8)
that close gaps in Keryx's own stack coverage, agent definitions, self-learning
loop, cross-harness portability, multi-harness hook/adapter support, keryx
shell's own hook system, gdgraph/gdctx correctness, and harness-config security
auditing. It does not implement any of the eight; each workstream is its own
bounded unit with its own acceptance criteria, to be delivered through separate
managed Flows once this package is reviewed and a wave is authorized.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This file — purpose, status, index, scope, related modules. |
| [prd.md](prd.md) | Problem, goal, users, requirements R1..Rn grouped by workstream, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Umbrella spec — module identity, storage tree, CLI surface table, shared contracts, integration map, invariants, acceptance criteria index. |
| [brainstorm.md](brainstorm.md) | Original request list and decisions D-1..D-8 with rationale. |
| [implementation-plan.md](implementation-plan.md) | Waves 0–4, entry/exit criteria, dependencies, model-tier guidance. |
| [metrics-and-validation.md](metrics-and-validation.md) | Per-workstream metrics, thresholds, validation method. |
| [workstreams/W1-stack-catalog.md](workstreams/W1-stack-catalog.md) | Stack-aware skills & rules catalog: detection, packs, install profiles, governance. |
| [workstreams/W2-agent-catalog.md](workstreams/W2-agent-catalog.md) | Canonical agent-definition layer compiled into dispatch contracts; exporters. |
| [workstreams/W3-self-learning.md](workstreams/W3-self-learning.md) | Observe → extract → candidate → review/consent → apply → promote → graduate learning loop. |
| [workstreams/W4-portability.md](workstreams/W4-portability.md) | Portable bundle export/import, user-level store, cross-harness memory handoff. |
| [workstreams/W5-multi-harness.md](workstreams/W5-multi-harness.md) | Unified harness adapter registry and capability matrix. |
| [workstreams/W6-shell-hooks.md](workstreams/W6-shell-hooks.md) | keryx shell's own lifecycle hook runtime. |
| [workstreams/W7-graph-ctx-correctness.md](workstreams/W7-graph-ctx-correctness.md) | gdgraph/gdctx defect register, correctness benchmark, fixes. |
| [workstreams/W8-harness-security-audit.md](workstreams/W8-harness-security-audit.md) | Harness-config security audit and impact-evidence gate. |
| [schemas/install-manifest.schema.json](schemas/install-manifest.schema.json) | W1 — install profiles/modules/components manifest shape. |
| [schemas/agent-definition.schema.json](schemas/agent-definition.schema.json) | W2 — canonical agent-definition record shape. |
| [schemas/learned-pattern.schema.json](schemas/learned-pattern.schema.json) | W3 — learned pattern candidate/accepted record shape. |
| [schemas/portable-bundle.schema.json](schemas/portable-bundle.schema.json) | W4 — portable bundle manifest shape. |
| [schemas/harness-capability-matrix.schema.json](schemas/harness-capability-matrix.schema.json) | W5 — harness capability matrix record shape. |
| [schemas/hook-config.schema.json](schemas/hook-config.schema.json) | W6 — keryx shell hook configuration shape. |
| [schemas/harness-audit-report.schema.json](schemas/harness-audit-report.schema.json) | W8 — harness-config security audit report shape. |

## Scope

**In scope**

- Eight independent workstreams (W1–W8) as documentation packages with
  requirements, contracts, and acceptance-criteria indices.
- A shared vocabulary and set of cross-cutting invariants that every
  workstream's later implementation must respect (fail closed, proposals never
  write, hooks only tighten, no automatic promotion, honest support matrix, no
  network by default).
- A dependency-ordered implementation plan (waves 0–4) that sequences the
  eight workstreams without pre-creating flow IDs.
- Mapping of the user's original request list to the workstreams that address
  it (see [prd.md](prd.md) and [brainstorm.md](brainstorm.md)).

**Non-goals**

- Implementing any workstream. This package produces requirements only; each
  workstream is realized through its own managed Flow after this package is
  reviewed.
- Merging the eight workstreams into one implementation branch or one PR.
- Bulk-generating stack packs or per-stack agents ahead of the governance
  gates W1 defines (decision D-7).
- Enabling automatic promotion of learned content, remote harness capabilities,
  or any other capability the `shared-agent-context-generational-memory`
  package already places behind an explicit human decision.
- Copying text from any external
  tool, plugin catalog, or repository. Every design in this package is
  justified by Keryx's own code, constraints, and stated goals.

## Goals-to-workstreams map

| User goal (paraphrased) | Workstream(s) |
|---|---|
| 1. Broaden which stacks/frameworks Keryx's skills and rules actually cover | W1 |
| 2. Give Keryx a self-learning loop (observe → extract → apply, with consent) | W3 |
| 3. Make skills, rules, agents, and learned content portable across harnesses and installs | W4 |
| 4. Support more harnesses consistently, including hooks in keryx shell itself | W5, W6 |
| 5. Fix known gdgraph/gdctx correctness defects before anything else routes through them | W7 |
| 6. Keep the skills/rules catalog aligned with current best practices (authoring, dedupe, evals) | W1 |
| 7. Add a real, reusable agent-definitions catalog ("реализовать агентов") | W2 |
| Cross-cutting: audit harness configs and hooks for security risk before trusting them | W8 |

## Related modules

| Module | Relationship |
|---|---|
| [`keryx-multi-agent-engine`](../keryx-multi-agent-engine/README.md) | Owns the `spawn_subagent` dispatch contract and child-execution substrate that W2's agent-definition layer compiles into; W2 revisits this package's documented non-goal ("a separate `.claude/agents/*.md`-style loader") as decision D-2. |
| [`keryx-skills-runtime-tools`](../keryx-skills-runtime-tools/README.md) | Owns the `skills_catalog`/`skill_load` MCP operations that W1 stack packs and W2 agent exporters both build on for structured, non-prose skill/agent discovery. |
| [`keryx-claude-plugin`](../keryx-claude-plugin/README.md) | Prior assessment of bundling skills+hooks+MCP into one portable artifact; its finding (engineering case currently weak) bounds what W4's portable-bundle format and W5's adapter registry should and should not attempt. |
| [`shared-agent-context-generational-memory`](../shared-agent-context-generational-memory/README.md) | Source of the "no automatic promotion, acceptance, or overwrite" constraint that W3's project→user promotion step and W4's cross-harness memory handoff must respect. |
| [`managed-review-feedback-loop`](../managed-review-feedback-loop/README.md) | Owns the review round/finding/verdict pipeline that feeds W3's reviewer-profile learning and observation sources. |
| [`keryx-context-measurement`](../keryx-context-measurement/context-loading.md) | Documents the measured cost of the `.metaproject/index.md` hard-gate and `keryx orient` injection that motivates part of W7's correctness and freshness work. |
| [`keryx-context-operations`](../keryx-context-operations/2026-07-12/README.md) | Planned governed context-assembly layer that W7's gdgraph/gdctx fixes are a prerequisite for, per decision D-8. |
| [`keryx-os-sandbox`](../keryx-os-sandbox/README.md) | Containment layer that W6's hook execution and W8's audit-fix-proposal application should run inside, consistent with its documented platform matrix and fail-closed behavior. |
| [`keryx-mcp-servers`](../keryx-mcp-servers/README.md) | Outbound MCP-client capability that W8's harness-config audit must scan (unpinned npx/uvx servers) as one of its surfaces. |
