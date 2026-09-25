# Review — flow 329, Jev turn guard in keryx shell (PR #720)

Three rounds ran against the flow 329 branch (`src/review/turn-guard.ts`,
`src/tui/turn-guard-source.ts`, `src/tui/turn-guard-inspector.ts`,
`src/tui/tui-shell.ts`, `src/commands/shell.ts`, `src/commands/agent-commands.ts`,
`src/lib/shell-config.ts`, `scripts/turn-guard-live-check.ts`, plus tests and
docs), which add a Jev-backed turn guard: after each agent turn in `keryx
shell` settles, the guard extracts deterministic facts from what the tools
actually did, decides some contradictions without a model, and otherwise asks
Jev two `noul` questions (was the request done, does the reply contradict the
facts) — surfacing one compact notice line and a `/guard` modal, opt-in and
non-blocking.

**Round 1** ran against the branch's first commit (`955f2041`) and raised
three findings, all fixed in the branch's second real commit
(`8930dbb3`, `fix(shell): turn guard flags only real failures; no painting
after ex…it; history in turn order`):

- **F-001 (major)** — the deterministic AC3 contradiction check treated ANY
  nonzero exit from a `shell_exec` call as a tool failure, when
  `shell-exec-tool.ts` marks any nonzero exit `isError: true` regardless of
  whether the command actually failed (`grep` with no match, `test -f`
  false, `diff` showing a difference, `git diff --exit-code`, …) — every one
  of those would be reported as "an unmentioned tool failure" the moment the
  final message didn't call it out by name, defeating the whole point of a
  *deterministic* contradiction layer.
- **F-002 (minor)** — the guard's deferred continuation (fired `void`,
  unawaited, right after the turn settles, then awaiting up to an 8 s Jev
  round trip) touched `history`/the sidebar/`io.onSystem` with no check that
  the turn had since been aborted or the shell renderer torn down — a
  use-after-teardown write when the operator exited or cancelled while the
  guard call was still in flight.
- **F-003 (minor)** — `guardHistory` was always `unshift`ed with the newest
  result at the front, but the guard call for a turn needing a real Jev
  round trip can resolve *after* a later, trivial turn's near-instant guard
  call (both are fired `void` from their own turn's settle) — completion
  order does not track turn order, so the `/guard` modal's history could
  show turns out of order.

**Round 2** re-read the branch's fixed state and raised three more findings
against the same second commit, all fixed in the branch's next commit
(`ee2bffde`, `fix(shell): turn guard classifies wrapped and env-prefixed
build/test… commands; background job failures count`):

- **F-004 (major)** — the round-1 fix's build/test/install/typecheck
  classifier matched only a bare program name or package-manager subcommand
  (`tsc`, `bun test`, …), so a real build/test/typecheck command run through
  a package-runner or interpreter wrapper (`npx tsc`, `bunx eslint`, `pnpm
  dlx prettier --check`, `python -m pytest`) or with a leading env-variable
  assignment (`FOO=1 bun test`, `env CI=1 npm test`) was invisible to the
  classifier — its own name (`npx`, `env`, …) is never itself
  build/test/install/typecheck, so a genuinely failed test run invoked this
  way would not be flagged deterministically even when the final message
  said nothing about it.
- **F-005 (minor)** — the round-1 `SHELL_TOOL_INFRA_FAILURE_RE` (a tool's own
  infra failure: timed out, aborted, denied, failed to start) did not cover
  `shell_exec`'s background/job-registry failure modes (background jobs
  unavailable, task limit reached, unknown job id, job no longer tracked,
  idle-killed) — a backgrounded command that failed this way was not
  recognised as a deterministic tool failure.
- **F-006 (major)** — the live-check script (AC8) ran twice in the
  confirming session: the first run scored 7/8 (one case, a `grep`
  no-match, was wrongly flagged by live Jev), and only the second run,
  after rewording that case's final message, scored 8/8. The script's
  printed summary reported only whichever run had just executed, with no
  indication that an earlier run had scored lower and that the case's
  *wording* — not the guard's judgement — had changed between runs; a
  reader of the script's own output in isolation would see a clean 8/8 with
  no visibility into the miss that preceded it.

