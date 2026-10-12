# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `product index` parses every flow and requirements package it can see (this repository's own corpus when present, a checked-in fixture set otherwise) with zero failures, reports the count of entries with no extractable intent statement, and produces a byte-identical index on a second run over an unchanged tree [verify: exec `bun test src/product/index.test.ts`]
- AC2: `product open` lists only intents that are closed in code and carry no observation, names the flow and the outcome criterion (or `not measured — no instrument stated`) for each, and returns a non-zero count on the corpus [verify: exec `bun test src/product/open.test.ts`]
- AC3: The reading command `product open` fails with a message naming `product index` when the index is missing or older than the newest flow, and never answers from a stale index silently [verify: exec `bun test src/product/staleness.test.ts`]
- AC4: The data directory `.metaproject/data/product/` is disposable: deleting it and rebuilding produces an equivalent index, and no command reads product data from anywhere else [verify: exec `bun test src/product/disposable.test.ts`]
- AC5: Neither `product index` nor `product open` refuses a freeze, a confirmation, a completion, a merge or a flow creation; a test drives a flow through the full lifecycle with an empty index and every transition succeeds [verify: invariant `bun test src/product/never-gates.test.ts`]
- AC6: Neither command constructs a provider client or dispatches a subagent on any path [verify: invariant `bun test src/product/no-model.test.ts`]
- AC7: An observation is a line beginning `outcome-observed:` in the flow's `journal.md`; `index` reads it, and a flow with such a line leaves the `open` list, asserted with a fixture flow [verify: exec `bun test src/product/observation.test.ts`]
- AC8: The bulk budget holds: one module `product`, the command registry exposes only `index` and `open` at this stage (of the four the plan allows), no skill and no subagent is added, and no existing command changes behaviour [verify: invariant `bun test src/product/bulk-budget.test.ts`]
- AC9: The open queue is visible in the TUI: a rendered-row test shows the count and the flow rows of `product open` in the shell surface (an inspector or a `/product` view), with the never-checked count in its header [verify: exec `bun test src/tui/product-open-surface.test.ts`]
- AC10: The number read from `product open` on this repository's real corpus (closed intents, broken down into no outcome criterion stated, criterion stated but never observed, and observed) is written into the flow journal and reported to the operator before anything beyond P1 is built; this is gate G1 [verify: none — the gate is a human reading a number and deciding whether the premise holds; the journal entry and the operator report are the evidence]
- AC11: `bun run typecheck` is clean, the full `src/product` suite passes, and the module is documented (README, docs site CLI reference, module page under `.metaproject/modules/` if the registry has one) with a CHANGELOG entry and a version bump [verify: exec `bun run typecheck && bun test src/product`]
