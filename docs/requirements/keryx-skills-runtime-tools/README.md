# Keryx Skills Runtime Tools
Version: 0.1.0

## Purpose

Give the `.metaproject/skills/` system a real runtime surface. Today it has
none: skill discovery and loading happen entirely through prose in
`CLAUDE.md`/`AGENTS.md` and `.metaproject/index.md`'s "Intent Router" table,
which a connected agent must read and voluntarily obey, then load a
`SKILL.md` with a plain `Read` call indistinguishable from reading any other
file. There is no MCP tool, no CLI command, and no structured event for
"a skill was selected" or "a skill was loaded" anywhere in `src/mcp/` —
`tools.ts`, `dispatch.ts`, `metaproject-tools.ts`, and `resources.ts` were
searched case-insensitively for "skill"; the only two hits are code
comments, not a registered tool name (dot-form static tools like
`sac.overview`, `wiki.query`, and every `MetaprojectOperation` name like
`graph_affected`/`memory_search`/`flow_status` were all checked); none is
skill-related.

This package proposes closing that gap using the extension point that
already exists for every other Metaproject capability:
`src/harness/tool/metaproject-operations.ts`'s single-source
`MetaprojectOperation[]` array, which projects one descriptor into three
consumers (interactive agent tool, harness `ToolRegistry`, MCP `ToolEntry`)
for free. Two new operations — `skills_catalog` and `skill_load` — would give
every connected agent (not only one that happens to load and obey
`CLAUDE.md`) a structured way to discover and load `.metaproject/skills/`
content, and give keryx a structural, loggable signal that a skill was
actually used, in place of the self-reported "routing audit" line the
current prose convention asks the model to write.

It also proposes a second, complementary path specific to Claude Code:
materializing installed gdskills into `.claude/skills/<name>/SKILL.md` so
Claude Code's own native `Skill` tool — progressive disclosure, relevance
matching, `/name` slash commands, all of it — handles discovery and loading
without keryx reimplementing any of that machinery. The MCP operations are
the path for every other supported assistant (`codex`, `cursor`, `zed`,
`opencode` — the `compatibility:` field already on every bundled
`SKILL.md`'s frontmatter) that has no equivalent native mechanism.

## Status

**draft.** Nothing in this package is implemented. It follows a live
comparative review (this package's [brainstorm.md](brainstorm.md)) of how
Claude Code itself, and five open-source coding-agent CLIs
(`opencode`, `cline`, `kilocode`, `continue`, `oh-my-claudecode`), each
implement skill/capability discovery and loading, and of how eleven CLIs
implement `web_fetch` — the latter only as a calibration reference for how
rigorous a comparable keryx mechanism (`SandboxedWebTransport`) already is,
not as scope for this package.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Operation identity, data contracts, integration points, CLI/MCP surface, acceptance criteria. |
| [brainstorm.md](brainstorm.md) | Comparative research: Claude Code's own Skill/WebFetch mechanism and five CLI forks' skill-loading designs; what keryx does and does not share with them. |
| [decisions.md](decisions.md) | D-01..D-06: MCP tool vs. native materialization, catalog scope, verification mechanism, slash-command exposure, backward compatibility with the prose path. |
| [schemas/skills-catalog-result.schema.json](schemas/skills-catalog-result.schema.json) | Output contract for `skills_catalog`. |
| [schemas/skill-load-result.schema.json](schemas/skill-load-result.schema.json) | Output contract for `skill_load`. |

## Scope

- Two new `MetaprojectOperation` descriptors (`skills_catalog`, `skill_load`),
  widening `MetaprojectOperation["module"]` to include `"gdskills"`.
- A `MetaprojectPort` extension (`skillsCatalog`, `loadSkill`) and a reference
  adapter reading the consuming project's installed
  `.metaproject/skills/catalog.md` + `skills/gdskills/**/SKILL.md` (not
  keryx's own `src/gdskills/bundled/skills/`, which is the install-time
  source, not the runtime artifact).
- An install-time step (`keryx init`/`keryx update`) that materializes every
  installed gdskill into `.claude/skills/<name>/SKILL.md` with Claude-Code-
  native frontmatter, for Claude Code sessions specifically.
- A verification signal keryx's own `flow`/`health` gates can check —
  "was `skill_load` called for the skills this flow's routing implied" —
  replacing reliance on a self-reported routing-audit line.
- Optional: exposing every gdskill as a `/name` slash command for assistants
  that don't natively support skill relevance-matching (mirrors the
  opencode/cline/kilocode dual-path convention).

## Non-goals

- Removing or deprecating `CLAUDE.md`/`index.md` prose routing. It stays as
  the fallback for assistants that support neither MCP tools nor native
  Skill materialization; this package adds structured paths beside it, not
  instead of it (see [decisions.md](decisions.md) D-05).
- Any change to `WebFetch`/`SandboxedWebTransport`, the search subsystem, or
  any other already-shipped tool. `brainstorm.md`'s web-fetch comparison is
  reference material only.
- `entity-skill-learner`/`entity-skill-verifier`'s authoring and learning
  pipeline (`keryx skills learn`, `keryx skills create`) — already shipped,
  out of scope; this package is about *loading*, not *authoring*, skills.
- A generic cross-assistant "skill protocol" standard. This package targets
  keryx's own supported assistants only.

## Related modules

- `.metaproject/skills/gdskills/` and `src/gdskills/` — the skill content and
  install/sync/catalog machinery this package adds a runtime surface to,
  without changing.
- `src/harness/tool/metaproject-operations.ts` / `metaproject-port.ts` /
  `metaproject-adapter.ts` — the single-source operation registry this
  package extends (flow 038/040, "MP-3").
- `src/mcp/metaproject-tools.ts` / `tools.ts` / `dispatch.ts` — the MCP
  projection layer the new operations surface through automatically once
  registered.
- [Keryx External Agent Runtime](../keryx-external-agent-runtime/README.md) —
  unrelated in scope, cited only as this repository's exemplar for honest,
  code-grounded package writing that this package follows.
