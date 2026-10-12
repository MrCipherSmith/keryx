# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx product index && keryx product map --format html > a.html && keryx product map --format html > b.html && cmp a.html b.html` succeeds on this repo with no error: the board builds from the product index, and a second build on an unchanged tree is byte-identical (no clock, no random order). [verify: exec `bun test src/product/board.test.ts`]
- AC2: the board shows at least one fact that is in neither the governance report nor the flow activity summary: an unverified claim or a contradiction; the judge records which one in the journal (this is AC6 of the product module). [verify: judged]
- AC3: with the index stale (a flow journal changed after `keryx product index`) or missing, `keryx product map` exits non-zero and names `keryx product index`, and the HTML board carries a visible stale-index banner; it never renders the old data silently. [verify: exec `bun test src/product/board-stale.test.ts`]
- AC4: the board gates nothing: a test asserts `product map` writes no file outside its output, changes no flow status, and exits non-zero only for a missing or stale index; nothing in `src/` reads the board result to block, refuse or gate anything. [verify: invariant `bun test src/product/board-invariants.test.ts`]
- AC5: a person who did not write the flow reads the board and names one thing the product claims and has not proven; recorded in the journal as a readability judgement. [verify: none — a judgement about readability, recorded in the journal]
- AC6: unit tests cover the counters and columns: every intent is in exactly one column; accepted unverifiable + never checked equals `neverChecked` from `keryx product open`; the last-10 split, a docpack (`flowStatus: null`), an unreadable outcome-observed line, an unclassified AC and an empty index each have a test. [verify: exec `bun test src/product/board-model.test.ts`]
- AC7: `src/product/bulk-budget.test.ts` is updated deliberately to allow exactly three product commands (`index`, `open`, `map`), zero skills, and still rejects `admit`, `show` and `list`; `map` is registered in the command descriptors, help and usage. [verify: exec `bun test src/product/bulk-budget.test.ts`]
- AC8: `keryx dashboard build` includes the board in `.metaproject/keryx-dashboard.html` (it contains the four column titles and the counters) and `dashboard open` opens it; the data comes only from the product index. [verify: exec `bun test src/product/board-dashboard.test.ts`]
- AC9: TUI: the `/product` surface (`src/tui/product-open-surface.ts`) shows the board view with columns, counters, contradictions and the stale banner, scrolls, and is reachable from the sidebar, the composer menu and the slash command; the readline shell prints the same board as text. [verify: exec `bun test src/tui/product-open-surface.test.ts`]
- AC10: README, cli-reference, the wiki page for the product module, `commands-by-task` and CHANGELOG describe `product map` and the board; `keryx product` help and the docs site know the command; the docs build passes. [verify: exec `bun test src/standard/help-groups.test.ts`]
- AC11: the version is bumped past 0.3.46 in `package.json` and CHANGELOG, the release tag and GitHub release exist, and the version is on npm. [verify: exec `npm view @mrciphersmith/keryx version`]
- AC12: after `bun add -g @mrciphersmith/keryx@X` from npm (never from the release tarball), a smoke in a scratch project runs `keryx product map` and `keryx dashboard build`, and the TUI `/product` board view opens; no external agent is run and the keryx repo tree gains no generated files. [verify: none — a live smoke of the installed release, recorded in the journal]
- AC13: CI is green and no test starts an external agent: tests use fakes only. [verify: invariant `bun test src/product`]
