# Metaproject Roadmap

Version: 0.4.0

## 1. Purpose

Single source of truth for module implementation status in `gd-metapro`.

Module identity and enable state come from the manifest registry written by
`gd-metapro init` (`metaproject.json` `modules`). This document maps that
registry to human-readable status and points at each module's requirements.

## 2. Status Legend

- `implemented` - shipped and enabled by default in `gd-metapro init`.
- `in progress` - partially shipped; some phases remain.
- `spec ready` - production-ready requirements frozen; implementation not started.
- `planned` - drafted or idea stage, not yet spec-frozen (manifest entry disabled).

## 3. Module Status

| Module | CLI namespace | Manifest key | Status | Requirements |
|---|---|---|---|---|
| spec-orchestrator | `init`, `status`, `update` | - | implemented | [spec-orchestrator/](spec-orchestrator/) |
| gdgraph | `gd-metapro gdgraph` | `gdgraph` | implemented | [gdgraph/](gdgraph/) |
| gdctx | `gd-metapro ctx` | `gdctx` | implemented | [gdctx/](gdctx/) |
| gdwiki | `gd-metapro wiki` | `wiki` | implemented (MVP) | [wiki/](wiki/) |
| Documentation Memory | `gd-metapro memory` | `memory` | spec ready | [documentation-memory/](documentation-memory/) |
| Task Manager | `gd-metapro tasks` | `tasks` | planned | - |
| Code Health | `gd-metapro health` | `health` | in progress (Phase 1 shipped) | [code-health/](code-health/) |
| Testing Tools | `gd-metapro test` | `testing` | planned | - |
| gdskills / Project Skills | `gd-metapro skills` | `gdskills` | implemented (MVP) | [gdskills/](gdskills/) |

## 4. gdwiki (implemented, MVP)

Version: `0.2.0`. See [wiki/specification.md](wiki/specification.md) section 12.

Shipped:

- init scaffold: `wiki/<type>/`, `wiki/templates/`, `data/gdwiki/`, manifest, skill;
- CLI: `gd-metapro wiki status | new | index | check-links | validate`;
- versioned Markdown pages (8 page types) with required metadata;
- managed `wiki/index.md` generation between markers;
- internal link validation with report and non-zero exit on breakage;
- agent routing: conceptual questions go to gdwiki first, then to code via gdgraph; gdctx runs in parallel.

Remaining (Phase 3):

- release metrics.

## 5. gdskills (implemented, MVP)

Version: `0.19.0`. See [gdskills/specification.md](gdskills/specification.md).

Shipped:

- init scaffold: bundled project-local gdskills, catalog, module manifest, data/core folders;
- CLI: `status`, `list`, `inspect`, `route`, `catalog`, `install`, `create`, `verify`, `learn`, `export`, `sync`, `contracts`;
- root alias: `gd-metapro skill-verify-skill`;
- project-skill package creation under `.metaproject/project-skills/<module>/<entity>/`;
- verifier reports under `.metaproject/data/gdskills/reports/`;
- learning proposals and explicit apply flow under `.metaproject/data/gdskills/proposals/`;
- runtime export/sync for Codex and Claude artifacts;
- JSON Schema contracts for orchestrator and subagent communication;
- optional git post-commit hook for project-skill verification;
- local-first agent routing through `.metaproject/index.md` and `.metaproject/skills/catalog.md`.

Remaining:

- deeper semantic verification against entity ownership maps;
- richer health and memory evidence once those modules mature;
- production test expansion beyond current smoke/contract checks.

## 6. Next Candidates

Order is indicative, not committed:

1. Documentation Memory (`gd-metapro memory`) - typed memory registry with search.
2. Code Health Phase 2 (`gd-metapro health`) - Sonar/complexity adapters, entity/skill scopes, gdskills learning, trend history.
3. Task Manager (`gd-metapro tasks`).
4. Testing Tools (`gd-metapro test`).

## 7. Maintenance

- Update the status table when a module's manifest entry flips to enabled.
- Bump this document's `Version` on every change per
  [documentation-versioning.md](documentation-versioning.md).
- Keep per-module phase detail in each module's `specification.md`, not here.
