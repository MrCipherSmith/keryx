STATUS: DONE

# T21 Independent Recheck — Closure of T16-final-review's Four Findings (post-T20)

## Scope

- Branch: `codex/agent-first-core`
- Base / HEAD: `0bc6418fa1a038f8ec909cf949fecba077acf9a4` (all M10/T19/T20 work is uncommitted
  working-tree state on top of this commit — same base `T16-final-review.md` used).
- Reviewer: `review-logic`, independent — wrote neither T19, T20, nor any T16 artifact, and
  did not author the review this dispatch answers.
- Scope: T20's four closures (F-001..F-004 from `T16-final-review.md`), the resulting
  `TerminalStateReason` union widening, and behavior preservation everywhere else. Stage 2
  (code quality) entered only after Stage 1 passed.
- Excluded and not reviewed: `src/security/*` and `src/commands/security.ts` (two concurrent
  workers). `git status --porcelain` confiscation at review time shows these files modified/
  untracked exactly as the dispatch's exclusion note predicted; no hash drift observed in any
  file this review actually depends on (see table below).

File hashes at review time, compared against the values `T20-implementation.md` recorded after
its own change (all six files the dispatch named for reading, `git status --porcelain` scoped
to owned files):

| File | SHA-256 (observed) | Matches `T20-implementation.md`? |
|---|---|---|
| `src/commands/agent.ts` | `29cef9729333e75cdc5a6721ebdc7669db206416e9d115b8d5ed254858e0ad37` | yes |
| `src/commands/agent-tool-call-budget.test.ts` | `cf3496ec69717a71cf86af2017a1903562f0fdce555282c0142658c2535e5e96` | yes |
| `src/harness/tool/builtin/spawn-subagent-tool.ts` | `cd7d77f81b7c55db35489373bb6d9ba41f752df7b014380f188dba3ebf188de9` | yes |
| `src/session/slate-terminal-state.ts` | `bfa97eb813d0ff3735eb258d3784a105dabd41d6b6436b5317bdc2bcf6ee2650` | yes |
| `src/commands/agent.test.ts` | `11f6d11e513bcdc7b032b6669e5f89a02e467836292ec8f81fd71d4a3c721eb6` | yes (unchanged since `T16-final-review.md`) |
| `src/harness/tool/builtin/spawn-subagent-tool.test.ts` | `0b7d9a3a945cb9c802092d81bf7c1b1dea963b20e0016ef56d919cc6fa111153` | yes (unchanged since `T16-final-review.md`) |

No drift: T20's implementation is exactly the code this review evaluated. `src/security/*`
and `src/commands/security.ts` are excluded per dispatch; both showed uncommitted concurrent
edits in `git status --porcelain`, none of which touch any file this review reads.

## Summary

- blocker: 0
- major: 0
- minor: 0
- info: 0

All four `T16-final-review.md` findings are genuinely closed, verified with independent,
self-executed evidence rather than the implementer's word: a new assertion-bearing probe
(`T21-terminal-reason-probe.ts`) proves the major's fix with a hard assertion the reviewer's
own preserved `C11` case deliberately did not carry; all four `emitTerminalState` call sites
were re-enumerated directly; the `TerminalStateReason` union widening was checked against
every real consumer in `src/` (no exhaustive switch, no persisted-value comparison, and a
blind `JSON.parse` cast means an older-build value still reads correctly); the new regression
was proven to genuinely depend on the production line by copying sources into a scratch
directory, reverting only that one line, and watching the *exact, unmodified* committed test
fail there; and the deleted trailing round-ceiling guard was confirmed dead by tracing every
`return`/`continue` in the loop body, including the reset, cancel, and no-progress paths. No
new blocker, major, or minor finding was produced. Closing the four findings changed nothing
else: the fifteen preserved probe cases, the 111-test focused suite, both TypeScript targets,
and targeted ESLint are all unchanged/green.

## Stage 1 — closure verification

