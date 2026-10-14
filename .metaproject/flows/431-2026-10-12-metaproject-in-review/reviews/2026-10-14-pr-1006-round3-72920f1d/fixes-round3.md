# Round 3 fixes (final)

Package: round 3 of PR 1006, head `72920f1d`. Commits: `cd9cd9c2` (R3-01..04, R3-24), `2c12ec73` (R3-05, R3-21, R3-07 partial),
the minors commit, and the test-hygiene commit that follows it.

Mutation command, run in a scratch copy for each mutant (baseline green):
`bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts src/lib/command-risk src/lib/trust-routine-command.test.ts src/commands/review-chunks.test.ts src/flow/review-gate-coverage.test.ts`
Specs and results: `research-evidence/mutants-r3fix-*.json`, `mutation-2.json` (part 0), `mutation-3.json` (part 1), and the survivor re-run.

## Majors

| Id | Result | Fix | Test | Mutants |
|---|---|---|---|---|
| R3-01 | fixed | The human-confirmation floor widens on words the shell still rewrites (`$X`, backticks, braces), for keryx commands only; the value of `--package` is exempt. | `src/lib/command-risk-review-floor.test.ts` | r3-01-opaque-args, r3-01-opaque-verb, r3-01-opaque-head, r3-01-package-exempt: killed. r3-01-chunk-answer-opaque survived, killed after adding the `keryx review $G $V --answer yes` case. |
| R3-02 | fixed | The routine allow-list refuses `--answer`/`--quote` on `review chunks` and `--write-wiki` on `review layers` (`refuseFlags`). | `src/lib/trust-routine-command.test.ts` | r3-02-refuse-flags, r3-02-chunks-refuse: killed. |
| R3-03 | fixed | Layer usage is judged by the command word of each shell segment and by MCP tool name, never by argument text; a chain credits each layer once. | `src/review/layers-usage.test.ts` | r3-03-args-text, r3-03-first-segment: killed. r3-03-mcp-args survived (string `arguments`), killed after adding that log line. |
| R3-04 | fixed | The floor is for keryx commands only; the chunk `--answer` is gated by the terminal check in `runChunks`, before the package is resolved. | `src/commands/review-chunks.test.ts`, floor test | r3-04-keryx-only, r3-04-terminal: killed. |
| R3-05 | fixed | The completeness gate in the flow review gate applies only to a non-closed round that kept a chunk plan, `coverage.json` or `coveredSlices` (`packageRecordsCoverage`). `review complete` keeps the strict check. | `src/flow/review-gate-coverage.test.ts` (3 tests), `src/review/complete-coverage-gate.test.ts` updated | r3-05-completeness: killed. |
| R3-21 | fixed | Four surviving mutants now have tests (fsmonitor, tag peel, lock stale option, `--max-bytes` floor). | `src/review/layers-round3.test.ts`, `src/commands/review-layers.test.ts` | r3-ly-fsmonitor, r3-ly-peel, r3-ly-lock-stale-opt-off, r3-rl-maxbytes-floor: all killed. |

Known trade-off (R3-01/R3-04): a positional `$X` after `review complete` still asks, because it could hold the flag.
`--package "$PKG"` does not ask.

## Minors

Fixed: R3-24 (stale JSDoc), R3-19 (SIGTERM test: 60 s timeout, `finally` kills the child), R3-20 (the escape directory is
named per fixture), R3-25 and R3-26 (docs and `review` help: `--force`, reuse of an intact graph, the 16-minute lock wait,
the waiver's terminal and quote rules), R3-30 (unused exports dropped; `CHUNK_LOCK_WAIT_MS` stays exported because a test pins it).
Partial: R3-07 (the `--max-bytes` message says the real floor depends on content), R3-09 (the `MAX_SHELL_NESTING` constant;
the shared walker was not extracted).

Skipped, with the reason:

- R3-06: signal handler at lock scope; needs design.
- R3-08, R3-11, R3-12, R3-13, R3-14, R3-15, R3-16: refactors or design changes; regression risk inside the time box.
- R3-17, R3-18, R3-27, R3-29: performance or design.
- R3-10: the flag constant spans five modules; optional, and a regression risk.
- R3-22: the runner's message cannot tell a timeout kill from the no-JSON path without a production change; the stub never exits by itself, so the rejection already proves the kill.
- R3-23: two-view guard test, not reached in the time box.
- R3-28: optional.
- R3-31: a rename, churn only.

No round 4 is planned.