**Round 3** re-read the branch's final commits (the fix commit plus two
`Merge origin/main into feat/turn-guard` merge commits, ending at
`7b059527`) against all six findings above and **approves**: all three
round-1 fixes and all three round-2 fixes are present in the merged diff,
each with its own new or extended test (`turn-guard.test.ts`'s "Item 1 (PR
#720 review)" and round-2 wrapper/env-prefix/job-registry cases,
`turn-guard-shell-wiring.test.ts`'s destroyed-guard assertions), and no new
issues were raised in this pass.

PR #720 squash-merged as `26f000489f043ae8454b8c93c62352eab8f45b2d` into
`main`; CI was 19/19 (18 success, 1 skipped — "deploy to GitHub Pages", not
applicable to a PR build) on the PR, and `keryx health run` passes at this
worktree's `origin/main` head (project score 94, no gate conditions
triggered).

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/review/turn-guard.ts",
    "problem": "The deterministic AC3 contradiction check flagged ANY nonzero exit from a shell_exec call as a tool failure, but shell-exec-tool.ts marks any nonzero exit isError: true regardless of whether the command actually failed (grep with no match, test -f false, diff showing a difference, git diff --exit-code, ls on a missing path, ...).",
    "impact": "A large class of completely normal, expected nonzero exits would be reported as an unmentioned tool failure the instant the final message did not call the exact command out by name, producing constant spurious 'Guard: request may be incomplete' notices and defeating the purpose of a deterministic (no-Jev) contradiction layer, which AC3 requires to be precise enough to fire even when Jev is unavailable.",
    "suggested_fix": "Narrow the deterministic rule so a shell_exec failure only counts when the tool itself failed (timed out, aborted, denied, failed to start) or the command tokenises to a build/test/install/typecheck runner; leave every other nonzero exit as a plain fact for Jev to weigh, not an automatic contradiction.",
    "evidence": "src/review/turn-guard.ts:414 `if (call.isError && (SHELL_TOOL_INFRA_FAILURE_RE.test(call.output) || isBuildTestInstallTypecheckCommand(command)))` is the sole site deciding TurnGuardFacts.deterministicFailedTools; its module comment (turn-guard.ts:130-141) states the fix explicitly as 'Item 1 (PR #720 review)'. Fixed in commit 8930dbb3a10d77ab950deb89423368f00d4d25ce.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/turn-guard.ts:414 — the single call site building TurnGuardFacts.deterministicFailedTools from a shell_exec call's isError/output/command"
      ],
      "enumeration_method": "keryx ctx rg for isBuildTestInstallTypecheckCommand and SHELL_TOOL_INFRA_FAILURE_RE across src/review/turn-guard.ts (3 and 1 matches respectively) confirmed both are consumed at exactly one decision site, not duplicated elsewhere in the module or in src/tui/turn-guard-source.ts / src/tui/tui-shell.ts"
    }
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "problem": "The guard's deferred continuation — fired void right after the turn settles, then awaiting runTurnGuard's up-to-8s Jev round trip — touched guardHistory, the guard sidebar and io.onSystem with no check that the turn had since been aborted or the shell/renderer already torn down.",
    "impact": "A late-resolving guard call (the operator exited or cancelled mid-turn while Jev was still being asked) could write into a destroyed shell's history/sidebar/system line — a use-after-teardown write.",
    "suggested_fix": "Capture the turn's own abort signal before it is cleared by foregroundOperation.settle(), and guard the continuation the same way other deferred continuations in this file already do: `if (turnSignal.aborted || foregroundOperation.isDisposed) return;` before touching anything.",
    "evidence": "src/tui/tui-shell.ts:7906 captures `const turnSignal = foregroundOperation.signal;` before settle(), and the guard continuation at tui-shell.ts:7951 checks `if (turnSignal.aborted || foregroundOperation.isDisposed) return;` before calling recordGuardResult/refreshGuardSidebar/io.onSystem, with an inline comment citing 'Item 2 (PR #720 review)'. Fixed in commit 8930dbb3a10d77ab950deb89423368f00d4d25ce.",
    "confidence": "high"
  },
  {
    "id": "F-003",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/tui/turn-guard-source.ts",
    "problem": "guardHistory was always unshifted with the newest result at the front, but the guard call for a turn needing a real Jev round trip can resolve after a later, trivial turn's near-instant guard call (both are fired void from their own turn's settle) — completion order does not track turn order.",
    "impact": "The /guard modal's history list could show an earlier turn's guard result above a later turn's, misleading whoever reads it about which turn a flagged result actually belongs to.",
    "suggested_fix": "Insert each result at the position that keeps history sorted by the turn's own start timestamp (recorded before any Jev round trip), not always at the front.",
    "evidence": "src/tui/turn-guard-source.ts:117-121 exports insertTurnGuardResult(history, result, cap), which finds the correct sorted insertion point by result.at rather than always prepending; its doc comment (lines 100-116) cites 'PR #720 review item 3' and explains the completion-order-vs-turn-order race. tui-shell.ts:4490 calls it from recordGuardResult. Fixed in commit 8930dbb3a10d77ab950deb89423368f00d4d25ce.",
    "confidence": "high"
  },
  {
    "id": "F-004",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/review/turn-guard.ts",
    "problem": "The round-1 build/test/install/typecheck classifier (isBuildTestInstallTypecheckCommand) matched only a bare program name or a package-manager's own subcommand, so a real build/test/typecheck program invoked through a package-runner or interpreter wrapper (npx tsc, bunx eslint, pnpm dlx prettier --check, python -m pytest) or behind a leading env-variable assignment (FOO=1 bun test, env CI=1 npm test) was invisible to it — the wrapper's own name is never itself build/test/install/typecheck.",
    "impact": "A genuinely failed test/build/typecheck run invoked through any of these extremely common forms (npx/bunx one-off runs, CI-style env-prefixed commands) would not be recognised deterministically, so AC3's no-Jev safety net would miss it even when the final message said nothing about the failure — exactly the case AC3 exists to catch.",
    "suggested_fix": "Strip leading env-variable assignments (or an explicit `env` invocation and its flags) and unwrap package-runner/interpreter wrappers (npx, bunx, uvx, pnpm dlx/exec, yarn dlx, npm exec, bun x, poetry run, uv run, python -m), bounded to a few rounds, before classifying the underlying program.",
    "evidence": "src/review/turn-guard.ts:207-223 stripEnvAssignments, :233-234 SINGLE_TOKEN_WRAPPERS/WRAPPER_SKIP_FLAG_RE, :236-244 TWO_TOKEN_WRAPPERS, :255-273 unwrapRunner, and isBuildTestInstallTypecheckCommand (:289-299) now runs on `unwrapRunner(stripEnvAssignments(commandTokens(segment)))`; all cite 'Item 1 (PR #720 round-2 review)' in their doc comments. New negative/positive cases in turn-guard.test.ts. Fixed in commit ee2bffde11e68107f393294ce9d2e45bc8b46b9.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/turn-guard.ts isBuildTestInstallTypecheckCommand — the single function that classifies a command segment, now routed through stripEnvAssignments/unwrapRunner before matching STANDALONE_BUILD_TEST_PROGRAMS / RUNNER_SUBCOMMAND_RE"
      ],
      "enumeration_method": "keryx ctx rg for isBuildTestInstallTypecheckCommand confirmed one definition and one call site (turn-guard.ts:414); read the full unwrap/strip pipeline (lines 198-299) to confirm every command-classification path funnels through the same two helper functions rather than duplicating raw-token matching elsewhere"
    }
  },
  {
    "id": "F-005",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/review/turn-guard.ts",
    "problem": "SHELL_TOOL_INFRA_FAILURE_RE (a shell_exec tool's own infra failure: timed out, aborted, denied approval, failed to start) did not cover shell_exec's background/job-registry failure modes: background jobs unavailable, background task limit reached, unknown job_id, job no longer tracked, idle-timeout kill.",
    "impact": "A backgrounded command that failed for one of these job-registry reasons was not recognised as a deterministic tool failure, so an unmentioned background-job failure could slip past the no-Jev contradiction check the same way F-001's unnarrowed rule once let ordinary nonzero exits slip past it in the other direction.",
    "suggested_fix": "Extend SHELL_TOOL_INFRA_FAILURE_RE with the exact text fragments background-job-registry.ts/shell-exec-tool.ts return for each of these failure modes.",
    "evidence": "src/review/turn-guard.ts:150-163 documents 'Item 2 (PR #720 round-2 review)' and lists each fragment; SHELL_TOOL_INFRA_FAILURE_RE (turn-guard.ts:164-165) now includes background jobs are not available in this session|background task limit reached|unknown job_id:|is no longer tracked, so its exit status is unknown|no output for \\d+ms, so the command was killed. Fixed in commit ee2bffde11e68107f393294ce9d2e45bc8b46b9.",
    "confidence": "high"
  },
  {
    "id": "F-006",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "scripts/turn-guard-live-check.ts",
    "problem": "The AC8 live-check script ran twice in the confirming session — 7/8 on the first run (one case wrongly flagged by live Jev), 8/8 on the second run after rewording that case's final message — but the script's own printed summary reported only whichever run had just executed, with nothing in its output distinguishing 'the guard got smarter' from 'the test case's wording changed between runs'.",
    "impact": "Anyone reading only the script's own console output (rather than the flow journal) would see a clean 8/8 with no indication a prior run scored lower or that a case had to be reworded to pass — an honesty gap between what actually happened (a miss, then a fix to the test input) and what the tool reports on each run in isolation.",
    "suggested_fix": "Print the recorded two-run history (7/8 first contact, 8/8 after rewording, which case and why) as part of every run's summary, not only in the flow journal, so the number is never read without that context.",
    "evidence": "scripts/turn-guard-live-check.ts:172-179 adds a fixed line to every run's summary: 'AC8 recorded history: 7/8 on first contact; 8/8 after rewording one case; the grep-no-match case moved from ~63% to ~42% contradiction probability (threshold 0.5).', with a comment citing 'PR #720 round-2 review, item 3'. The flow journal (2026-09-25T14:37:13.683Z ac-confirmed: AC8) separately records both runs' full detail. Fixed in commit ee2bffde11e68107f393294ce9d2e45bc8b46b9.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "scripts/turn-guard-live-check.ts:168-179 — the single summary block printed at the end of main(), the only place this script reports its result"
      ],
      "enumeration_method": "keryx ctx rg for correct|summary|first contact|/8|reported in scripts/turn-guard-live-check.ts: 8 matches, all inside one summary block in one standalone script with no other caller or duplicate reporting path"
    }
  }
]
```
