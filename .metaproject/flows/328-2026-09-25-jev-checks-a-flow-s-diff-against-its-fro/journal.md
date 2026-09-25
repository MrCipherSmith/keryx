# Flow Journal

- 2026-09-25T13:07:33.209Z - flow created
- 2026-09-25T13:07:51.234Z - frozen: 10 criteria; checksum recorded
- 2026-09-25T13:07:51.450Z - started
- 2026-09-25T14:16:00.000Z - AC9 live check: `keryx flow check-ac` run with `env -u OPENROUTER_API_KEY`
  (saved OpenRouter key from `~/.local/share/keryx/auth.json`) against two already-merged flows of
  this repository, from a scratch copy carrying only `.metaproject/flows/307-*` /
  `.metaproject/flows/309-*` and a temporary `.metaproject/tasks.config.json` opt-in
  (`review.jev.ac_check: true`, never committed). `gh` resolved the repo from this worktree's
  `origin` remote.

  - **Flow 309 vs PR #712's diff** (`keryx flow check-ac 309 --pr 712 --json`): 8 checkable
    criteria, 2 not-checkable (AC9 "Live check... env -u OPENROUTER_API_KEY", AC10 "CI green...").
    2 Jev calls, ≈28k input tokens, cost ≈$0.0012. Verdicts: AC2/AC3/AC4/AC5/AC6/AC7 likely-met
    (0.73-0.95), AC1 not-evident (0.48), AC8 likely-met (0.58, borderline — see note below).
    FIRST attempt failed with a real vendor `HTTP 400 max_tokens_exceeded` (the PR's diff is large
    and several criteria's named tokens — `/model`, `/routing` — matched dozens of regions,
    duplicating large hunk text across the batch); fixed by capping matched hunks per criterion to
    the 8 smallest regions (`MAX_MATCHED_HUNKS_PER_ITEM`) and packing batches to 50% of the
    documented 64k budget with a 6-criteria-per-batch cap (`BATCH_BUDGET_FRACTION`,
    `MAX_ITEMS_PER_BATCH` in `src/flow/check-ac.ts`) — `estimateTokens` (chars/4) under-counts the
    vendor's real accounting for a `noul`-schema batch. Re-run succeeded cleanly.
  - **Flow 307 vs PR #710's diff** (`keryx flow check-ac 307 --pr 710 --json`): 9 checkable
    criteria, 1 not-checkable (AC10 "CI is green..."). 2 Jev calls, ≈30k input tokens, cost
    ≈$0.0012. Verdicts: AC1/AC2/AC3/AC4/AC5/AC6/AC9 likely-met (0.55-0.93), AC8 likely-met (0.55,
    also ungrounded — see note), AC7 not-evident (0.46).

  Total: 4 Jev calls, ≈$0.0025, well inside the ~60-call budget.

  **Honest usefulness note.** Real, useful flags: flow 307's AC7 ("names where the key came from
  ... says when the key does not look like an OpenRouter key ... without printing the key")
  scored 0.46 (not-evident) despite `src/harness/decision/jev-client.ts`'s `JevAuthRejectedError`
  actually implementing exactly that — this is a genuine borderline/wrong call worth a reviewer's
  second look, not a criterion a reviewer would wave through. Flow 309's AC1 (a long, multi-clause
  criterion — parallel fetch, timeout, size cap, five-state status enum, unconnected providers
  never probed, unit tests including a 401) scored 0.48; a compound criterion like this is exactly
  where a reviewer SHOULD check every clause individually rather than trust a single verdict, so
  flagging it as borderline rather than confidently met is the right instinct even though the
  feature is very likely implemented — the tool correctly refuses false confidence on a criterion
  no single probability can honestly summarize. A genuine limitation, not a false "wrongly
  flagged": both flows' AC8-equivalent criteria (309's "No network in unit tests; macOS-safe;
  import zones respected...", 307's "the verdict says so and states it as deterministic
  evidence...") name NO backticked token or file path at all, so AC2's deterministic layer has
  nothing to ground them in — Jev's probability there (0.58, 0.55) is close to a coin flip on
  prose alone, which is an honest signal that "not-checkable" or a lower-confidence label might
  suit token-less criteria better than a bare `likely-met`/`not-evident` split; left as a known
  limitation rather than reworked under this flow's time budget. No criterion that was clearly and
  simply met (e.g. 309's AC3 catalog cache at 0.95, AC4 `/routing` picker at 0.92) was wrongly
  flagged as not-evident — every high-confidence verdict lined up with strong, multi-file
  deterministic evidence in `factLines`/`evidencePaths`.
- 2026-09-25T16:27:06.030Z - task-done: T1: Collect remaining context
- 2026-09-25T16:27:06.155Z - task-done: T2: Implement per plan
- 2026-09-25T16:27:06.270Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-25T16:27:06.384Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-25T16:28:47.428Z - ac-confirmed: AC1: src/commands/flow-check-ac.ts (adapter) + src/flow/check-ac.ts: `keryx flow check-ac <id> [--diff <ref>|--pr <n>] [--json]` reads the frozen acceptance-criteria.md, refuses when not frozen (isFrozen), diffs against base/merge-base with origin/main by default, and reports likely-met/not-evident/not-checkable per criterion with an ADVISORY header; never mutates flow state. Registered in src/commands/flow.ts (+79 lines) and src/standard/help-groups.ts. Tested in src/commands/flow-check-ac.test.ts (355 lines) and src/flow/check-ac.test.ts (314 lines). Landed in PR #717... wait wrong PR (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:28:55.746Z - ac-confirmed: AC1: src/commands/flow-check-ac.ts (adapter) + src/flow/check-ac.ts: keryx flow check-ac <id> [--diff <ref>|--pr <n>] [--json] reads the frozen acceptance-criteria.md, refuses when not frozen (isFrozen), diffs against base/merge-base with origin/main by default, and reports likely-met/not-evident/not-checkable per criterion with an ADVISORY header; never mutates flow state. Registered in src/commands/flow.ts (+79 lines) and src/standard/help-groups.ts. Tested in src/commands/flow-check-ac.test.ts (355 lines) and src/flow/check-ac.test.ts (314 lines). PR #723, merge 510139e64a212f14fecd928d3789652aa83045ed. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:29:05.681Z - ac-confirmed: AC2: src/flow/check-ac.ts extractCriterionTokens (backticked tokens, bare file paths, keryx <cmd> names) and computeAcFacts (tokensPresent/tokensAbsent against diff text and changed-file list, testsChanged, factLines) run before any Jev call, per criterion, pure functions with no I/O. Unit-tested in src/flow/check-ac.test.ts. PR #723, merge 510139e64a212f14fecd928d3789652aa83045ed. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:29:05.799Z - ac-confirmed: AC3: src/flow/check-ac.ts NOT_CHECKABLE_MARKERS (live check, CI green, health passing, docs published, manual verification, operator confirmation — documented exhaustive list) and classifyClause/classifyNotCheckable assign not-checkable without any model call for a matching criterion; always listed in the report, never sent to Jev. Unit-tested in src/flow/check-ac.test.ts. PR #723, merge 510139e64a212f14fecd928d3789652aa83045ed. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:29:05.924Z - ac-confirmed: AC4: src/flow/check-ac.ts: one noul per checkable criterion built from redacted matching hunks (redactSensitiveText via src/security/service.ts), MAX_MATCHED_HUNKS_PER_ITEM=8 and BATCH_BUDGET_FRACTION packing to the 64k budget; a criterion with no matching hunk gets the file list and an explicit 'nothing matched' fact. Opt-in via review.jev.ac_check in .metaproject/tasks.config.json; without it configured the command still prints deterministic evidence and states Jev was not asked. Unit-tested in src/flow/check-ac.test.ts and src/commands/flow-check-ac.test.ts. PR #723, merge 510139e64a212f14fecd928d3789652aa83045ed. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:29:18.355Z - ac-confirmed: AC5: src/commands/flow.ts: flow implemented and flow complete print the check-ac summary (counts + criteria not evident) as a one-line advisory when review.jev.ac_check is on and Jev is reachable; never blocks or changes gate outcome, and a check failure prints as a one-line notice rather than failing the command. Unit-tested in src/commands/agent-commands.test.ts and src/flow/check-ac.test.ts. PR #723, merge 510139e64a212f14fecd928d3789652aa83045ed. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:29:18.469Z - ac-confirmed: AC6: src/commands/review.ts ~L792-832: keryx review ingest for a flow with the opt-in writes ac-check.md into the review package directory (acCheckPath = path.join(result.path, 'ac-check.md')), printing 'ac-check: attached (...)' or 'ac-check: stale (...)' when the cached check does not match the round's diff. Tested in src/commands/review-ac-check-cli.test.ts (210 lines, fixture package). PR #723, merge 510139e64a212f14fecd928d3789652aa83045ed. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:29:18.587Z - ac-confirmed: AC7: src/tui/flow-inspector.ts (+138/-2) and src/tui/inspector-sources.ts (+81 new): the flow inspector panel shows per-criterion markers (met/not-evident/not-checkable/not-run) with a key ('c') to run the check; isAcCommand accepts /ac and /ac <flow-id> as a direct entry point opening a detail view with evidence. English UI text throughout. Render-tested in src/tui/flow-inspector.test.ts (+140 lines) and src/tui/inspector-sources.test.ts (119 lines, new). PR #723, merge 510139e64a212f14fecd928d3789652aa83045ed. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:29:18.707Z - ac-confirmed: AC8: src/flow/check-ac.ts ~L414-458: cache key is (criteria checksum, diff hash) under .metaproject/data/ (gitignored per .gitignore +6 lines in this PR), written via writeFileAtomic with mode 0o600 and an explicit chmod(cachePath, 0o600) fallback; the shell reads the cache (src/tui/inspector-sources.ts) rather than re-asking Jev for an unchanged diff. --refresh bypasses the cache per the round-1 fix commit 71619891e54c2eaaeb53d36068a0ede7dc384cf4. PR #723, merge 510139e64a212f14fecd928d3789652aa83045ed. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:29:26.667Z - ac-confirmed: AC9: Live check recorded in this flow's journal.md at 2026-09-25T14:16:00.000Z: keryx flow check-ac run with env -u OPENROUTER_API_KEY against flow 309 vs PR #712's diff (8 checkable/2 not-checkable criteria, 2 Jev calls, ~28k tokens, ~$0.0012) and flow 307 vs PR #710's diff (9 checkable/1 not-checkable, 2 Jev calls, ~30k tokens, ~$0.0012); total 4 Jev calls, ~$0.0025. Honest usefulness note recorded: flow 307's AC7 scored 0.46 (not-evident) despite being genuinely implemented -- a real borderline flag worth a reviewer's look; flow 309's AC1 (compound criterion) scored 0.48, correctly refusing false confidence; no clearly-met criterion was wrongly flagged. PR #723, merge 510139e64a212f14fecd928d3789652aa83045ed. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:29:39.122Z - ac-confirmed: AC10: Docs: docs/docs/cli-reference.md (+76 lines, check-ac reference), docs/docs/commands-by-task.md (+1). CI on PR #723 (https://github.com/MrCipherSmith/keryx/pull/723), merged as 510139e64a212f14fecd928d3789652aa83045ed: 19 status checks, 18 SUCCESS + 1 SKIPPED (deploy to GitHub Pages, not applicable to a PR build), 0 failing -- confirmed via gh pr view 723 --json statusCheckRollup. keryx health status in this worktree: gate=pass, project score 94 (last run 2026-09-25T14:32:16.328Z). Tests are hermetic: src/flow/check-ac.test.ts / src/commands/flow-check-ac.test.ts / src/commands/review-ac-check-cli.test.ts use fixture Jev/gh ports, no real network. Import zones: flow/check-ac.ts stays in the core zone (no client-zone jev-client import; the adapter src/commands/flow.ts glues it to the real client), per the module's own header comment. PR #723, merge 510139e64a212f14fecd928d3789652aa83045ed. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T16:29:42.739Z - owner-set: not set -> MrCipherSmith (operator)
- 2026-09-25T16:29:44.933Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/723 (warning: PR is not a draft) (base: main)
- 2026-09-25T16:30:56.227Z - owner-changed: MrCipherSmith -> MrCipherSmith (operator)
- 2026-09-25T16:32:12.695Z - completing
- 2026-09-25T16:32:17.146Z - completion-attempt-recorded: attempt 1: passed
- 2026-09-25T16:32:17.149Z - done: all gates passed