| Criterion | Verdict | Evidence |
|---|---|---|
| F-001 (major): unattended no-progress stop now reports a distinct, truthful reason (`no_progress`), not `budget_exhausted`, while both budgets have capacity | **MET** | Own probe `T21-terminal-reason-probe.ts`, case `T21A`: `providerRequests=4` (16/20 rounds unspent), `invocations=3` (47/50 calls unspent), `finishReason="no-progress"`, `terminalStateReasons=["no_progress"]`, hard-asserted `pass:true` — raw `.../2026-09-06T13-49-15-484Z_run.log` (`sha256 c9136d5de451ee769388cbda8b21210499056b9564ed43378eca21abc5cfb8ec`). Cross-checked against the source line itself: `agent.ts:1684` reads `await emitTerminalState(io, deps, options, "no_progress");` with an inline `T20 F-001` comment — raw `.../2026-09-06T13-44-54-376Z_run.log`. The reviewer's own preserved `C11` (re-run unchanged) corroborates: `terminalStateReasons: ["no_progress"]` — raw `.../2026-09-06T13-47-37-517Z_run.log`. |
| The other three `emitTerminalState` sites (round-budget, tool-call-budget, ask_user) still report their own distinct reasons | **MET** | Self-enumerated (not trusted from T20's count): `bun src/cli.ts ctx rg -n "emitTerminalState" src/commands/agent.ts` returns the declaration at `:954` plus exactly 4 call sites — raw `.../2026-09-06T13-44-36-318Z_rg.log` (`sha256 309dbd95f89f61eb32f287892fb91fd48bd8f542c2cf2d7bb03100ac6403fd08`): `:1235 "budget_exhausted"`, `:1517 "ask_user_unanswerable"`, `:1668 "tool_call_budget_exhausted"`, `:1684 "no_progress"`. Own probe cases `T21B`/`T21C`/`T21D` independently confirm each by execution: round-budget stop -> `budget_exhausted` (1 request), tool-call-budget stop -> `tool_call_budget_exhausted` (finishReason `tool-call-budget`), ask_user interception -> `ask_user_unanswerable` — same raw `.../2026-09-06T13-49-15-484Z_run.log`. |
| F-002 (minor): `offerRoundLimitReset`'s doc comment now matches T19's actual cancel/reset behavior | **MET** | Read `agent.ts:1712-1719` directly: the comment now states cancel/rejected-picker/unwired-picker "stops locally with no further provider request: the caller, `stopAtRoundLimit`, prints the round-limit notice and returns `"stop"`, and the round-guard that invoked it returns `finishReason: "budget"` directly (T20 F-002)" and that `finishWithBudgetSummary` is reached "only from the no-progress branch above, and only when a round remains" — raw `.../2026-09-06T13-46-05-285Z_run.log`. Verified against the code, not just read: `finishWithBudgetSummary` has exactly one call site in the whole file (`agent.ts:1689`, inside the no-progress/attended/round-remaining branch) — `bun src/cli.ts ctx rg -n "finishWithBudgetSummary" src/commands/agent.ts` raw `.../2026-09-06T13-46-03-663Z_rg.log`. `agent.test.ts`'s cancel-at-round-budget regression (1 request, no wrap-up) passes in the focused-suite run below. |
| F-003 (minor): `SubagentCompletionStatus`'s doc now names both finish reasons that map to `BudgetExhausted` | **MET** | Read `spawn-subagent-tool.ts:71-76` directly: the `"BudgetExhausted"` bullet now names both `finishReason: "budget"` (D2a) and `finishReason: "tool-call-budget"`, and points at the `MAE reservation:` line — raw `.../2026-09-06T13-46-16-450Z_run.log`. Verified against the mapping code itself: `status = finishReason === "budget" \|\| finishReason === "tool-call-budget" ? "BudgetExhausted" : ...` at `spawn-subagent-tool.ts:1192` — raw `.../2026-09-06T13-46-18-203Z_rg.log`. Preserved probe `D1` (`max_rounds:5`, `max_tool_calls:2`) still reports `status:"BudgetExhausted"` with rounds unspent — raw `.../2026-09-06T13-47-39-134Z_run.log`. |
| F-004 (minor): deleting the trailing round-ceiling guard changed no behavior — the entry guard alone catches every case | **MET, independently traced** | Not accepted on the stated reasoning: every `return`/`continue` inside `runAgentTurnCore`'s `for (;;)` body was enumerated (`bun src/cli.ts ctx rg -n "isAborted\(\)\|return \{\|continue;\|finishReason" src/commands/agent.ts`, raw `.../2026-09-06T13-45-17-784Z_rg.log`) and each was read in context. Every branch — abort/cancel (`isAborted()` -> `return {}` at 5 sites), the entry-guard reset (`continue` at 1259) and stop (`return {finishReason:"budget"}` at 1261), the toolless-reprompt reset/stop (`continue` at 1382 / `return` at 1368), the round-budget/tool-call-budget/no-progress terminal returns (1261, 1674, 1685, 1696) — either returns from the function outright or `continue`s straight back to the loop TOP (hitting the entry guard immediately, including after an interactive reset raises `roundState.maxRounds`). The ONLY path that falls off the end of the loop body to the position the trailing guard used to occupy is a successful round where `executedAny === true` (so `noProgress` is false) — i.e. exactly the case the entry guard re-catches on the very next iteration. Read directly at `agent.ts:1650-1699`: the deleted block is now a comment explaining this — raw `.../2026-09-06T13-44-54-376Z_run.log`; loop start/entry guard read at `agent.ts:1249-1262` — raw `.../2026-09-06T13-45-01-470Z_run.log`. |
| Union widening: `TerminalStateReason` in `slate-terminal-state.ts` gained `"no_progress"`; no consumer breaks | **MET** | `TerminalStateReason` (the type name) appears in exactly 3 files: its own declaration, a comment-only reference in `slate-terminal-state.test.ts` quoting the OLD union, and `agent.ts`'s import + one type annotation — `bun src/cli.ts ctx rg -n "TerminalStateReason" src` raw `.../2026-09-06T13-46-24-613Z_rg.log`. No exhaustive `switch`/lookup keyed on the reason value exists anywhere non-test in `src/` — searched all five literal reason strings (`"budget_exhausted"`, `"ask_user_unanswerable"`, `"tool_call_budget_exhausted"`, `"no_progress"`, `"other"`), only doc comments and the four `agent.ts` call sites match. Every consumer of `.reason` traced: `renderTerminalStateBlock` only string-interpolates it (`slate-terminal-state.ts:132`, `` `reason: ${state.reason}` ``); `sac/catch-up.ts`'s `readTerminalState` does a blind `JSON.parse(result.text) as TerminalState` with NO runtime schema validation (`readConfigFile` is a byte-size-bounded raw read, not a validator — raw `.../2026-09-06T13-47-02-099Z_run.log`) and its own classification only checks file existence ("exists and parses -> blocked"), never branching on the specific reason string — raw `.../2026-09-06T13-46-45-076Z_rg.log`, `.../2026-09-06T13-47-00-395Z_run.log`. Consequence: a value written by an older build (e.g. bare `"budget_exhausted"` from before this widening, or before `"tool_call_budget_exhausted"` existed) still parses and flows through untouched — nothing rejects an unrecognized string. `bun run typecheck` and `bun run typecheck:scripts` both exit 0 confirming no compile-time break either — raw `.../2026-09-06T13-50-26-652Z_run.log`, `.../2026-09-06T13-50-31-986Z_run.log`. `slate-terminal-state.test.ts` itself: 9/9 pass — raw `.../2026-09-06T13-50-33-781Z_run.log`. |
| The regression genuinely fails without the production change | **MET, proven by scratch-copy revert** | Copied `src/` (+ `package.json`/tsconfig/`bunfig.toml`, `node_modules` symlinked) into a scratch directory OUTSIDE the working tree; reverted ONLY `agent.ts`'s no-progress call site there, `"no_progress"` -> `"budget_exhausted"` (leaving the widened union and every other file untouched, matching "revert the production line", singular). Ran the ACTUAL, byte-for-byte unmodified committed regression (`agent-tool-call-budget.test.ts`'s `"T20 F-001..."` test) against that scratch copy: it FAILS — `Expected: "no_progress" / Received: "budget_exhausted"` — raw `.../2026-09-06T13-49-57-791Z_run.log` (`sha256 7935b55c832c3b235da58253be69c65ede7a6985a4ae3659864653df97daee83`). Own probe run the same way (`T21_AGENT_MODULE_URL` pointed at the scratch copy) shows the SAME isolation: case `T21A` (the major) fails while `T21B`/`T21C`/`T21D` (the three untouched genuine-reason paths) still pass — proving the revert broke exactly the one thing the fix touched and nothing else — raw `.../2026-09-06T13-49-30-899Z_run.log` (`sha256 fb901139dfa7d586caa48c9c75eba48fedca5fca1e8965fca50b5018915e8ef0`). Scratch directory removed after use; working tree was never edited (confirmed by the unchanged hashes above). |
| Behavior-preserving everywhere else: fifteen preserved probe cases, focused agent/budget/child suite, both TypeScript targets, targeted lint | **MET** | `T16-final-core-budget-probe.ts` re-run UNCHANGED: 11/11 pass — raw `.../2026-09-06T13-47-37-517Z_run.log` (`sha256 5162579909725b32404a46729d76f846cbb3c6c599b1b1757844606afbbbe97b`). `T16-final-child-budget-probe.ts` re-run UNCHANGED: 4/4 pass — raw `.../2026-09-06T13-47-39-134Z_run.log` (`sha256 1a6566cf321b6ac859d69b7c585fd1398fdc4f4d43b3e921375bd29517880bc1`). `bun test src/commands/agent.test.ts src/commands/agent-tool-call-budget.test.ts src/harness/tool/builtin/spawn-subagent-tool.test.ts`: 111 pass / 0 fail, 452 assertions — raw `.../2026-09-06T13-50-05-811Z_run.log` (`sha256 1643a42ccde257eb7a83b84c38764c3ec2217d9f91230f24336dba29fbfb8b9b`). `bun run typecheck` exit 0 — raw `.../2026-09-06T13-50-26-652Z_run.log` (`sha256 8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92`). `bun run typecheck:scripts` exit 0 — raw `.../2026-09-06T13-50-31-986Z_run.log` (`sha256 b93b65b9afcd13e93f4fda2aa54ee204580a21cf8cbb6889bd90fab11fb0bbd6`). `bunx eslint` on all four T20-changed files: exit 0, no output — raw `.../2026-09-06T13-50-42-431Z_run.log` (`sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`). |

