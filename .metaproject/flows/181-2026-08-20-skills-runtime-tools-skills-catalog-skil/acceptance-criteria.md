# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `MetaprojectOperation["module"]` (`src/harness/tool/metaproject-operations.ts`) includes `"gdskills"` as a valid variant, and every existing operation's own module tag still type-checks unchanged.
- AC2: `skills_catalog` operation returns every skill discoverable under `.metaproject/skills/gdskills/**/SKILL.md` in the calling project, with `name`, `path`, `category`, `description`, and (when present in frontmatter) `triggers` — matching `docs/requirements/keryx-skills-runtime-tools/schemas/skills-catalog-result.schema.json`.
- AC3: `skill_load` given a valid skill name/path returns that skill's `SKILL.md` body byte-identical to a direct `Read` of the same file — matching `schemas/skill-load-result.schema.json`; given an unknown name/path it returns `found: false` with empty `content`/`path`, never an error/throw.
- AC4: Both operations are registered with `risk: "read"` and reach all three existing projections — interactive agent tool set (`toInteractiveTools`), harness `ToolRegistry` (`toToolDefinitions`), and MCP `ToolEntry[]` (`toMcpTools`) — with no bespoke per-projection wiring beyond the descriptor registration itself (the existing `metaproject-tools.ts` fallback case already makes any registered operation MCP-callable).
- AC5: `MetaprojectPort`'s new `skillsCatalog`/`loadSkill` methods and the reference adapter implementation read only the calling project's own `.metaproject/skills/` tree (no network, no shell, no write) — matching the trust boundary of every other adapter method.
- AC6: No behavior change to any of the 13 existing `MetaprojectOperation` entries, `src/commands/shell.ts`, `.claude/skills/`, `CLAUDE.md`/`index.md` prose routing, or `src/gdskills/{install,sync,catalog}.ts` — this flow is additive only.
- AC7: Automated tests cover: `skills_catalog` returning the full discovered set, `skill_load` success (content matches direct file read) and not-found paths, the module-union type change, and MCP-projection reachability (a call through `toMcpTools`'s dispatch path succeeds for both new operations). `bun test` passes.
- AC8: `keryx health run` gate passes (lint, type-check, tests) before flow completion.
