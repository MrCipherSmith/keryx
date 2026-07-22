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
<!-- generated: 2026-07-21T19:16:15.376Z | pages: 39 -->

### Architecture

- [OS Sandbox](architecture/os-sandbox.md) (accepted) - The OS sandbox is a kernel-enforced containment layer that sits *below* keryx's policy engine, structural command guard, env allowlist, and approval gate. Those layers decide **whether a command may start**; the OS sandbox constrains **what the process can do once running** — which paths it can write, which secrets it can read, and which network it can reach — using macOS Seatbelt (`sandbox-exec`) or Linux bubblewrap (`bwrap`). It adds no npm dependencies: containment is delegated to system binaries. When containment cannot be applied, a run is **refused**, never silently downgraded.
- [Project Map](architecture/project-map.md) (draft) - Deterministic map of 555 code files, 4 assets, and 1167 import edges across 64 top-level modules. Enrich each module page with the gdwiki skill.
- [Quality Map](architecture/quality-map.md) (accepted)
- [Testing Map](architecture/testing-map.md) (accepted) - This page provides a high-level map of the project's testing infrastructure. It documents the testing framework in use, the available test scripts, configuration files, and the location of test files. This map is auto-generated to serve as a quick reference for developers and CI/CD pipelines.

### Domain Model

_No pages yet._

### Business Rule

_No pages yet._

### User Scenario

_No pages yet._

### Component

  - [fixtures/change-impacted-test/src](components/fixtures-change-impacted-test-src.md) (accepted)
  - [fixtures/churn-complexity/src](components/fixtures-churn-complexity-src.md) (accepted)
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
- [src/health](components/src-health.md) (accepted)
  - [src/health/metrics](components/src-health-metrics.md) (accepted)
  - [src/health/sources](components/src-health-sources.md) (accepted)
- [src/lib](components/src-lib.md) (accepted)
- [src/mcp](components/src-mcp.md) (accepted)
  - [src/mcp/transport](components/src-mcp-transport.md) (accepted)
- [src/memory](components/src-memory.md) (accepted)
  - [src/memory/embedding](components/src-memory-embedding.md) (accepted)
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

_No pages yet._
<!-- keryx:wiki-index:end -->
