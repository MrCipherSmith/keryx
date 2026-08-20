# Implementation Plan

Status: formalized

## Approach

Follow `docs/requirements/keryx-skills-runtime-tools/specification.md` §3-4
exactly — no design decisions left open at this point, since the docpack was
already adversarially reviewed (`docpack-review`, 0 blockers). Mirror the
existing `read_wiki` operation's shape end to end: descriptor in
`metaproject-operations.ts` → `MetaprojectPort` method → root-confined
filesystem read in `metaproject-adapter.ts` (`readWiki` uses
`confineToWiki(cwd, input.path)`; the new `loadSkill` needs an analogous
`confineToSkills(cwd, input.name)` guarding against path traversal —
specification.md didn't call this out explicitly, but it is the same trust
boundary `readWiki` already enforces and must not be weaker).

## Steps

1. **`MetaprojectOperation["module"]` union** (`metaproject-operations.ts:50`):
   add `"gdskills"`.
2. **`MetaprojectPort` interface** (`metaproject-port.ts`, beside
   `graphAffected`/`readWiki` at lines 294/303): add
   `skillsCatalog(input: Record<string, never>): Promise<SkillsCatalogResult>`
   and `loadSkill(input: { name: string }): Promise<SkillLoadResult>`, plus
   the two result interfaces (mirror `WikiPageResult`'s shape:
   path/content/isError/error, adapted per
   `schemas/skill-load-result.schema.json`'s `found` field instead of
   `isError`, since "not found" is an expected outcome here, not a failure —
   specification.md §3.2 is explicit that `skill_load` "never errors" on an
   unresolved name).
3. **Reference adapter** (`metaproject-adapter.ts`, beside `readWiki`):
   - `skillsCatalog`: walk `.metaproject/skills/gdskills/**/SKILL.md`,
     parse YAML frontmatter for `description`/`triggers`, derive `category`
     from the containing directory one level under `gdskills/`, fall back to
     `catalog.md`'s one-line summary only if a `SKILL.md` has no
     `description` field (specification.md §3.1). No cache (decisions.md
     D-02) — read live every call.
   - `loadSkill`: resolve `input.name` against the same walk (accept either
     a bare name or an exact relative path, per specification.md §3.2),
     confine to the `.metaproject/skills/` root the same way `confineToWiki`
     confines to `.metaproject/wiki/`, return `found: false` + empty
     content/path on no match or an escaping path — never throw.
4. **Two new descriptors** in `metaproject-operations.ts`, module
   `"gdskills"`, `risk: "read"`, mirroring `read_wiki`'s `invoke` shape
   (validate input via the existing `requireString` helper for `skill_load`;
   `skills_catalog` takes no required input). Add matching `outputSchema`
   constants (mirror `WIKI_OUTPUT_SCHEMA`'s pattern) sourced from
   `docs/requirements/keryx-skills-runtime-tools/schemas/*.json`.
5. **No changes needed** to `src/mcp/metaproject-tools.ts`'s
   `invokeStructured` — the existing `default: return op.invoke(port,
   params)` fallback (lines 66-71) already makes any registered operation
   MCP-callable; do not add a bespoke `case` unless a reviewer finds a
   concrete reason the formatted-text result is unsuitable for MCP callers
   (none is anticipated — `graph_path`/`test_related`/`health_status`/
   `graph_symbol`/`repomap`/`wiki_ask` already work this way).
6. **Tests**: extend the existing test files covering
   `metaproject-operations.ts` and `src/mcp/metaproject-tools.ts` (both
   confirmed to exist) rather than creating new ones, matching their current
   per-operation test structure.

## Risks

- **Path traversal in `loadSkill`'s `name` input.** Mitigated by mirroring
  `confineToWiki`'s exact confinement pattern rather than inventing a new
  one — see Approach above. A reviewer should explicitly verify a `../../`
  or absolute-path input is rejected, not silently resolved outside
  `.metaproject/skills/`.
- **Frontmatter parsing robustness.** Bundled `SKILL.md` files use a
  reasonably uniform YAML frontmatter block (confirmed by direct reading of
  several this session), but `skills_catalog` must not throw or drop the
  whole catalog if one file's frontmatter is malformed — degrade that one
  entry (e.g. empty `description`) rather than failing the whole call.
- **Category derivation ambiguity.** `.metaproject/skills/gdskills/` nests
  by category (`orchestration/`, `review/`, `quality/`, ...) matching
  `src/gdskills/catalog.ts`'s `BundledSkill.category` set, but also contains
  `core/` skills (`gdgraph`, `gdctx`, ...) at a different nesting depth per
  `.metaproject/index.md`'s own Skills table — verify the walk handles both
  shapes rather than assuming one fixed depth.
- **Scope discipline.** R4 (native materialization) and R3 (verification)
  are out of scope (see description.md) — do not let implementation
  "usefully" grow into either; a reviewer should flag any `.claude/skills/`
  write or flow-verification logic as scope creep.
