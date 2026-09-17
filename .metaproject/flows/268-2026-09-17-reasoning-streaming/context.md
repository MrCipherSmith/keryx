# Context

Collected deterministically by `keryx flow init` at 2026-09-17T08:38:22.619Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.629] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.543] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
3. [1.496] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.496] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
5. [1.475] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-09-16T07:03:15.606Z)
- refresh: `keryx health run`

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

### Code map (collected 2026-09-17, HEAD f4cd8bd8)

Source analysis with provider table and line refs: `docs/analysis/minimax-shell-hang/2026-09-17/report.md`.

- Custom provider config: `src/lib/provider-config.ts` `CustomCompatProvider` (15-34), guard `isCustomCompatProvider` (57-68), loader (74-89) → `src/commands/providers.ts` `OpenAiCompatProvider` (30-83, pattern: `streamUsage?` at 61), `customCompatProviders()` (268-285) → `src/harness/provider/make-provider.ts` grant build (132-155), engine (161) → `OpenAiCompatCapabilityGrant` (`compat/openai-compat-provider.ts:58-99`), read in `stream()` at 334.
- `NormalizedRequestOptions.reasoning` (`types.ts:149-153`) is set nowhere and read by no adapter; no user control exists.
- Session: `src/session/store.ts` `TranscriptLine` (74-84), `writeJsonl(file, history, ts)` stamps ONE ts for all rows (273-288), called by `persistHistory()` (584-609, ts at 589); `readJsonl()` rebuilds messages field by field (375-388) — new fields must be added there. Compaction `src/session/compact.ts:61-136` keeps suffix messages unchanged.
- Request builders: Anthropic `toAnthropicMessages()` (129-164), max_tokens set at 321, no `thinking`; OpenAI `toResponsesInput()` (124-164), payload 379-395; Gemini `toGeminiContents()` (166-215), generationConfig 466-469, no `thoughtSignature` anywhere; compat inline in `stream()` 371-433.
- Body read: compat `:488`, openai `:446` (`await response.text()`). Test fakes return real `new Response(text)`, so `body.getReader()` works with existing fixtures.
- wiki enrich: write `src/wiki/enrich.ts:873`, validation `validateEnrichedMarkdown()` 572-615 (no `<think>` check); status `src/wiki/service.ts:65`.
- Suggestion: `src/tui/tui-shell.ts` `suggestNextStep` 5264-5285 uses `sel` (2399) instead of mutable `currentSel` (2408); no signal. `src/tui/shell-chrome.ts` Enter on empty composer submits hint (1022-1037); Tab/Right accepts into composer (1126-1145).
- Agent loop: `src/commands/agent.ts` `AgentIO` (~87, `onReasoning` 107); `runAgentTurnCore` (1266) reasoning accumulate/flush 1478-1544; `finishWithBudgetSummary` (2075) 2130-2160. Other AgentIO impls: `tui-shell.ts:614, 674, 2913` (busy phase), `tui/foreground-operation.ts:218`, `commands/shell.ts:1081`, `harness/tool/builtin/spawn-subagent-tool.ts:858`, `wiki/deep-enrich.ts:342`.
- Tests: `bun test src/harness/provider/` (streaming), `bun test src/tui/ src/commands/shell` (terminal), `bun run check` full gate.

### External protocol facts

- MiniMax OpenAI API: default `<think>` inside `content`; `reasoning_split: true` → `reasoning_content`/`reasoning_details`; with tool calls the full `content` (with `<think>`) and `reasoning_details` must be kept in history. `max_completion_tokens` recommended. https://platform.minimax.io/docs/api-reference/text-openai-api
- DeepSeek thinking mode: with `tools`, `reasoning_content` of previous assistant turns must be passed back, else HTTP 400. https://api-docs.deepseek.com/guides/thinking_mode/
- Gemini 3: `thoughtSignature` on `functionCall` parts must be returned unchanged, else HTTP 400; emitted even when `includeThoughts` is false. https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
- Anthropic: `thinking` request param; `thinking`/`redacted_thinking` blocks with `signature` must be returned unchanged within a tool loop.
- OpenAI Responses: `reasoning: { effort, summary }`; stateless continuation via `include: ["reasoning.encrypted_content"]` and replaying reasoning items.
