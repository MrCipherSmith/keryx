# Review — flow 332, Jev reviewers for functional review (PR #726)

Two rounds ran against the flow 332 diff (`src/review/jev-risk.ts`,
`src/review/jev-scenarios.ts`, `src/commands/review-jev-risk.ts`,
`src/commands/review-jev-scenarios.ts`, `src/tui/jev-risk-command.ts`,
`src/tui/jev-scenarios-command.ts`, the bundled and `.metaproject` mirrors of
`review-jev-risk`/`review-jev-scenarios` `SKILL.md`, plus tests and docs),
which add `keryx review jev-risk` (a deterministic-facts-first risk map,
ranked, with a Jev `noul` per risk dimension per hunk) and
`keryx review jev-scenarios` (a functional review of the user scenarios a
diff likely affects) as additional, opt-in reviewers.

**Round 1** raised three findings against the branch's first commit — all
major or minor, none blocker. All three were fixed in the branch's next
commit, `c134da4a8b9abf1367bf48b3be6e1a22e71375c0`, before the round-2 pass:

- **F-001 (major)** — `selectRiskHunks` scored every retained hunk against
  all five risk dimensions with no check for hunk type, so a `.md`/`.txt`
  prose hunk reached the same Jev risk questions as code. Live-checked
  against PR #712, all four findings the pre-fix run raised were
  `cli-reference.md` prose hunks scored high on `public-api` — Jev correctly
  answered whether the *text* describes a public API, not whether the *hunk*
  is a code risk to one — pure duplicate noise on top of the code hunk
  elsewhere in the same diff that actually enacts the change, and it burned
  `--max-calls` budget a real risk hunk needed (the provider-catalog cache
  concurrency write was reached and scored 0.84 only after the fix).
- **F-002 (major)** — `computeHunkRiskFacts` set `hasNearbyTest` from
  directory/stem proximity alone (`nearbyTestFiles.length > 0`), with no
  check that the nearby test's own diff text actually exercised the hunk's
  touched symbols. Live-checked against PR #712: `providers.ts:723-733`'s
  new `boundedJsonBody` (security dimension, p=0.89) went completely
  unflagged because an unrelated hunk in `providers.test.ts` happened to be
  proximate — a real risk silently dropped, the exact failure mode the tool
  exists to prevent.
- **F-003 (minor)** — `computeScenarioFacts` counted any scenario's link to
  a diff-touched file as "touched" regardless of how many other discovered
  scenarios linked the same file, so a widely-referenced file (e.g.
  `tui-shell.ts`, linked from nearly every "how to" doc section) marked most
  of those unrelated scenarios as likely-affected, burying genuinely
  affected scenarios in noise on the `/scenarios` checklist.

**Round 2** re-read the branch against those fixes and raised two more
findings — both introduced by, or exposed alongside, the round-1 fix. Both
were fixed in the branch's next commit,
`84e7ddad524c1f0976824450bafdbaf04d7fcef2`:

- **F-004 (major)** — the F-002 fix (`testHunkEvidence`) matched a hunk's
  touched exported symbols against the nearby test file's raw diff text,
  including comment text: a test hunk that only *added* a comment such as
  `// still need to cover boundedJsonBody` satisfied the identifier match
  and was accepted as coverage evidence, silently defeating the false-negative
  fix F-002 had just landed for.
- **F-005 (minor)** — the F-001 fix's `isNonCodeHunk` excluded every `.txt`
  path from risk scoring outright, which also excluded `.txt`
  fixture/snapshot/testdata files — test data whose change can carry real
  behavioural risk, not prose, and so should stay scored.