Stage 1 passes cleanly (7/7 rows MET, 0 NOT MET). Stage 2 follows.

## Stage 2 — code quality

Read T20's actual diff against the four changed production/test files (`git diff <HEAD> --
src/commands/agent.ts src/commands/agent-tool-call-budget.test.ts
src/harness/tool/builtin/spawn-subagent-tool.ts src/session/slate-terminal-state.ts`, raw
`.../2026-09-06T13-51-05-313Z_run.log` — note this diffs against the pre-M10 base, so it also
contains T19's earlier changes; T20's own hunks were isolated by cross-referencing the `T20
F-001`/`T20 F-002`/`T20 F-003`/`T20 F-004` comment markers T20 itself left in the code, all of
which were read directly in Stage 1 above).

- F-001's fix: one-line reason-string change plus a four-line inline comment naming the actual
  cause. Matches the existing comment density and voice around every other `emitTerminalState`
  call site in the file. No naming, duplication, or organization issue.
- The `TerminalStateReason` union widening: additive, alphabetically/logically grouped with the
  existing members (each one specific stop cause, `"other"` last as the residual), doc comment
  explains the new member's relationship to the existing one it is distinguished from. Consistent
  with the file's existing one-doc-comment-per-exported-type convention.
- F-002/F-003: pure prose corrections; the new prose is accurate (verified against the code
  above) and no more verbose than necessary.
- F-004: the deleted block is replaced by a comment that itself would fail if untrue (it makes a
  falsifiable claim: "a bare `for (;;)` body re-enters at the top, where the entry guard ...
  already catches this exact case on the next iteration") — this review traced that claim rather
  than accepting it, and it holds (Stage 1 row above). No stray blank line or brace imbalance
  left behind (typecheck/lint both clean).

No quality findings. Nothing here rises even to `info`.

## Confirmed clean areas

- All four `T16-final-review.md` findings (`F-001` major, `F-002`/`F-003`/`F-004` minor):
  closed, independently verified by execution and direct source reading, not by re-reading
  `T20-implementation.md`'s narrative.
- `TerminalStateReason` union widening: zero consumers broken, including the one genuinely
  order-sensitive case checked — an older-build persisted value still round-trips through
  `sac/catch-up.ts`'s unvalidated `JSON.parse` cast.
- The three OTHER `emitTerminalState` call sites (round-budget, tool-call-budget, `ask_user`):
  confirmed still correct and untouched by T20, both by direct reading and by dedicated
  probe cases (`T21B`/`T21C`/`T21D`) that did not exist before this review.
- The deleted trailing round-ceiling guard: traced dead on every exit path from the loop body,
  not merely on the paths the prior review's probes happened to exercise.
- `src/security/*` / `src/commands/security.ts`: excluded per dispatch; observed under
  concurrent modification with no overlap with anything this review depends on.

## Evidence (raw logs, SHA-256)

| Raw log | SHA-256 | What it shows |
|---|---|---|
| `.metaproject/data/gdctx/raw/2026-09-06T13-44-36-318Z_rg.log` | `309dbd95f89f61eb32f287892fb91fd48bd8f542c2cf2d7bb03100ac6403fd08` | Self-enumerated `emitTerminalState` call sites (declaration + 4 sites) |
| `.metaproject/data/gdctx/raw/2026-09-06T13-44-51-077Z_run.log` | `afc34fc8c5d4b0bfb8d3e055ad580467864bc055dcd97e5e4a3381b43fcdf709` | Round-budget site context (`stopAtRoundLimit`) |
| `.metaproject/data/gdctx/raw/2026-09-06T13-44-52-734Z_run.log` | `ac17a1e49c8f80854a874e7d336c8a434fe6fe7b4cde3e762fc7c2e28e8c7607` | `ask_user` interception site context |
| `.metaproject/data/gdctx/raw/2026-09-06T13-44-54-376Z_run.log` | `1cded43e81a42a4de2a04839297ca946b5023080b8413de6961b8f7ad56259d5` | Tool-call-budget + no-progress sites; F-004 replacement comment |
| `.metaproject/data/gdctx/raw/2026-09-06T13-45-01-470Z_run.log` | `0a9386dd09e1fd98efc391588cd669995b5ea414bab2d70e25fdd517fe63a095` | `for (;;)` loop start and entry guard |
| `.metaproject/data/gdctx/raw/2026-09-06T13-45-17-784Z_rg.log` | `426789fa284dd0580e74830bf0e5fb237eef775bf21f8df1b2f0425433f59eab` | Every `return`/`continue`/`finishReason` site in `agent.ts` (F-004 trace) |
| `.metaproject/data/gdctx/raw/2026-09-06T13-46-03-663Z_rg.log` | `e42a6efc47e6fc23a1185d200a6d8d0de9179d9cf3f1c02cc490ff1adfd60e39` | `finishWithBudgetSummary` has exactly one call site (F-002) |
| `.metaproject/data/gdctx/raw/2026-09-06T13-46-05-285Z_run.log` | `f427eb86447cff987ac92c15a0c75d4f711cd39e00ee1a1f8f82e317b123260f` | `offerRoundLimitReset` corrected doc comment (F-002) |
| `.metaproject/data/gdctx/raw/2026-09-06T13-46-16-450Z_run.log` | `4ef0e07ec4f4535949cbd44e4f177d41275f88a2750715e28ba3b954263c8dd0` | `SubagentCompletionStatus` corrected doc comment (F-003) |
| `.metaproject/data/gdctx/raw/2026-09-06T13-46-18-203Z_rg.log` | `ce7f2b6e6cd3a23f0a67c1deeb101a774de4eefc1381636ebc2e56a9c849ac7b` | Status-mapping code line matches the F-003 doc |
| `.metaproject/data/gdctx/raw/2026-09-06T13-46-22-904Z_run.log` | `272ce12d69a7a929412390eba82e960a2a3909114b1e98f9a5540bf9441e3143` | `TerminalStateReason` declaration + doc comment |
| `.metaproject/data/gdctx/raw/2026-09-06T13-46-24-613Z_rg.log` | `8b8563b331c8df6184481a23f84f132273b917c866f0e06f7e68d70fbe625694` | `TerminalStateReason` type name used in exactly 3 files |
| `.metaproject/data/gdctx/raw/2026-09-06T13-46-32-331Z_rg.log` | `a5e5b80ed27bd4fe125dfc33ed7000460b730cd0848553a07e1e344669b3c3c2` | Every `terminal-state.json`/`onTerminalState` consumer enumerated |
| `.metaproject/data/gdctx/raw/2026-09-06T13-46-45-076Z_rg.log` | `fc8ea1b70ead84ce56473654ca7a783d5dfb91e75e00f9d1b9edc9ab1c99e552` | `catch-up.ts`'s `readTerminalState` does a blind cast, no schema |
| `.metaproject/data/gdctx/raw/2026-09-06T13-47-00-395Z_run.log` | `073c0d507f42561cfd0ce94ee8de75309b025a342316efba26d149da648b7867` | `catch-up.ts` classification depends only on file existence, not reason value |
| `.metaproject/data/gdctx/raw/2026-09-06T13-47-02-099Z_run.log` | `eaa3a24f5b6db3f3317c9fea5d2ef847761adf444117295f0935f9f45a4b1e80` | `readConfigFile` is a byte-bounded raw read, not a runtime validator |
| `.metaproject/data/gdctx/raw/2026-09-06T13-47-37-517Z_run.log` | `5162579909725b32404a46729d76f846cbb3c6c599b1b1757844606afbbbe97b` | `T16-final-core-budget-probe.ts` unchanged rerun: 11/11 pass |
| `.metaproject/data/gdctx/raw/2026-09-06T13-47-39-134Z_run.log` | `1a6566cf321b6ac859d69b7c585fd1398fdc4f4d43b3e921375bd29517880bc1` | `T16-final-child-budget-probe.ts` unchanged rerun: 4/4 pass |
| `.metaproject/data/gdctx/raw/2026-09-06T13-49-15-484Z_run.log` | `c9136d5de451ee769388cbda8b21210499056b9564ed43378eca21abc5cfb8ec` | Own `T21-terminal-reason-probe.ts` against real working tree: 4/4 pass |
| `.metaproject/data/gdctx/raw/2026-09-06T13-49-30-899Z_run.log` | `fb901139dfa7d586caa48c9c75eba48fedca5fca1e8965fca50b5018915e8ef0` | Own probe against scratch reverted copy: only the major's case fails |
| `.metaproject/data/gdctx/raw/2026-09-06T13-49-57-791Z_run.log` | `7935b55c832c3b235da58253be69c65ede7a6985a4ae3659864653df97daee83` | Actual unmodified committed regression run against scratch reverted copy: FAILS as required |
| `.metaproject/data/gdctx/raw/2026-09-06T13-50-05-811Z_run.log` | `1643a42ccde257eb7a83b84c38764c3ec2217d9f91230f24336dba29fbfb8b9b` | Focused 3-file suite against real working tree: 111 pass / 0 fail |
| `.metaproject/data/gdctx/raw/2026-09-06T13-50-26-652Z_run.log` | `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92` | `bun run typecheck`: exit 0 |
| `.metaproject/data/gdctx/raw/2026-09-06T13-50-31-986Z_run.log` | `b93b65b9afcd13e93f4fda2aa54ee204580a21cf8cbb6889bd90fab11fb0bbd6` | `bun run typecheck:scripts`: exit 0 |
| `.metaproject/data/gdctx/raw/2026-09-06T13-50-33-781Z_run.log` | `a1c6414fefc01ed884fbe762476bf905295ba2c75b8c703e8abbf94386bf1236` | `slate-terminal-state.test.ts`: 9/9 pass |
| `.metaproject/data/gdctx/raw/2026-09-06T13-50-42-431Z_run.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | Targeted ESLint on all 4 T20-changed files: clean |
| `.metaproject/data/gdctx/raw/2026-09-06T13-50-50-473Z_rg.log` | `49e3802e15c86d8afa7584e6b55333f161d317e5838a02b7f976a6412ade58cd` | Every non-test `TerminalState` reference across `src/` (5 files, no switch) |

New probe script: `T21-terminal-reason-probe.ts` (this artifacts directory) — dual-mode,
imports `runAgentTurn` from `T21_AGENT_MODULE_URL` (defaults to the real working-tree
`agent.ts`), hard-asserts all four terminal reasons. Preserved probes
`T16-final-core-budget-probe.ts` / `T16-final-child-budget-probe.ts` were re-run byte-for-byte
unchanged, never edited.

## Routing audit

- `graph_used: no (unavailable-as-current)` — same rationale `T19-spec.md`/`T20-spec.md`
  recorded: the working tree carries uncommitted M10/T19/T20 edits the last `keryx gdgraph
  build` predates (and two concurrent workers are actively editing `src/security/*` right now).
  Bounded direct reads and executed probes were authoritative for this file-scoped recheck.
- `wiki_used: no (not-relevant)` — `T16-final-review.md`'s four findings, `T19-spec.md`'s
  approved round/call-budget contract, and `T20-spec.md`/`T20-implementation.md`'s stated fix
  fully define what this review had to independently confirm; no architectural or domain
  question arose.
- `ctx_used: yes` — every search, read, and command execution in this review went through
  `bun src/cli.ts ctx rg` / `bun src/cli.ts ctx run` / `bun src/cli.ts ctx read`; raw logs are
  cited by path and hash throughout.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`sed` was run against project source. Two
  narrow exceptions, both outside the project source tree and both explicitly reasoned inline
  at the time: (1) `shasum -a 256` on already-identified file paths (hashing, not content
  search); (2) one `grep -n` on the SCRATCH revert-experiment copy under `/private/tmp/...`
  (not this repository's working tree) to locate the single line to revert there, escaped with
  `# keryx:raw` and a stated reason (locating a line inside a throwaway copy outside the
  reviewed codebase, not a project source search).

## Findings

None detected. No blocker, major, minor, or info finding was produced by this review.

```json keryx:findings
[]
```
