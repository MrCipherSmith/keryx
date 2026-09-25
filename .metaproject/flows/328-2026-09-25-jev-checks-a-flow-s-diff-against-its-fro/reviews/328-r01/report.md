# Review — flow 328, Jev checks a flow's diff against its frozen acceptance criteria (PR #723)

Two rounds ran against the flow 328 diff (`src/flow/check-ac.ts`,
`src/commands/flow-check-ac.ts`, `src/commands/flow.ts`,
`src/commands/review.ts`, `src/flow/service.ts`, `src/tui/flow-inspector.ts`,
`src/tui/inspector-sources.ts`, `src/tui/tui-shell.ts`, plus tests and docs),
which add `keryx flow check-ac`: a deterministic-facts-first, Jev-assisted,
never-blocking check of a flow's change against its own FROZEN acceptance
criteria, surfaced at the CLI, at `flow implemented`/`flow complete`, in
review packages, and in the `/flows`/`/ac` shell modal.

**Round 1** raised five findings against the first commit on the branch
(`f48bcb77d1a197260b660b150c9390eaabb3b3e6`) — two MEDIUM, one unlabeled but
substantive correctness gap, and two lower-severity items. All five were
fixed in the branch's second commit
(`71619891e54c2eaaeb53d36068a0ede7dc384cf4`, "fix(flow): check-ac never
shows a stale verdict as current; bounded git; mixed criteria stay
checkable") before merge:

- **F-001 (major)** — a cached `check-ac` verdict was treated as current by
  both the `/flows` TUI marker and `review ingest`'s `ac-check.md` attachment
  whenever the flow's criteria checksum matched, even if the diff being
  reviewed had moved on since the cache was written — a stale pass/fail
  signal could read as a fresh one on both surfaces.
- **F-002 (major, MEDIUM per the fix's own code comment)** — `git
  diff`/`git merge-base`, spawned by every `check-ac` caller (the CLI, the
  `/flows` freshness check, and `review ingest`'s attachment), had no
  timeout or output cap; a broken remote or a pathological repo could hang
  the command, or an oversized diff could be buffered into memory,
  unbounded.
- **F-003 (major)** — a criterion mixing one checkable clause with a
  not-checkable one (this flow's own AC10 is the real-world case: "Docs
  (…), CI green, `keryx health run` passes, hermetic macOS-safe tests,
  import zones respected" has doc paths and "import zones" a diff CAN
  evidence, alongside "CI green"/"health run" it cannot) became WHOLLY
  not-checkable the moment any one clause matched a marker — silently
  dropping the checkable part from every Jev call and every fact line.
- **F-004 (minor)** — the `/flows`/`/ac` modal's `c` key ran the check as a
  fire-and-forget call with no in-progress state: a second `c` press while
  one check was already running had nothing to stop it, and the modal had
  no way to show the operator a check was in flight or that one had failed.
- **F-005 (minor, LOW per the fix's own code comment)** — a single failed
  Jev batch (a transient network blip, one malformed response) used to
  abort every batch queued after it too, so one bad batch silently degraded
  the WHOLE check to facts-only instead of just the criteria in that batch.

**Round 2** re-read the branch's second commit against the fixes above: all
five are fixed and verified (see `verifications.json` — each claim cites the
merge commit, the exact site fixed, and a locally re-run test suite that is
green). Round 2 **approves**, with one known limitation left open rather
than blocking merge:

- **F-006 (minor, open)** — `NOT_CHECKABLE_MARKERS`'s regexes
  (`src/flow/check-ac.ts`) match a marker phrase (e.g. "CI green", "live
  check") against a criterion clause's raw text with no awareness of
  backticks. The only backtick-aware logic in the file is
  `extractCriterionTokens` (artifact-token extraction, a different
  concern), so a criterion that merely *mentions* a marker phrase as a
  literal/code reference inside backticks — rather than describing an
  actual untestable condition — would still be misclassified
  `not-checkable` and never reach Jev. No test in `check-ac.test.ts` or
  `flow-check-ac.test.ts` exercises this case (the file's only
  backtick-related test, `check-ac.test.ts`, covers token extraction, not
  marker classification). Tracked as follow-up debt, not a merge blocker —
  the flow's own criteria happen not to trip it (verified by AC1's
  confirmation and by `check-ac.test.ts`'s own dogfood tests against this
  flow's real AC text).

PR #723 squash-merged as `510139e64a212f14fecd928d3789652aa83045ed` into
`main` (verified independently via `gh pr view 723
--json mergeCommit,mergedAt,headRefOid,state`: state `MERGED`, head
`d661e0851f63ff387217425f162cdb7d9025155d`); CI was 19/19 (18 success, 1
skipped — "deploy to GitHub Pages", not applicable to a PR build) on the PR
(`gh pr view 723 --json statusCheckRollup`), and `keryx health run` passes
at this head (project score 94, no gate conditions triggered). The five
relevant test files (`src/flow/check-ac.test.ts`,
`src/commands/flow-check-ac.test.ts`, `src/commands/review-ac-check-cli.test.ts`,
`src/tui/inspector-sources.test.ts`, `src/tui/flow-inspector.test.ts`) were
re-run locally in this worktree (checked out at the PR's own head, which is
byte-identical to `origin/main` for every file this review cites — confirmed
via `git diff --stat origin/main d661e085`, which shows no changes to any of
them): 69/69 tests pass, 0 failures.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/commands/review.ts",
    "problem": "A cached `check-ac` result was read back and treated as current by comparing only the flow's `acChecksum` (the criteria half of the cache key), not the diff hash — both the `/flows` TUI's per-criterion marker and `review ingest`'s `ac-check.md` attachment could present a verdict computed against an OLDER diff as if it were current for the diff actually being looked at.",
    "impact": "A reviewer reading a review package, or an operator glancing at the `/flows` sidebar, could see \"3 likely met, 0 not evident\" for a round that had since changed substantially — a stale advisory signal indistinguishable from a fresh one, on the exact surface meant to flag doubt.",
    "suggested_fix": "Compare the FULL cache key (criteria checksum + diff hash, `acCheckCacheKey`) before treating a cached record as fresh, and when freshness can't be computed at all (no recorded head, a git error), still write a short STALE note rather than silently attaching nothing or attaching the stale report unmarked.",
    "evidence": "src/tui/inspector-sources.ts computeAcCheckStaleness (comparing `cache.key !== acCheckCacheKey(flow.acChecksum, diffText)`) and src/commands/review.ts's ingest-attach block (lines 796-838, `fresh = cached.key === acCheckCacheKey(flow.acChecksum ?? \"\", diffText)`, writing a `# Acceptance-criteria check — STALE` file when not fresh). Landed in PR #723, commit 71619891e54c2eaaeb53d36068a0ede7dc384cf4, merged as 510139e64a212f14fecd928d3789652aa83045ed.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/tui/inspector-sources.ts computeAcCheckStaleness — the /flows list-render freshness check",
        "src/commands/review.ts review ingest's ac-check.md attach block (mode === \"ingest\" branch, lines ~796-838)"
      ],
      "enumeration_method": "grepped every call site of `acCheckCacheKey(` across src/ (7 files: definition in check-ac.ts, 4 test files, and these 2 production readers) to confirm the TUI list-render path and the review-ingest attach path are the ONLY two places a cached AC-check result is read back and judged fresh/stale in production code; both now gate on the full key."
    }
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/commands/flow-check-ac.ts",
    "problem": "`defaultGitSpawn`'s `git diff`/`git merge-base` calls had no timeout and no output-size cap. Every caller of `check-ac` — the CLI command, the `/flows` TUI freshness check (run once per flow in a list render), and `review ingest`'s attachment step — routed through it.",
    "impact": "A broken remote, a pathological repo state, or an oversized diff could hang `keryx flow check-ac` (and by extension `flow implemented`/`flow complete`'s advisory notice) indefinitely, or buffer an unbounded amount of diff text into memory; the /flows TUI case is worse because it runs once per flow just to render a list, so one slow `git` process could hold up the whole screen.",
    "suggested_fix": "Bound every `git` spawn with a default timeout and max-buffer cap (killing the process and throwing a distinguishable error on either limit), with the bound overridable per-caller so a latency-sensitive caller like the TUI can ask for a shorter one.",
    "evidence": "src/commands/flow-check-ac.ts: `DEFAULT_GIT_SPAWN_TIMEOUT_MS = 15_000` (line 119), `DEFAULT_GIT_SPAWN_MAX_BUFFER = 8 * 1024 * 1024` (line 123), `GitSpawnLimitError` (the code's own comment labels this a \"MEDIUM review finding\", line 103). Landed in PR #723, commit 71619891e54c2eaaeb53d36068a0ede7dc384cf4, merged as 510139e64a212f14fecd928d3789652aa83045ed.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/flow-check-ac.ts:276 runCheckAc's own gitSpawn dependency (defaults to defaultGitSpawn)",
        "src/tui/inspector-sources.ts:234 resolveDiffAgainstBase(defaultGitSpawn, ...) in the /flows freshness check",
        "src/commands/review.ts:808 resolveIngestDiff(defaultGitSpawn, ...) in review ingest"
      ],
      "enumeration_method": "grepped `defaultGitSpawn` across src/ to enumerate every place this feature spawns `git diff`/`git merge-base`; all three production call sites route through the single bounded implementation, confirmed with no second, unbounded git-spawn path left in the feature."
    }
  },
  {
    "id": "F-003",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/flow/check-ac.ts",
    "problem": "A criterion combining a checkable clause with a not-checkable one became WHOLLY not-checkable the moment any single comma/semicolon-separated clause matched a `NOT_CHECKABLE_MARKERS` entry, dropping the checkable clause's evidence from both the fact lines and the Jev call entirely.",
    "impact": "This flow's own AC10 (\"Docs (…), CI green, `keryx health run` passes, hermetic macOS-safe tests, import zones respected\") is the real-world trigger: \"CI green\"/\"health run\" are not-checkable, but the doc-path and import-zone clauses ARE — before the fix, the whole criterion would have silently skipped Jev and reported not-checkable with no evidence at all for the parts that WERE checkable, a self-inflicted blind spot in the feature's own dogfooding.",
    "suggested_fix": "Split a criterion on `,`/`;`, classify each clause independently, and only mark the whole criterion not-checkable when EVERY clause matches a marker; keep it checkable (with its full original text) the moment one clause does not.",
    "evidence": "src/flow/check-ac.ts classifyNotCheckable/criterionClauses (lines 127-150, \"the criterion is not-checkable only when EVERY clause is — one checkable clause keeps the whole criterion checkable\"); tested at src/flow/check-ac.test.ts:77 (\"a mixed criterion (this flow's own AC10) stays checkable — one checkable clause is enough\") and :83 (\"a criterion whose EVERY comma-separated clause names a marker is wholly not-checkable\"). Landed in PR #723, commit 71619891e54c2eaaeb53d36068a0ede7dc384cf4, merged as 510139e64a212f14fecd928d3789652aa83045ed.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/flow/check-ac.ts classifyNotCheckable (the sole classification function)",
        "src/commands/flow-check-ac.ts:295 the single production call site that decides which criteria ever become Jev items"
      ],
      "enumeration_method": "grepped `classifyNotCheckable(` across src/: one function definition, one production call site (the adapter's checkable/not-checkable split at flow-check-ac.ts:295), and the check-ac.test.ts suite exercising it — confirmed there is no second, unfixed criterion-classification path in the feature."
    }
  },
  {
    "id": "F-004",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/tui/flow-inspector.ts",
    "problem": "The `/flows`/`/ac` modal's `c` key ran `onRunCheck` as a fire-and-forget callback (`void`, not a `Promise`): pressing `c` again while a check was already in flight had nothing stopping a second concurrent run, and the modal had no way to show the operator a check was running or that one had failed.",
    "impact": "An impatient operator hitting `c` twice could trigger two concurrent (and, once opt-in, two separately billed) Jev runs for the same flow with no feedback that the first was still working, and a failed check closed the modal silently instead of showing the error.",
    "suggested_fix": "Make `onRunCheck` return a `Promise<{error?: string} | void>`, show a \"Checking…\" state on the AC tab while it is pending, ignore a second `c` while one is in flight, and render `{error}` in place on failure instead of reopening/closing over it.",
    "evidence": "src/tui/flow-inspector.ts: `onRunCheck` type (lines 195-211, \"Review finding (item 4): returns a `Promise` now, not `void`... ignore a second `c` while one is in flight\"), `formatAcCheckLines`'s \"Checking…\" branch (line 305), src/tui/tui-shell.ts:5893-5901 (`c` handler prints `Checking flow ${item.id}...`). Tested at src/tui/flow-inspector.test.ts:160 (\"presentFlows: `c` shows 'Checking…', ignores a second `c` in flight, and shows the error in the AC tab on failure\"). Landed in PR #723, commit 71619891e54c2eaaeb53d36068a0ede7dc384cf4, merged as 510139e64a212f14fecd928d3789652aa83045ed.",
    "confidence": "high"
  },
  {
    "id": "F-005",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/commands/flow-check-ac.ts",
    "problem": "The `try`/`catch` around Jev batch calls wrapped the ENTIRE batch loop, so one failed batch (a transient network blip, one malformed response) aborted every batch queued after it too — those were never even attempted, just degraded to facts-only along with the failed one.",
    "impact": "A single bad batch could silently degrade the WHOLE check-ac run to facts-only, losing every criterion's Jev-assisted verdict for that run, not just the criteria in the batch that actually failed.",
    "suggested_fix": "Move the `try`/`catch` inside the per-batch loop so batch N's failure says nothing about batch N+1, which still gets its own attempt; keep only the first failure's message (the more likely root cause when several batches fail the same way).",
    "evidence": "src/commands/flow-check-ac.ts lines 347-385 (\"LOW review finding: this used to wrap the WHOLE loop... Caught per batch instead\"). Tested at src/commands/flow-check-ac.test.ts:246 (\"one failed Jev batch degrades only ITS items; the next batch still gets its own attempt\"). Landed in PR #723, commit 71619891e54c2eaaeb53d36068a0ede7dc384cf4, merged as 510139e64a212f14fecd928d3789652aa83045ed.",
    "confidence": "high"
  },
  {
    "id": "F-006",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/flow/check-ac.ts",
    "problem": "`NOT_CHECKABLE_MARKERS`'s regexes (classifyClause, lines 84-113) match a marker phrase against a clause's raw text with no awareness of backticks — the file's only backtick-aware logic is `extractCriterionTokens` (lines 157-172), which is for artifact-token extraction, a different concern from not-checkable classification.",
    "impact": "A criterion that mentions a marker phrase (e.g. \"CI green\", \"live check\") as a literal/code reference inside backticks, rather than as a description of an actual untestable condition, would still be misclassified `not-checkable` and never reach Jev or get its evidence checked — the same silent-evidence-loss shape F-003 fixed for comma-separated clauses, left open for the backtick case.",
    "suggested_fix": "Strip or otherwise exempt backticked spans before running `classifyClause`'s marker regexes, so a criterion quoting a marker phrase as code/literal text is not treated as describing that condition; add a regression test alongside check-ac.test.ts's existing marker-classification suite.",
    "evidence": "src/flow/check-ac.ts classifyClause/NOT_CHECKABLE_MARKERS (lines 84-113) run marker regexes against raw clause text with no backtick handling; the only backtick-aware code in the file is extractCriterionTokens (lines 157-172, a separate concern). No test in check-ac.test.ts or flow-check-ac.test.ts exercises a marker phrase written inside backticks — the file's only backtick test (check-ac.test.ts:111, \"collects backticked tokens, file paths, and keryx command names\") covers token extraction, not not-checkable classification. Noted by the operator as a known limitation at round-2 approval, not a merge blocker.",
    "confidence": "medium"
  }
]
```
