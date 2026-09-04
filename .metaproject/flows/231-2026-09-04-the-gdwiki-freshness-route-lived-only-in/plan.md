# Implementation Plan

Status: ready

## Approach

Move the text, do not rewrite it. The section is copied verbatim from the
committed `.metaproject/skills/gdwiki/SKILL.md` into `renderGdwikiSkillReadme()`
at the position it already occupies (immediately after the `# gdwiki Skill`
heading), with backticks escaped for the template literal. Then the workspace is
regenerated so the committed artifact and the generator agree; the only content
change to the file is the removal of one duplicate blank line the hand edit left.

The regression guard is two tests rather than a repository-wide sync check: a
global "every generated file matches its render" guard would fail today on
`skills/catalog.md` and `modules/gdskills.md`, whose committed copies are simply
older than the generator. That drift is worth its own flow; conflating it with a
data-loss bug would make this change unmergeable.

## Steps

1. Insert the section into `renderGdwikiSkillReadme()` (`src/wiki/templates.ts`).
2. Add `src/wiki/skill-template.test.ts`: content test + committed-equals-render test.
3. Confirm the test fails before regeneration (it did: the stray blank line).
4. `bun ./src/cli.ts update --skip-runtime`, keep only `skills/gdwiki/SKILL.md`,
   revert the unrelated regeneration noise (dashboard, manifest timestamp,
   catalog/gdskills drift).
5. `bun run typecheck`; `bun test src/wiki src/commands/update.test.ts src/commands/init.test.ts`.

## Risks

- The committed-equals-render test also fires when someone edits the generator and
  forgets to regenerate. That is intended, and the test message names the fix.
- `init.ts` renders the same function, so new installs pick the section up with no
  further wiring; verified by reading the call site rather than by installing.
