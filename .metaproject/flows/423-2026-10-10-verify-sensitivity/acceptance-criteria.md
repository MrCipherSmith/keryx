# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The parser accepts a sensitivity note (`revert`, `mutation`, `failure-scenario`) on `exec`/`invariant` markers and rejects it on `judged`/`none` with a parser error; every existing marker form parses exactly as before. [verify: exec `bun test src/flow/ac-kinds.test.ts`]
- AC2: `keryx flow ac kinds` (text and `--json`) shows the number of `exec`/`invariant` criteria with and without a sensitivity note. [verify: exec `bun test src/flow/ac-kinds.test.ts src/commands/flow`]
- AC3: `keryx flow ac confirm` on a criterion with a sensitivity note and no evidence in `--note` prints a warning and still confirms; with evidence, or on a criterion without the note, it prints no warning. [verify: exec `bun test src/commands/flow`]
- AC4: Neither the kind nor the sensitivity note blocks freeze, confirm or completion. [verify: invariant `bun test src/flow/ac-kinds-never-gates.test.ts`]
- AC5: The flow-init criteria step and both flow-orchestrator copies require a separate failure-scenario criterion with an observable result for behaviour with an external dependency or failure path, and say how a regression-catching claim is proven; the copies stay identical and the length ceilings pass. [verify: exec `bun test src/gdskills src/flow/templates.test.ts`]
- AC6: `sync-status.md` shows the share of `exec`/`invariant` criteria with a sensitivity note among criteria of flows frozen in the last 7 days, with no threshold warning. [verify: exec `bun test src/commands/research-sync`]
- AC7: No file of an existing flow (ids up to 422) is changed by this flow. [verify: invariant `git diff --stat origin/feat/verify-kind-prompts -- .metaproject/flows ':!.metaproject/flows/423-*'`]
