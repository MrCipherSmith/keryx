# Skills runtime tools: skills_catalog + skill_load MetaprojectOperations (R1+R2 from keryx-skills-runtime-tools docpack)

Status: formalized
Source: `docs/requirements/keryx-skills-runtime-tools/` (committed this session,
commit `b382145`, reviewed via `docpack-review`: 0 blockers)

## Problem

`.metaproject/skills/` has no runtime surface. Discovery/loading happen only
through `CLAUDE.md`/`index.md` prose an agent must read and voluntarily obey,
then a plain `Read` on a `SKILL.md` — confirmed directly against
`src/mcp/tools.ts`, `dispatch.ts`, `metaproject-tools.ts`, `resources.ts`:
zero skill-related MCP tool exists today. Full problem statement, evidence,
and the comparative research behind it are in
`docs/requirements/keryx-skills-runtime-tools/prd.md` and `brainstorm.md`.

## Expected Outcome

Ship R1 + R2 from the docpack — the PRD's own stated recommendation for
first increment:

- `skills_catalog` and `skill_load` registered as `MetaprojectOperation`
  descriptors in `src/harness/tool/metaproject-operations.ts`, per
  `specification.md` §3 (data contracts) and §4.1-4.3 (integration points).
- `MetaprojectOperation["module"]` widened to include `"gdskills"`.
- `MetaprojectPort` extended with `skillsCatalog`/`loadSkill` methods and a
  reference-adapter implementation reading the project's own
  `.metaproject/skills/gdskills/**/SKILL.md` tree.
- Both operations reach all three existing projections (interactive agent
  tool set, harness `ToolRegistry`, MCP `ToolEntry[]`) without bespoke
  per-projection wiring, per specification.md §4.3.
- Matches specification.md acceptance criteria AC1-AC4 and AC6 exactly
  (AC5 is R4-specific, out of scope here — see below).

## Out of Scope

- **R3 (verification signal)** — `docs/requirements/keryx-skills-runtime-tools/decisions.md`
  D-03 explicitly defers this to a follow-up package; not implemented here.
- **R4 (Claude Code native `.claude/skills/` materialization)** — the PRD's
  own recommendation states this ships as "a fast-follow once R1/R2 are
  stable," not in the same increment. Specification.md AC5 (materialized
  frontmatter validity) is therefore N/A for this flow.
- **D-04 (slash-command exposure for non-Claude-Code assistants)** — deferred
  per decisions.md, not part of this docpack's R1/R2 scope at all.
- Any change to `CLAUDE.md`/`AGENTS.md`/`.metaproject/index.md` prose
  routing — decisions.md D-05: additive only, prose stays as the fallback.
- `entity-skill-learner`/`entity-skill-verifier` (`keryx skills learn`,
  `keryx skills create`) — already shipped, unrelated (README non-goals).
- Any change to `src/gdskills/install.ts`/`sync.ts`, `src/gdskills/catalog.ts`,
  or any bundled `SKILL.md` content.
