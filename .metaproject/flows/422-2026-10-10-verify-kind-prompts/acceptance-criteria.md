# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The acceptance-criteria template states the marker rule and scaffolds a placeholder carrying a marker; the placeholder detector in `src/flow/service.ts` still finds that placeholder, and the placeholder marker does not parse as a valid kind; a template test covers all three. [verify: exec `bun test src/flow/templates.test.ts`]
- AC2: The criteria-writing step of the flow skill (text in `src/flow/templates.ts` and `.metaproject/skills/flow/SKILL.md`) and `flow-orchestrator/SKILL.md` (bundled and `.metaproject` copy) require a marker on every criterion and one operator question when the kind is unclear; a test pins the phrases and the skill length ceilings still pass. [verify: exec `bun test src/gdskills`]
- AC3: `keryx flow freeze` on a flow with two criteria lacking a marker prints a warning naming both; non-interactively the warning is appended to the flow's `journal.md`; the freeze succeeds in both modes. [verify: exec `bun test src/commands/flow`]
- AC4: The verification kind still gates nothing. [verify: invariant `bun test src/flow/ac-kinds-never-gates.test.ts`]
- AC5: A flow created through intake and through `goal` gets the template with the marker; a test covers each path. [verify: exec `bun test src/commands/intake src/commands/goal`]
- AC6: `sync-status.md` shows the share of `unclassified` among criteria of flows frozen in the last 7 days and a warning above 20%; a test on a fixture with an untagged week shows the warning. [verify: exec `bun test src/commands/research-sync`]
- AC7: No file of an existing flow (ids up to 421) is changed by this flow. [verify: invariant `git diff --stat origin/main -- .metaproject/flows ':!.metaproject/flows/422-*'`]
- AC8: The next three flows created after merge carry a kind on every criterion or a warning in their journal; the operator checks a week after merge. [verify: judged]
