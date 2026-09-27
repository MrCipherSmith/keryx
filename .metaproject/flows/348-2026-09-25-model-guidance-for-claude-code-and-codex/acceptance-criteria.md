# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The generator that maintains the `<!-- keryx:index -->` managed block in root AGENTS.md/CLAUDE.md (`ensureMetaprojectReference` / `syncAgentRules`, reached from `keryx init`, `keryx update`, and `keryx rules sync`) renders a "Model choice" policy stating, in tier words only (never a hard-coded model id), that the flagship tier is for planning and review, one tier down is for subagents/docs/unattended work, and the smallest tier is only for trivial work — verified by a hermetic unit test asserting the rendered block contains this policy.
- AC2: When the project's `routing.config.json` carries an operator-APPROVED (`keryx routing trust`) `kind: "model"` or `kind: "provider-default"` assignment for a routing category this policy addresses (planning, review, subagents, docs, unattended, quick), the rendered Model choice text includes that category's concrete provider/model id (or provider default); when a category is unset, its config is unapproved/untrusted, or `routing.config.json` is absent/unreadable, only tier words appear for it — never a fabricated or hard-coded id — verified by hermetic tests covering both the resolved and unresolved branches.
- AC3: `.metaproject/tasks.config.json` containing `{"modelGuidance":{"enabled":false}}` removes the Model choice policy from the managed block entirely, leaving every other managed-block line unchanged; the key's absence (or `enabled:true`) keeps it on — verified by hermetic tests for both states.
- AC4: `keryx rules sync` and `keryx update` each print one status line after regenerating the managed block reporting whether model guidance is enabled and how many of the addressed categories resolved to a concrete id for this project — verified by a test asserting the command's stdout.
- AC5: `src/gdskills/bundled/rules/core/model-selection.mdc` and its existing guard test (`src/gdskills/model-tier.test.ts` / `concreteModelDeclarations`) are unmodified by this work and continue to forbid a concrete model id in that rule's static text.
- AC6: The existing Claude Code subagent export (`src/agents/compile.ts` -> `.claude/agents/<name>.md`) continues to declare `model: inherit` for every `model_tier`, per the pre-existing AC7 guarantee (flow 310) that no compiled export names a concrete model; `src/agents/compile.model-tier.test.ts` passes unmodified. (This flow does not map `model_tier` to a literal `opus`/`sonnet`/`haiku` alias in that file's frontmatter, because doing so would break that existing, deliberately-tested guarantee — recorded here as an explicit, reasoned deviation from the literal spec wording, not an oversight.)
- AC7: Nothing this flow adds writes to any path outside the project (`projectRoot`/`metaprojectRoot`) — in particular, no code path constructs or writes `~/.codex/config.toml` or any other file outside the repository; Codex guidance is delivered solely through the managed `AGENTS.md` block Codex CLI already reads — verified by a hermetic test and by code inspection.
- AC8: `bun test` for every touched/added test file, `bun run typecheck`, and `bun run lint` all pass on this branch.
- AC9: `docs/` (the CLI reference / rules or metaproject page covering the managed block) documents the Model choice section and the `modelGuidance.enabled` opt-out key.
- AC10: Running the generator end-to-end on a scratch copy of this repository (never the real `~/keryx` root CLAUDE.md) produces a root CLAUDE.md whose managed block contains the Model choice policy, demonstrated in the flow's evidence log.
