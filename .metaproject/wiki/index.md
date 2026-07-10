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
<!-- generated: 2026-07-09T21:30:33.734Z | pages: 36 -->

### Architecture

- [Project Map](architecture/project-map.md) (draft) - Deterministic map of 298 code files, 4 assets, and 676 import edges across 34 top-level modules. Enrich each module page with the gdwiki skill.
- [Quality Map](architecture/quality-map.md) (draft) - Generated from Code Health: gate warn, score 90, 62 findings.
- [Testing Map](architecture/testing-map.md) (draft) - generatedAt: 2026-07-07T09:16:39.033Z

### Domain Model

_No pages yet._

### Business Rule

_No pages yet._

### User Scenario

_No pages yet._

### Component

  - [fixtures/change-impacted-test/src](components/fixtures-change-impacted-test-src.md) (draft)
  - [fixtures/churn-complexity/src](components/fixtures-churn-complexity-src.md) (draft)
- [src](components/src.md) (draft)
- [src/agents](components/src-agents.md) (draft)
- [src/assets](components/src-assets.md) (draft)
- [src/capability](components/src-capability.md) (draft)
- [src/commands](components/src-commands.md) (draft)
- [src/ctx](components/src-ctx.md) (draft)
- [src/flow](components/src-flow.md) (draft)
  - [src/flow/tracker](components/src-flow-tracker.md) (draft)
- [src/gdgraph](components/src-gdgraph.md) (draft)
  - [src/gdgraph/treesitter](components/src-gdgraph-treesitter.md) (draft)
- [src/gdskills](components/src-gdskills.md) (draft)
- [src/harness](components/src-harness.md) (draft)
- [src/health](components/src-health.md) (draft)
  - [src/health/metrics](components/src-health-metrics.md) (draft)
  - [src/health/sources](components/src-health-sources.md) (draft)
- [src/lib](components/src-lib.md) (draft)
- [src/mcp](components/src-mcp.md) (draft)
  - [src/mcp/transport](components/src-mcp-transport.md) (draft)
- [src/memory](components/src-memory.md) (draft)
  - [src/memory/embedding](components/src-memory-embedding.md) (draft)
- [src/review](components/src-review.md) (draft)
- [src/rules](components/src-rules.md) (draft)
- [src/security](components/src-security.md) (draft)
  - [src/security/agent-hooks](components/src-security-agent-hooks.md) (draft)
  - [src/security/detect](components/src-security-detect.md) (draft)
    - [src/security/detect/injection](components/src-security-detect-injection.md) (draft)
    - [src/security/detect/pii](components/src-security-detect-pii.md) (draft)
  - [src/security/eval](components/src-security-eval.md) (draft)
- [src/standard](components/src-standard.md) (draft)
- [src/testing](components/src-testing.md) (draft)
- [src/wiki](components/src-wiki.md) (draft)

### Service

_No pages yet._

### Integration

_No pages yet._

### Decision

_No pages yet._
<!-- keryx:wiki-index:end -->
