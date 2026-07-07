# Metaproject Roadmap

Version: 0.9.1

## 1. Purpose

Single source of truth for module implementation status in `gd-metapro`.

Module identity and enable state come from the manifest registry written by
`gd-metapro init` (`metaproject.json` `modules`). This document maps that
registry to human-readable status and points at each module's requirements.

## 2. Status Legend

- `implemented` - shipped and enabled by default in `gd-metapro init`.
- `in progress` - partially shipped; some phases remain.
- `spec ready` - production-ready requirements frozen; implementation not started.
- `draft spec package` - requirements/specification package exists, but the
  implementation contract is not frozen yet.
- `planned` - drafted or idea stage, not yet spec-frozen (manifest entry disabled).

## 3. Module Status

| Module | CLI namespace | Manifest key | Status | Requirements |
|---|---|---|---|---|
| spec-orchestrator | `init`, `status`, `update`, `rules` (`sync`/`distill`), `dashboard`/`dash`, `modules` | - | implemented | [spec-orchestrator/](spec-orchestrator/) |
| gdgraph | `gd-metapro gdgraph` | `gdgraph` | implemented | [gdgraph/](gdgraph/) |
| gdctx | `gd-metapro ctx` | `gdctx` | implemented | [gdctx/](gdctx/) |
| gdwiki | `gd-metapro wiki` | `gdwiki` | implemented (enriched collect + enrich skill) | [wiki/](wiki/) |
| Documentation Memory | `gd-metapro memory` | `memory` | implemented (Phase 1 + 2) | [documentation-memory/](documentation-memory/) |
| Task Manager | `gd-metapro flow` | `tasks` | implemented (Phase 1) | [task-manager/](task-manager/) |
| Code Health | `gd-metapro health` | `health` | implemented (Phase 1 + 2) | [code-health/](code-health/) |
| Testing Module | `gd-metapro test` | `testing` | implemented (MVP) | [testing/](testing/) |
| gdskills / Project Skills | `gd-metapro skills` | `gdskills` | implemented (Phase 1 + bundled orchestrators) | [gdskills/](gdskills/) |
| Metaproject Standard | `gd-metapro standard` | - | implemented (v0.1 validator) | [metaproject-standard/](metaproject-standard/) |
| Metaproject Security | `gd-metapro security` | `security` | implemented (v0.1, Phase 1+2+3 write-seam integrations) | [security/](security/) |

## 4. gdwiki (implemented, MVP + collector)

Version: `0.3.0`. See [wiki/specification.md](wiki/specification.md) section 12.

Shipped:

- init scaffold: `wiki/<type>/`, `wiki/templates/`, `data/gdwiki/`, manifest, skill;
- CLI: `gd-metapro wiki status | new | collect | index | check-links | validate`;
- collect (deterministic, no model): `wiki collect [--changed [--since <ref>]]` derives real per-module signals (dependencies, key files by connectivity, entry points, exported symbols) and writes prose-first drafts (`Overview`/`How it works`/`Key concepts`/`Main flows`) with graph facts under `## Reference`; safe-force protects accepted/edited pages; `--changed` refreshes only touched modules;
- enrich (agent skill, cheap model): the gdwiki skill fills the prose sections on a non-flagship model (one subagent per page), then marks pages `accepted`;
- non-mutating `gdwiki-post-commit` hook reminds to run `wiki collect --changed --since HEAD~1` and enrich on a cheap model;
- versioned Markdown pages (8 page types) with required metadata;
- managed `wiki/index.md` generation between markers;
- internal link validation with report and non-zero exit on breakage;
- agent routing: conceptual questions go to gdwiki first, then to code via gdgraph; gdctx runs in parallel.

Remaining (Phase 3):

- release metrics.

## 5. gdskills (implemented, MVP)

Version: `0.22.5`. See [gdskills/specification.md](gdskills/specification.md).

Shipped:

- init scaffold: bundled project-local gdskills, catalog, module manifest, data/core folders;
- real self-contained bundled skills under `src/gdskills/bundled/skills/**`, copied into `.metaproject/skills/gdskills/**` with contracts/templates/runtime variants preserved;
- bundled reusable core rules under `src/gdskills/bundled/rules/core/**`, copied into `.metaproject/rules/core/**`;
- CLI: `status`, `list`, `inspect`, `route`, `catalog`, `install`, `create`, `verify`, `learn`, `export`, `sync`, `contracts`;
- root alias: `gd-metapro skill-verify-skill`;
- project-skill package creation under `.metaproject/project-skills/<module>/<entity>/`;
- verifier reports under `.metaproject/data/gdskills/reports/`;
- learning proposals and explicit apply flow under `.metaproject/data/gdskills/proposals/`;
- runtime export/sync for Codex and Claude artifacts;
- JSON Schema contracts for orchestrator and subagent communication;
- bundled `requirements-package-orchestrator` and `requirements-package-reviewer`
  for Metaproject `docs/requirements` package creation and verification;
- bundled `metaproject-security` skill for security module policy workflows;
- optional git post-commit hook for project-skill verification;
- local-first agent routing through `.metaproject/index.md` and `.metaproject/skills/catalog.md`.

Remaining:

- deeper semantic verification against entity ownership maps;
- richer health and memory evidence once those modules mature;
- production test expansion beyond current smoke/contract checks.

## 6. Next Candidates

Order is indicative, not committed:

1. Task Manager Phase 2 (`gd-metapro flow`) - Notion/Jira adapters, flow board artifact, memory/wiki links.
2. Metaproject Security Phase 4 (`gd-metapro security`) - optional model/API detection backends, profiles/hooks, and gateway mode (Phase 1+2 deterministic engine + CLI and the Phase 3 write-seam integrations at memory/wiki/testing/gdctx/flow are already shipped).
3. gdwiki release metrics and richer dashboard navigation.
4. gdskills semantic verification against entity ownership maps.
5. Code Health Phase 3 (`gd-metapro health`) - advanced trend analytics and larger-project tuning.
6. Metaproject Standard beyond v0.1 - module annex schemas and stricter profile enforcement (the v0.1 `standard validate|doctor|capabilities` commands are shipped).

## 7. Technical Remediation Status

Recent technical-feedback fixes shipped in the current implementation track:

- `gdgraph`: parser-backed import extraction, regex fallback, and root
  `tsconfig.json` `baseUrl`/`paths` alias resolution for source and asset
  imports;
- `Code Health`: finding adapters run in parallel while report ordering stays
  deterministic; complexity remains token-based but nested function bodies are
  counted separately from their parent function; default generated/static
  ignores are additive with local config, ignored findings are filtered after
  source parsing, and the dashboard explains score/risk/gate, P-priority
  meanings, score formula, recommended fix order and report-quality warnings;
- Git hooks: `gd-metapro update --hooks` updates only marked managed blocks and
  preserves existing user hook content;
- CLI parsing: first command slice migrated to the shared `parseArgs` helper.

## 8. Maintenance

- Update the status table when a module's manifest entry flips to enabled.
- Bump this document's `Version` on every change per
  [documentation-versioning.md](documentation-versioning.md).
- Keep per-module phase detail in each module's `specification.md`, not here.
