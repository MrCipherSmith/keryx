# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `renderGdwikiSkillReadme()` emits the "Before you trust a page: check whether it is current" section, with both call surfaces (`wiki_freshness`, `keryx wiki freshness`), the direct file (`.metaproject/data/wiki/freshness/latest.json`), all three categories (`stale-reference`, `stale-prose`, `unknown`), the empty-findings-with-limitations warning, and the human-owned repair commands.
- AC2: The committed `.metaproject/skills/gdwiki/SKILL.md` equals `renderGdwikiSkillReadme()` exactly, so a `keryx update` on a clean tree produces no diff.
- AC3: A test asserts AC1 against the render, and a second test asserts AC2 by comparing the committed file to the render; both fail if either half drifts.
- AC4: The section's wording is #460's, unchanged apart from the stray duplicate blank line the hand edit left before "Use this skill for project knowledge".
- AC5: No other generated file is modified by this change.
- AC6: `bun run typecheck` passes and `bun test src/wiki src/commands/update.test.ts src/commands/init.test.ts` passes.
