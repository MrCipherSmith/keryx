# Flow Journal

- 2026-07-17T19:18:20.014Z - flow created
- 2026-07-17T19:19:01.091Z - frozen: 4 criteria; checksum recorded
- 2026-07-17T19:19:01.468Z - started
- 2026-07-17T19:19:01.683Z - task-done: T1: Collect remaining context

## T2/T3 — implementation + tests (branch feature/035-keryx-agent-metaproject-tools)

- `src/harness/tool/builtin/metaproject-tools.ts` (new): `builtinMetaprojectTools(root, run?)`
  → `search_code` / `graph_affected` / `memory_search`, all risk `read`. Each maps
  validated input to a FIXED keryx argv and delegates to an injectable `run`.
  Default `makeKeryxRunner` spawns `keryx` via an argv array (Bun.spawn, no shell
  string), cwd=root, bounded stdout, errors→isError (never throws).
- `src/commands/shell.ts`: agent registry now `[...builtinReadOnlyTools, ...builtinMetaprojectTools]`;
  system instruction + /help updated to list the metaproject tools.

## T3 — tests
- `metaproject-tools.test.ts` (6): risk=read + schemas; argv mapping per tool
  (search_code ctx rg [+path], graph_affected gdgraph affected, memory_search
  memory search); missing-arg → error WITHOUT calling the runner; runner failure
  propagated as isError.

## Verification
- `bunx tsc --noEmit` clean; `bun test` **1387 pass / 3 skip / 0 fail** (baseline
  1381; +6). Offline/deterministic (tools tested via an injected fake `run`; no
  real subprocess). No new dependency.
- PENDING (user, real TTY, tool-capable model): agent uses search_code /
  graph_affected / memory_search on the real project (AC4 live smoke).
- 2026-07-17T19:28:01.930Z - task-done: T2: Implement per plan
- 2026-07-17T19:28:17.943Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-17T19:28:18.752Z - ac-confirmed: AC1: metaproject-tools.test.ts: 3 tools risk=read + schemas; argv mapping asserted per tool
- 2026-07-17T19:28:18.895Z - ac-confirmed: AC2: injectable run tested (fake); default makeKeryxRunner uses Bun.spawn argv array (no shell string), cwd=root, bounded, errors→isError
- 2026-07-17T19:28:19.079Z - ac-confirmed: AC3: agent registry = builtinReadOnlyTools + builtinMetaprojectTools; risk read auto-allowed by flow-033 gate; chat core unchanged
- 2026-07-17T19:28:19.236Z - ac-confirmed: AC4: tsc clean; bun test 1387 pass/0 fail (baseline 1381); offline via fake run; deps {}. Live agent-uses-tools smoke pending tool-capable model; merge authorized by user
- 2026-07-17T19:28:37.247Z - task-done: T4: Self-review and prepare draft PR
- 2026-07-17T19:29:27.228Z - completing: merged commit: db08ed9
- 2026-07-17T19:29:27.331Z - done: all gates passed