Round 2 approves with no findings open. A subsequent merge of `origin/main`
into the branch (merge commit `6d750f3403c216dc07ac27a28f4fdfa4f71f8cb9`,
head of PR #726) was reviewed for conflict-resolution correctness and
approved — no functional changes beyond the merge itself.

PR #726 squash-merged as `637156d3641d4524cee3d1e0dbc8198b2e4a597f` into
`main`; CI was 19/19 (18 success, 1 skipped — "deploy to GitHub Pages", not
applicable to a PR build) on the PR, and `keryx health run` passes at this
head (project score 94, no gate conditions triggered).

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/review/jev-risk.ts",
    "problem": "Before the fix, `selectRiskHunks` scored every retained hunk — including `.md`/`.txt` prose — against all five risk dimensions, with no filter for hunk type, so a documentation hunk reached the same Jev risk questions as code.",
    "impact": "Live-checked against PR #712, all four findings the pre-fix run raised were `cli-reference.md` prose hunks scored high on `public-api`: Jev correctly answered whether the TEXT describes a public API, not whether the HUNK is a code risk to one — pure duplicate noise on top of the code hunk elsewhere in the same diff that actually enacts the change — and it burned `--max-calls` budget a real risk hunk needed (the provider-catalog cache concurrency write was reached and scored 0.84 only after the fix).",
    "suggested_fix": "Exclude non-code (`.md`/`.txt`) hunks from `selectRiskHunks` before applying the `--max-calls` budget, reporting them separately as \"not a code hunk\" rather than scoring them.",
    "evidence": "The pre-fix `selectRiskHunks` sliced `regions` directly into `selected`/`skipped` with no filter for hunk type; the live run against PR #712 produced 4 findings, all against `cli-reference.md` prose hunks.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/jev-risk.ts selectRiskHunks — the sole site that turns retained ScopedRegion[] into hunks scored against the risk dimensions"
      ],
      "enumeration_method": "read every caller of selectRiskHunks and every site that scores a ScopedRegion against RISK_DIMENSIONS in jev-risk.ts/review-jev-risk.ts — selectRiskHunks is the only gate before scoring, so it is the class's only member"
    }
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/review/jev-risk.ts",
    "problem": "`computeHunkRiskFacts` set `hasNearbyTest: nearbyTestFiles.length > 0` — directory/stem proximity alone — with no check that the nearby test's own diff text actually exercised the hunk's touched symbols.",
    "impact": "Live-checked against PR #712: `providers.ts:723-733`'s new `boundedJsonBody` (security dimension, p=0.89) went completely unflagged because an unrelated hunk in `providers.test.ts` happened to be proximate in the same diff — a real risk silently dropped, the exact failure mode the tool exists to prevent.",
    "suggested_fix": "Require the nearby test's own changed text to mention one of the hunk's touched exported symbols, or import the hunk's module by path stem, before treating it as evidence (`testHunkEvidence`); keep proximity itself as a reported fact only (`nearbyTestFiles`), not as sufficient grounds to suppress a finding.",
    "evidence": "computeHunkRiskFacts derived `hasNearbyTest` from `nearbyTestFiles.length > 0` with no inspection of the nearby test's own text.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/jev-risk.ts computeHunkRiskFacts — the only site that derives hasNearbyTest from nearbyTestFiles"
      ],
      "enumeration_method": "grepped every assignment to hasNearbyTest in jev-risk.ts; one site"
    }
  },
  {
    "id": "F-003",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/review/jev-scenarios.ts",
    "problem": "`computeScenarioFacts` counted a scenario's link to a diff-touched file as \"touched\" regardless of how many other discovered scenarios linked the same file, so a widely-referenced file (e.g. tui-shell.ts, linked from nearly every \"how to\" doc section) marked most of those unrelated scenarios as likely-affected.",
    "impact": "The `/scenarios` manual-check list and reviewer findings would be dominated by scenarios whose only \"evidence\" is that they happen to mention a popular file, burying the scenarios genuinely affected by the diff under noise.",
    "suggested_fix": "Down-weight a link once its fan-in across the whole discovered scenario set exceeds a threshold (`SCENARIO_LINK_FANOUT_THRESHOLD = 5`); above it, only count the link when the scenario's own text names one of the linked file's touched exported symbols (`isTouchedLinkSignificant`).",
    "evidence": "computeScenarioFacts filtered touchedLinks on `changed.has(link)` alone, with no fan-in weighting.",
    "confidence": "high"
  },
  {
    "id": "F-004",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/review/jev-risk.ts",
    "problem": "The F-002 fix (`testHunkEvidence`) matched a hunk's touched exported symbols against the nearby test file's raw diff text, including comment text — a test hunk that only added a comment such as `// still need to cover boundedJsonBody` satisfied the identifier match and was accepted as evidence.",
    "impact": "Review round 2 of PR #726 found this suppressed a real finding: a TODO-style comment naming a symbol reads as coverage even though no test code runs it, silently defeating the exact false-negative fix F-002 had just landed for.",
    "suggested_fix": "Strip comment text (line `//` and block `/* */`/`*`-continued) from the test file's text before matching identifiers or import paths.",
    "evidence": "testHunkEvidence ran mentionsIdentifier directly against the unmodified testFileText, with no comment stripping.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/jev-risk.ts testHunkEvidence — the sole function that decides whether a nearby test's text counts as coverage evidence for a risk hunk"
      ],
      "enumeration_method": "testHunkEvidence is the only consumer of the raw nearby-test diff text for identifier matching in jev-risk.ts; jev-scenarios.ts's isTouchedLinkSignificant matches scenario prose (wiki/PRD/README text), not a diff's own comment-bearing text, so it is a different shape and not a member of this class"
    }
  },
  {
    "id": "F-005",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/review/jev-risk.ts",
    "problem": "The F-001 fix's `isNonCodeHunk` excluded every `.txt` path from risk scoring outright, which also excluded `.txt` fixture/snapshot/testdata files — test data whose change can carry real behavioural risk, not prose.",
    "impact": "A `.txt` fixture under fixtures/testdata/snapshots changed in the same diff as an unrelated docs hunk would be silently dropped from the risk map instead of scored — another category of missed detection introduced by the F-001 fix itself.",
    "suggested_fix": "Carve fixtures/testdata/snapshots directories back out of isNonCodeHunk's exclusion so `.txt` files under them stay scored.",
    "evidence": "isNonCodeHunk returned NON_CODE_HUNK_RE.test(path) for any .md/.txt path with no directory carve-out.",
    "confidence": "high"
  }
]
```
