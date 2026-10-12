# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `flow init --origin human-request --quote "<text>" --source "<ref>"` writes origin {kind, quote, source} into flow.json with the quote stored byte for byte (Cyrillic, quotes and newlines intact, no translation or paraphrase). [verify: exec `bun test src/flow/origin-init.test.ts`]
- AC2: Without a quote or without a source `human-request` is not set: the origin stays `unknown`, the command still succeeds and prints why. [verify: exec `bun test src/flow/origin-evidence.test.ts`]
- AC3: `agent-finding` and `agent-proposal` are accepted (with a source) and are shown by `flow status` and by `product open`. [verify: exec `bun test src/flow/origin-status.test.ts src/product/origin-open.test.ts`]
- AC4: The description template's Outcome criteria section holds three lines: the verbatim request, the agent's formalization and "how to observe" (marked as the agent's proposal); for agent-finding and agent-proposal a "Source" line replaces the request line. [verify: exec `bun test src/flow/origin-template.test.ts`]
- AC5: `outcomeAuthor` is derived from the origin when not set, an explicit setting is never overwritten, and `keryx flow origin set <id> <kind> --reason` changes the origin and writes a journal line with the reason. [verify: exec `bun test src/flow/origin-outcome-author.test.ts`]
- AC6: G1a in product is computed by origin x (real criterion | not measured); flows without an origin count as `unknown`. [verify: exec `bun test src/product/origin-g1a.test.ts`]
- AC7: No path refuses because of the origin: `flow init`, `freeze`, `complete` and the product commands succeed on a flow with no origin, an `unknown` one and an invalid kind (the invalid kind is reported, not fatal), and a flow without origin shows "origin: unknown". [verify: invariant `bun test src/flow/origin-never-gates.test.ts`]
- AC8: TUI: the flow inspector and `product open` show the origin kind, quote and source; the shell command `/flow origin` shows the origin and sets it with a reason. [verify: exec `bun test src/tui/origin-surface.test.ts`]
- AC9: The docs describe the origin, its three kinds and the evidence rule: the flow guide and the CLI reference. [verify: exec `bun test src/flow/origin-docs.test.ts`]
- AC10: On a real flow made after release, the formalization in the effects conveys the operator's original request faithfully, in the operator's judgement. [verify: judged]
