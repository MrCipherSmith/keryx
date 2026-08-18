# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With `.metaproject/wiki.config.json` absent, or present with `rlm.enabled: false`, a
  `wiki enrich` run produces byte-for-byte identical output to the pre-flow `wikiEnrich`
  behavior (regression test passes; PRD NFR-4 / Gherkin "RLM mode disabled preserves current
  behavior").
- AC2: A page whose module is below the configured skip threshold gets no LLM call, and its
  final content equals the `collect.ts`-generated template unchanged (PRD Gherkin "Trivial
  page skips the LLM entirely").
- AC3: A page classified `deep` is enriched via a bounded child turn (`spawnSubagent` +
  `runAgentTurn`) whose tool grant is exactly the filtered read-only
  `METAPROJECT_OPERATIONS` subset (`graph_query`, `graph_path`, `graph_symbol`,
  `graph_affected`, `repomap`, `read_wiki`) — an automated test asserts the child's tool
  array contains no `shell_exec`-equivalent and no `spawn_subagent`-equivalent capability
  (PRD Gherkin "Complex page gets a deep, tool-enabled pass" + FR-6 flat recursion).
- AC4: Re-running `wiki enrich` on a page successfully enriched in a prior run, whose
  underlying graph nodes are unchanged since that run, makes no LLM call and preserves the
  existing enriched content (PRD Gherkin "Unchanged page is skipped on re-run"; verified via
  `enrich-resume.json`'s `completedNodeHashes`, not `gdgraph/staleness.ts` alone).
- AC5: A `deep`-classified page whose child subagent exhausts its configured
  token/tool-call budget does not fail the overall `wiki enrich` run — the run completes and
  that page falls back to its deterministic template or the child's best partial output
  (PRD Gherkin "Deep subagent exceeds its budget").
- AC6: Sibling `light`-classified pages of the same module are batched into a single
  `single-turn.ts` call when their combined size fits the existing `repomap.ts` token
  budget, and split (not silently truncated) on overflow (FR-5, Edge Cases "Batch overflow").
- AC7: `deep`-path tool calls are auditable per page (FR-9) — recorded as an ordered
  per-call log (`DeepEnrichToolCall[]`: name, input, isError) returned alongside the
  enrichment result. (Grounding correction, T6: `runAgentTurn`'s `InteractiveTool` path
  in `commands/agent.ts` does not route through `ToolRegistry`/`replay`, so
  `ToolDefinition.replay` records nothing for it — confirmed by reading
  `runAgentTurnCore`; an explicit `AgentIO.onToolCall`/`onToolResult`-sourced log was
  added instead, satisfying the same "auditable per page" intent.)
- AC8: `keryx typecheck`/lint and the full `bun test` suite pass with the new/changed files
  included, with no regressions in existing `src/wiki/*` or `src/harness/*` tests.
