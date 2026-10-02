# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Within one family and vendor a newer version outranks an older one in `src/gdskills/model-tier.ts` tier resolution: a session on `claude-sonnet-5` resolves `deep` to a discovered `claude-sonnet-5-5`/`claude-sonnet-5.5` when present, and a session on the older one never resolves `light` or `deep` to a newer sibling of its own family in the wrong direction. A unit test drives `resolveTierModel` for sonnet 5 vs 5.5 and opus 4.8 vs 5.5, and both directions are asserted.
- AC2: A session on `claude-sonnet-5` with `claude-opus-4-8` and `claude-haiku-4-5` discovered never resolves `deep` to a model that is older-generation than the session model when that model is also the more expensive one by the profile price; a test pins the case and the recorded `tier_resolution`/`tier_reasons` say why the session model was kept.
- AC3: `light` resolves to the next size step below the session model, not the smallest class: an Opus session with sonnet and haiku discovered resolves `light` to sonnet, and haiku is taken only when nothing sits between (or the signals ask for the smallest class). A test pins both.
- AC4: When the deterministic ranking refuses or a cross-family comparison is ambiguous, an agent fallback ranks the discovered candidates. The agent sees only the discovered ids plus profile prices, must answer JSON, and any id outside the discovered set is dropped. A test with an injected fake agent asserts the drop and that an agent failure, timeout or malformed answer yields the session model exactly as today.
- AC5: The agent fallback never places a tier below the session model for `standard` or `deep`, is cached by a hash of the candidate catalogue so an identical catalogue asks once, and runs on the lighter tier of the session's own provider. Tests cover the never-below rule, a cache hit making zero agent calls, and the tier the agent is dispatched on.
- AC6: A dispatch resolved through the agent carries `tier_resolution: agent-ranked` in the record, and `subagent-dispatch.schema.json`, its TypeScript type and the docs list the new value. `keryx review tier` prints it and a schema test accepts it.
- AC7: The Claude Code subagent export (`src/agents/compile.ts`) keeps its fixed alias vocabulary and is not changed by the agent fallback; a test asserts `deep`/`standard`/`light` still map to `opus`/`sonnet`/`haiku` and `model: inherit` is still available.
- AC8: The curated Anthropic lineup and its profile seed include Opus 5.5 and Sonnet 5.5 or the current ids reported by the provider, with `assertCuratedCoverage` still passing and no concrete model id added to any rule, skill or dispatch template (the guard in `model-tier.test.ts` passes).
- AC9: The model choice is visible in the TUI: the model selection / routing view or the run trace row shows the resolved tier, whether it was `discovered`, `session-ranked`, `session-fallback` or `agent-ranked`, and the ranking reason. A TUI test or rendered-row assertion covers the `agent-ranked` row.
- AC10: `rules/core/model-selection.mdc` and its bundled copy in `src/gdskills/bundled/rules/core/` describe generation-aware ranking, the step-down `light`, the agent fallback and its limits, including the explicit statement that it compares candidate models and never rates a task's own difficulty; README and the docs site are updated together with the code, and CHANGELOG plus version 0.3.27 are bumped.
