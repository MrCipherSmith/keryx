# Context

Collected deterministically by `keryx flow init` at 2026-09-27T08:21:53.351Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.956] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.845] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
3. [1.789] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.727] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
5. [1.715] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Sites located and read in the analysis session (line numbers at `d1001a52`; shift on `0b7fc0b6`, search by the quoted string):

| Item | Site | Fact |
|---|---|---|
| 1 plan steers turn | `src/commands/agent.ts` `"The current execution plan still has actionable items remaining"` (~2666) | one-shot `planFollowThroughUsed` nudge, `role: "user"`, `provenance: "project"`, then `continue` |
| 1 prompt | `agent.ts` `"For multi-step work, use **plan_set**"` (~1487) | prompt explains `proposed` as the only non-forcing stop |
| 3 snapshot | `src/session/execution-plan.ts` `renderExecutionPlanSnapshot` (~226); appended to `systemInstruction` each round in `agent.ts` (`planSnapshot`, ~2306) | `items.slice(0, 7)` in insertion order |
| 2 budget | `agent.ts` `"Tool-call limit reached"` (~3134) | returns `{ finishReason: "tool-call-budget" }` with no wrap-up; the no-progress branch below it DOES call `finishWithBudgetSummary` |
| 2 parent output | `src/harness/tool/builtin/spawn-subagent-tool.ts` `"(subagent produced no text)"` (~1403-1449) | `status` computed but not in `output`; fleet `status: "done"`; `foldChildSlateAndCleanup("completed")` |
| 6 cwd | `spawn-subagent-tool.ts` `const cwd = deps.cwd` (~876) | no per-call cwd |
| 7 inventory | `src/review/reviewers.ts` (~236-284) | reads only `<root>/.metaproject/skills/gdskills/review`; missing dir → `[]` |
| 8 reprompt | `agent.ts` `modelClaimedAction` (~1255), `shouldReprompt` (~2521), `buildToollessReprompt`, `MAX_TOOLLESS_REPROMPTS = 2` | markers include `i`, `will`, `сейчас`; no check for earlier tool calls in the turn or answer shape |
| 4 skill gate | `src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md` "Sub-Agent Report Quality Gate" (~1336) | no mapping for empty / off-schema / BudgetExhausted |
| 5 publication | same SKILL.md `gh pr comment <n> --body-file` (~1676); checklist publish at line ~65 vs `session-plan-bridge.mdc` "after `review-orchestrator` fixes its scope and dispatch in Step 6" | no draft-approval gate; timing contradiction |
| parity | `src/gdskills/review-orchestrator-skill-parity.test.ts` | bundled and `.metaproject/skills/gdskills` copies must agree |

Tests that pin current behaviour: `src/commands/agent.test.ts` (`buildToollessReprompt`), `src/commands/agent-tool-call-budget.test.ts`, `src/session/execution-plan.test.ts`, `src/harness/tool/builtin/spawn-subagent-tool.test.ts`, `src/commands/goal-command.test.ts`, `src/review/reviewers.test.ts`.

Evidence: the independent report is at `<consumer-project scratchpad>/keryx-review-orchestration-report.md` (outside the repo; summarized in description.md).
