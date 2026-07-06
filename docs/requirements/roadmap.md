# Metaproject Roadmap

Version: 0.3.0

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
| Documentation Memory | `gd-metapro memory` | `memory` | planned | - |
| Task Manager | `gd-metapro tasks` | `tasks` | planned | - |
| Code Health | `gd-metapro health` | `health` | in progress (Phase 1 shipped) | [code-health/](code-health/) |
| Testing Tools | `gd-metapro test` | `testing` | planned | - |
| gdskills / Domain Skills | `gd-metapro skills` | `domain-skills` | planned | - |

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

## 5. Next Candidates

Order is indicative, not committed:

1. Code Health Phase 2 (`gd-metapro health`) - Sonar/complexity adapters, entity/skill scopes, gdskills learning, trend history.
2. Documentation Memory (`gd-metapro memory`) - typed memory registry with search.
3. Task Manager (`gd-metapro tasks`).
4. Testing Tools (`gd-metapro test`).

## 6. Maintenance

- Update the status table when a module's manifest entry flips to enabled.
- Bump this document's `Version` on every change per
  [documentation-versioning.md](documentation-versioning.md).
- Keep per-module phase detail in each module's `specification.md`, not here.
