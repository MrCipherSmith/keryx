# Project Wiki

Version: 0.1.0

## Purpose

This is the local project knowledge base. It stores knowledge that should
outlive a single task: architecture, domain models, business rules, user
scenarios, components, services, integrations, and known decisions.

Read this index first. Do not read every page unless necessary.

## Page Types

- `architecture` - system or module architecture
- `domain-model` - entities, invariants, relationships
- `business-rule` - business constraints and decisions
- `user-scenario` - user workflows and expected outcomes
- `component` - UI/component behavior and ownership
- `service` - backend/service responsibility and APIs
- `integration` - external systems and contracts
- `decision` - known decisions and ADR-like records

## Create A Page

```bash
keryx wiki new <type> <slug> --title "<title>"
keryx wiki index
```

## Pages

<!-- keryx:wiki-index:begin -->
<!-- generated: 2026-08-19T12:29:46.754Z | pages: 48 -->

### Architecture

- [Background Shell Jobs](architecture/background-jobs.md) (accepted) - `shell_exec` gained an optional `background: true` input (flow 173): instead of blocking the agent turn until the command exits (the existing `DEFAULT_SHELL_TIMEOUT_MS`-gated synchronous path, untouched), it starts a detached, tracked process and returns immediately with a `job_id`. Two new `risk: "read"` tools — `shell_job_output(job_id)` (incremental, cursor-based new-output-only) and `shell_job_kill(job_id)` — let the model check on and stop it later. A parallel TUI layer (a sidebar "Background Jobs N" panel, clickable rows opening a live-updating Output/Meta modal) gives the human the same visibility without relying on the model to keep reporting back.
- [OS Sandbox](architecture/os-sandbox.md) (accepted) - The OS sandbox is a kernel-enforced containment layer that sits *below* keryx's policy engine, structural command guard, env allowlist, and approval gate. Those layers decide **whether a command may start**; the OS sandbox constrains **what the process can do once running** — which paths it can write, which secrets it can read, and which network it can reach — using macOS Seatbelt (`sandbox-exec`) or Linux bubblewrap (`bwrap`). It adds no npm dependencies: containment is delegated to system binaries. When containment cannot be applied, a run is **refused**, never silently downgraded.
- [Permission Modes](architecture/permission-modes.md) (accepted) - The interactive agent session (`keryx shell`, both the OpenTUI surface and the readline fallback) has three user-selectable permission modes — `ask`, `trust`, `auto` — that decide whether a mutating tool call (`shell_exec`, `spawn_subagent`, any tool declaring `risk: "destructive"`) prompts for approval before it runs. They sit **above** the existing per-call approval gate in `src/commands/agent.ts`'s `executeCall`, deciding whether `AgentIO.requestApproval` is even invoked — never replacing it, and never touching the separate `src/harness/policy`/`src/harness/mutation` evidence engine that governs `harness run`/`harness exec`/`keryx serve` (see "Explicitly out of scope" below).
- [Project Map](architecture/project-map.md) (accepted) - This page is the deterministic architecture map for the project. It captures the repository as a graph of code files and assets, including import relationships between top-level modules.
- [Quality Map](architecture/quality-map.md) (accepted)
- [Testing Map](architecture/testing-map.md) (accepted) - This page provides a high-level map of the project's testing infrastructure. It documents the testing framework in use, the available test scripts, configuration files, and the location of test files. This map is auto-generated to serve as a quick reference for developers and CI/CD pipelines.
- [Wiki, Graph, and Shared Agent Context](architecture/wiki-graph-sac.md) (accepted) - The project wiki, the code graph, and Shared Agent Context (SAC) are one connected stack with three owners. Graph answers structural questions. Wiki stores curated long-lived understanding. SAC is a reviewed collaboration entry point: it references those owners, projects Flow as Work, and never becomes a second wiki.

### Domain Model

_No pages yet._

### Business Rule

_No pages yet._

### User Scenario

_No pages yet._

### Component

  - [fixtures/change-impacted-test/src](components/fixtures-change-impacted-test-src.md) (accepted)
  - [fixtures/churn-complexity/src](components/fixtures-churn-complexity-src.md) (accepted)
- [scripts/benchmark](components/scripts-benchmark.md) (accepted)
- [src](components/src.md) (accepted)
- [src/agents](components/src-agents.md) (accepted)
- [src/assets](components/src-assets.md) (accepted)
- [src/capability](components/src-capability.md) (accepted)
- [src/commands](components/src-commands.md) (accepted)
- [src/ctx](components/src-ctx.md) (accepted)
- [src/flow](components/src-flow.md) (accepted)
  - [src/flow/tracker](components/src-flow-tracker.md) (accepted)
- [src/gdgraph](components/src-gdgraph.md) (accepted)
  - [src/gdgraph/treesitter](components/src-gdgraph-treesitter.md) (accepted)
- [src/gdskills](components/src-gdskills.md) (accepted)
- [src/harness](components/src-harness.md) (accepted)
  - [src/harness/child](components/src-harness-child.md) (accepted)
  - [src/harness/provider](components/src-harness-provider.md) (accepted)
    - [src/harness/tool/builtin](components/src-harness-tool-builtin.md) (accepted)
- [src/health](components/src-health.md) (accepted)
  - [src/health/metrics](components/src-health-metrics.md) (accepted)
  - [src/health/sources](components/src-health-sources.md) (accepted)
- [src/lib](components/src-lib.md) (accepted)
- [src/mcp](components/src-mcp.md) (accepted)
  - [src/mcp/transport](components/src-mcp-transport.md) (accepted)
- [src/memory](components/src-memory.md) (accepted)
  - [src/memory/embedding](components/src-memory-embedding.md) (accepted)
- [src/metrics](components/src-metrics.md) (accepted)
- [src/review](components/src-review.md) (accepted)
- [src/rules](components/src-rules.md) (accepted)
- [src/security](components/src-security.md) (accepted)
  - [src/security/agent-hooks](components/src-security-agent-hooks.md) (accepted)
  - [src/security/detect](components/src-security-detect.md) (accepted)
    - [src/security/detect/injection](components/src-security-detect-injection.md) (accepted)
    - [src/security/detect/pii](components/src-security-detect-pii.md) (accepted)
  - [src/security/eval](components/src-security-eval.md) (accepted)
- [src/standard](components/src-standard.md) (accepted)
- [src/sync](components/src-sync.md) (accepted)
- [src/testing](components/src-testing.md) (accepted)
- [src/tui](components/src-tui.md) (accepted)
- [src/wiki](components/src-wiki.md) (accepted)

### Service

_No pages yet._

### Integration

_No pages yet._

### Decision

- [SAC: SAC harness integration demo](decisions/sac-proposal-a41fc4152ad147e2.md) (draft) - SAC complements wiki and graph; it does not replace them.
<!-- keryx:wiki-index:end -->
