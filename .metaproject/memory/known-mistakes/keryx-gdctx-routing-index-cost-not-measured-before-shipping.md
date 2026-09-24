# keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping

Version: 0.1.0
Type: known-mistake
Status: accepted
Confidence: high

## Summary

A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.

## Details

The `.metaproject/index.md` hard-gate instruction (described in the project's CLAUDE.md) embeds a ~3,226-token routing index that instructs the AI to read `.metaproject/index.md` before navigation, planning, or implementation. Because the transcript replays this instruction on every subsequent turn, and every subagent dispatch includes it in the subagent prompt, the cost is re-billed:

- Current measured overhead for a single main session + 3 subagents over 25 turns: ~177,430 tokens (routing-index overhead alone)
- The problem compounds with turn count and subagent fan-out; a 10-turn subagent paying this cost each turn pays 10× the one-time cost

This is a **design defect, not a code bug** — the rule is necessary, but its implementation was shipped without measuring the re-billed cost across realistic agent fan-out.

**Measured data:**
- Full index read cost: ~3,226 tokens
- Measured overhead at 25 turns (main + 3 subagents): ~177,430 tokens total
- The transcript re-sends the hard-gate instruction on every subsequent user message, so the index cost is re-billed once per turn in the parent session, once per subagent in each dispatch, and once per turn in each subagent's own turns

**Proposed fixes:**
- Replace the full index with a ~300-token pointer table (capability → command, no prose/workflow/examples): reduces overhead to ~16,500 tokens (~11× cheaper)
- For subagent prompts specifically, inline ~300 tokens of routing pointers directly in the dispatch prompt instead of instructing "read index.md"; escalate to full index read only for navigation-heavy subagents: ~3,000 tokens per subagent over 10 turns
- Move `orient` context injection from `UserPromptSubmit` (fires every prompt) to a once-per-session hook point and have it replace rather than duplicate the index-read instruction (deferred, requires hook plumbing)

**Lesson:** Before setting a rule's default scope and billing pattern, measure the re-billed cost across realistic turn counts and subagent fan-out, especially for:
- Rules that add context to every prompt (transcript re-sends → cost multiplies by turn count)
- Rules applied to every subagent dispatch (cost multiplies by subagent count and their turn counts)
- Rules applied conditionally but fired frequently (cost per firing, not one-time)

## Provenance

- Source: flow 304 (W7 gdgraph/gdctx correctness)
- Link: docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md
- Confirmed-By: Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
- Created: 2026-09-24
- Updated: 2026-09-24

## Related Scopes

- Module: context, orchestration, keryx-cli, subagent-dispatch
- Entity: hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
- Files:
  - `src/lib/templates.test.ts` (pointer table budget enforcement, 400-token target)
  - `src/ctx/orient-runtimes.ts:11` (currently fires via UserPromptSubmit, re-billed)
  - `.metaproject/index.md` (the routing index, current 3,226 tokens)
  - `docs/requirements/keryx-context-measurement/context-loading.md` (measurement data)
- Skills:

## Tags

gdctx, context-cost, routing, measurement, transcript-overhead, subagent-dispatch, design-defect

## Changelog

- 0.1.0 - Initial version documenting GDCTX-5 design defect from W7 correctness investigation.
