# Implementation Plan

Status: frozen

## Approach

Keep `compile.ts` pure/synchronous: add a `CompileTargetOptions` param
(`claudeSubagentAliases?: boolean`) threaded through
`compileAgentDefinition`/`renderHostExport`/`renderClaudeExport`, defaulting
to aliases-on. The one caller with filesystem access and a `projectRoot`
(`export.ts`'s `planAgentExport`) reads the opt-out from
`.metaproject/tasks.config.json` and passes the resolved flag in — no fs
access enters `compile.ts` itself.

## Steps

1. `src/agents/compile.ts`: add `CLAUDE_MODEL_ALIAS` (deep→opus,
   standard→sonnet, light→haiku), a `CompileTargetOptions` type, and thread
   it through `compileAgentDefinition`/`renderHostExport`/
   `renderClaudeExport`. Update the module header comment and the
   `renderClaudeExport` comment (AC7 still holds for keryx-shell; claude's
   mapping is a static host-documented enum, not a guess at a concrete id).
2. `src/agents/export.ts`: add a config reader for
   `modelGuidance.claudeSubagentAliases` (mirrors `model-choice.ts`'s
   `readModelGuidanceConfig` shape/contract) and pass it into
   `compileAgentDefinition` from `planAgentExport`'s native/adapter branch.
3. `src/agents/compile.model-tier.test.ts`: narrow the claude-target guard —
   allow exactly the frontmatter line `model: opus|sonnet|haiku|inherit`,
   keep forbidding concrete/versioned ids and bare tier words anywhere else
   (including inside `task`/header text). Add coverage for the opt-out and
   for the tier→alias mapping itself.
4. Fix the now-stale assumption in `src/agents/export.test.ts`'s
   "every bundled agent x every host runtime" test (its `model` regex
   currently forbids `opus`/`sonnet`/`haiku` for every runtime including
   claude) — same narrowing, scoped to that test.
5. Update `.metaproject/rules/core/model-selection.mdc` and
   `src/gdskills/bundled/rules/core/model-selection.mdc` identically: add a
   short note distinguishing this static claude-export alias mapping from
   the dispatch-time tier resolution the rest of the rule documents.
6. Update `docs/docs/guides/agent-catalog.md`'s "Model tier, not model name"
   section: Claude Code now gets the mapped alias, not always `inherit`,
   plus the opt-out.
7. Run typecheck/lint/tests, `keryx flow check`, confirm ACs.

## Risks

- Breaking `export.test.ts`'s blanket "no size word in `model`" sweep for
  every runtime — mitigated by narrowing that one test's regex the same way
  as the compile guard, not by loosening it for non-claude runtimes.
- `readModelGuidanceConfig`'s existing `modelGuidance.enabled` contract
  (flow 336) must stay untouched — the new key is read independently, never
  gated by `enabled`.
