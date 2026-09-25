# Review — flow 330, review-jev-rules: an additional orchestrator reviewer (PR #722)

Two rounds ran against the flow 330 diff (`src/commands/review-jev-rules.ts`,
`src/commands/review-jev-rules-cli.test.ts`, `src/review/jev-rules.ts`,
`src/review/jev-rules.test.ts`, `src/review/jev-rules-cache.ts`,
`src/review/jev-rules-config.ts`, `src/review/conform-tag-cache.ts`,
`src/tui/jev-rules-command.ts` + test, `docs/docs/cli-reference.md`, and both
copies of the `review-jev-rules` bundled skill), which add `review-jev-rules`
as an ADDITIONAL orchestrator reviewer: a CLI-engine (not sub-agent) reviewer
that pairs every changed hunk against every applicable project rule clause
and asks Jev a single "does this hunk violate this clause?" question per
pair, opt-in via `review.jev.rules`.

**Round 1** approved the design and implementation against AC1-AC8 and
AC10. Its one substantive note was not a defect but an improvement
suggestion — a precision lever: the initial live check (AC9, journaled in
`.metaproject/flows/330-.../journal.md`) measured only ~1/10 (10%) precision
on 10 hand-labelled findings from a live run against PR #712/#717 using this
repo's own 41-doc `.metaproject/rules/**` corpus. The journal traced this to
the rule corpus rather than the mechanism: every rule doc lacked
`metadata.paths`/`metadata.stack_requires`, so applicability degraded to
"applies to every changed file," and several of the ten hand-labelled false
positives were process/agent-behaviour rules (commit-message formatting, TDD
workflow, an agent's own prompting standard) paired against a code hunk they
were never meant to describe. Round 1's lever suggestion was to reuse
`review conform`'s own clause-tagging machinery so a clause is only ever
paired against a hunk when it is actually hunk-checkable.

**Precision rework and live re-measurement followed**, landed as two
follow-up commits before round 2:

- **Commit `63da2f78`** ("review-jev-rules — tag-based and category
  filters"): reuses `review conform`'s clause tagging
  (`applyClauseTags`/`buildClauseTagQuestions`/`clauseTagFromChoice`),
  cached by content hash at a jev-rules-specific path
  (`.metaproject/data/review-jev-rules/clause-tags.json`, via
  `conform-tag-cache.ts`) — only a clause tagged `state_kind: "hunk"` and
  `checkable` is ever paired against a hunk, everything else dropped and
  reported (`droppedClauses`). Adds a cheap rule-source category filter
  (`classifyRuleSourceCategory`, `PROCESS_RULE_HEURISTIC_TERMS`) that
  excludes a process/docs rule source before it ever reaches tagging or
  scoring (`excludedSources`), based on explicit frontmatter first, else a
  documented filename/title heuristic.
- **Commit `7ca33bb4`** ("jev-rules spreads its budget over every hunk,
  filters --rules directories, drops template clauses, keeps docs rules to
  docs"): fixes a second live-measured problem — on PR #712 the whole
  `--max-calls` budget had landed on the first hunk (a docs file), and
  process rules passed explicitly via `--rules` skipped the category filter
  entirely (a `--rules` directory now walks and filters exactly like
  auto-discovery; only a `--rules` entry naming one file bypasses it). Hunks
  are now ranked code/tests/docs and the budget spent round-robin with
  per-hunk coverage reported; a docs hunk pairs only with docs rules; an
  unfilled-template clause (`isPlaceholderClauseText`) is dropped before it
  is ever offered a tagging call. Re-measured live against PR #712 after
  these fixes: **38 of 38 applicable hunks reached, 38 Jev calls, $0.0034,
  2 findings** (both a process step inside a code rule) — down from the
  original run's 126 calls / $0.1268 / 121 all-minor findings at ~10%
  measured precision on the pre-filter corpus.

**Round 2** re-read the branch against the round-1 fixes and found the
implementation sound, approving with one small, concrete fix rather than a
blocking finding:

- **F-001 (fixed)** — `isPlaceholderClauseText` (the round-1 fix's own
  template-clause filter) treated any bare `<...>` token as an unfilled
  placeholder, including one written inside backticks as literal code —
  \'Avoid `<script>`.\' or \'Ban `<iframe>`.\' was wrongly dropped as an
  unfilled template rather than kept as a real, checkable rule clause.

Fixed in **commit `8f60bf30`** ("a tag or generic inside backticks is not a
template placeholder"): backtick-fenced spans are stripped before the
placeholder-token regex runs, so a `<...>` a rule author wrote as literal
code inside backticks (`` `<script>` ``, `` `Array<T>` ``) is never
mistaken for an unfilled `<criterion 1>`-style checklist placeholder; a bare
`<...>` outside backticks still counts. A regression test was added
(`src/review/jev-rules.test.ts`, "a tag or generic inside backticks is code,
not a placeholder (review round 2 of PR #722)") asserting both the two
backtick cases stay `false` and a genuine checklist placeholder
(`[x] <criterion 1> — verified by <test>`) still returns `true`. Verified
locally: this test passes (1/1), and the full `src/review/jev-rules.test.ts`
suite passes (54/54).

This is a lighter review than most: round 1 was already an approve whose
only finding was improvement work, not a defect, and round 2's one finding
is a small, already-fixed correctness bug in a filter the round-1 rework
itself introduced — neither rises above `minor`.

PR #722 squash-merged as `b73ef7fd16e4f0a9740972df9040f94c0f0de8fb` into
`main` (verified independently via `gh pr view 722
--json mergeCommit,mergedAt,headRefOid,state`: `state: MERGED`, head
`8f60bf30219a0e9de68bafa597d581fc10ef657c`). CI was 19/19 (18 success, 1
skipped — "deploy to GitHub Pages", not applicable to a PR build) per `gh pr
view 722 --json statusCheckRollup`, and `keryx health run` passes at
`origin/main`\'s current head (project score 94, no gate conditions
triggered).

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "info",
    "file": "src/review/jev-rules.ts",
    "problem": "Round 1's live check (AC9) measured only ~1/10 (10%) precision on 10 hand-labelled findings from a run against this repo's own 41-doc .metaproject/rules/** corpus on PR #712/#717 -- most false positives came from process/agent-behaviour rules (commit-message formatting, TDD workflow, an agent's own prompting standard) with no declared per-file applicability being paired against a code hunk they were never meant to describe.",
    "impact": "Without a precision lever, review-jev-rules would surface mostly noise on this repo's own rule corpus, diluting the orchestrator's merged findings with low-value minor findings from category-mismatched clauses.",
    "suggested_fix": "Reuse review conform's own clause-tagging machinery (applyClauseTags/buildClauseTagQuestions/clauseTagFromChoice) so only a clause tagged state_kind: \"hunk\" and checkable is ever paired against a hunk, plus a cheap rule-source category filter (code/process/docs) applied before clause extraction.",
    "evidence": "Journal entry .metaproject/flows/330-2026-09-25-review-jev-rules-an-additional-orchestra/journal.md (2026-09-25T14:10:00.000Z): 136 real Jev calls, 126 findings all minor, 10 hand-labelled (1 true positive, 1 borderline, 8 false positives), several explicitly identified as process-rule/code-hunk category mismatches.",
    "confidence": "high"
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/review/jev-rules.ts",
    "problem": "isPlaceholderClauseText (the round-1 rework's own template-clause filter) treated any bare `<...>` token as an unfilled authoring placeholder, including one written inside backticks as literal code (`Avoid \\`<script>\\`.`, `Ban \\`<iframe>\\`.`), so a real, checkable rule clause naming an HTML tag or a generic type was wrongly dropped before it ever reached tagging or scoring.",
    "impact": "A legitimate security/coding rule clause that happens to name a tag or generic inside backticks (e.g. a rule banning a specific HTML element) would silently never be checked by review-jev-rules, with no error and no entry under droppedPlaceholderClauses distinguishing it from an actual unfilled template.",
    "suggested_fix": "Strip backtick-fenced spans from the clause text before running the placeholder-token regex, so a `<...>` inside backticks is treated as code the rule names rather than an unfilled `<criterion 1>`-style placeholder.",
    "evidence": "Fixed in commit 8f60bf30219a0e9de68bafa597d581fc10ef657c (PR #722, review round 2): src/review/jev-rules.ts replaces the placeholder-token match with a version that strips backtick-fenced spans first. Regression test in src/review/jev-rules.test.ts (\"a tag or generic inside backticks is code, not a placeholder (review round 2 of PR #722)\") passes locally: 1/1, and the full suite passes 54/54 (bun test src/review/jev-rules.test.ts).",
    "confidence": "high"
  }
]
```
