# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: For the `claude` compile target, `compileAgentDefinition`/`renderClaudeExport` emits `model: opus` for `model_tier: deep`, `model: sonnet` for `model_tier: standard`, and `model: haiku` for `model_tier: light`, by default (no config present).
- AC2: Every other compile target is unchanged: `keryx-shell`'s `input.model_tier` still carries the declared tier through unresolved (never a model name), and `codex`/`kiro`/`opencode` exports still carry no `model`/tier-alias mapping of their own.
- AC3: `.metaproject/tasks.config.json` with `{"modelGuidance": {"claudeSubagentAliases": false}}` makes the claude target emit `model: inherit` again, for every `model_tier` value; absent file, absent key, or a non-boolean value all keep aliasing on (mirrors `modelGuidance.enabled`'s own default-on contract from flow 336, read independently of it).
- AC4: `src/agents/compile.model-tier.test.ts` (the flow-310 guard) still fails compiled output containing a concrete or versioned model id (`claude-…`, `gpt-…`, `gemini…`) on every target including claude, and still fails a bare tier-size word (`opus`/`sonnet`/`haiku`, or any other `MODEL_RANK_HINTS` word) anywhere in compiled output EXCEPT the one exact claude frontmatter line `model: opus|sonnet|haiku|inherit`; the narrowing is explained in a comment in the test file.
- AC5: `src/agents/export.test.ts`'s every-bundled-agent-x-every-runtime test is updated so it does not regress on the new claude behavior, while continuing to forbid a concrete/versioned model id for every runtime and a bare tier word for every non-claude runtime.
- AC6: `.metaproject/rules/core/model-selection.mdc` and `src/gdskills/bundled/rules/core/model-selection.mdc` remain byte-identical to each other and both describe the claude-export alias mapping (distinguished from the dispatch-time tier resolution the rest of the rule documents), without introducing a concrete/versioned model id (the rule's own existing guard in `model-tier.test.ts` still passes).
- AC7: `docs/docs/guides/agent-catalog.md`'s "Model tier, not model name" section documents that a claude-target export's `model:` field is the mapped alias by default, names the three mappings and the opt-out, rather than unconditionally "emit `model: inherit`".
- AC8: `bun test src/agents src/gdskills` and typecheck/lint all pass; every new/changed test is hermetic (temp dirs, no reliance on real `~`/global config) and independently revert-checked (fails red against the pre-change code, passes green after).
