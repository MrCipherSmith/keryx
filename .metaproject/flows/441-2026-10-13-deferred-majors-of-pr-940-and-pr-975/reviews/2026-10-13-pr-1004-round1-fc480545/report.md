# PR 1004 — review round 1

Verdict: request-changes

Head reviewed: fc480545d04701e4fd4279547db60fb1eca84c74
Merge base: 0629e797578c4cd11a0224ec8c1d474095885e29
Review id: 2026-10-13-pr-1004-round1-fc480545
Orchestrator: vantage-review (generic engine review-orchestrator). Mode: all, deep round, mutation pass, severity-audit. Round 1 of 3.

## Summary

The replay is correct on the data it covers. The legacy parser is byte-identical to the pre-PR-997 `parseReviewResult`; two runs of the replay are identical and match the checked-in report; all 11 `fence-inner-backticks` rows are true per file; the PR does not touch the parser (4 files: `replay.ts`, `replay.test.ts`, `legacy-result-parser.ts`, `replay-report.md`).

Three majors need fixing before merge: the repository test reads gitignored local files and is red on any checkout that has run a shell-host review (F-001); the replay CLI is untested (F-002); two branches have no assertion (F-003). F-002 and F-003 are minors that severity-audit raised because each cites an executed surviving mutant on a changed file. Four minors and one info follow.

Counts: 0 blockers, 3 majors, 4 minors, 1 info.

## Claims checked independently

- Legacy parser verbatim: the body equals `parseReviewResult` in `src/review/ledger.ts` at `249bc59b` (parent of the PR 997 commit `141c8852`), line for line; only the export name and the header comment differ.
- Parser not tuned: `ledger.ts` and `src/commands/review-ledger.ts` are untouched. Scope: 4 files, 389 lines.
- Determinism: two runs are byte-identical and equal `replay-report.md` (19 files, 7 same, 12 differences).
- Tests: `bun test src/review/replay.test.ts` passes with 20 tests; the PR body says 18.
- Reasons per file: each of the 11 `fence-inner-backticks` rows has an old lazy capture that is invalid JSON while the true block parses, with a finding count equal to the new parser's; the 7 same rows are deep-equal. The `status-only-fragment` row is true as far as it goes and incomplete (F-004).
- Mutation claim not reproduced as stated: the PR says 28 killed, 1 survived on a spec that is not in the package. A fresh 41-mutant spec gives killed 34, survived 7 (`research-evidence/mutation-1.md`). Survivors M04, M33, M38, M39 are equivalent; M24, M37, M40 are real gaps (F-002, F-003).
- AC16 point by point: met for tracked `raw/` (two directories, 19 files); met for same-or-listed; "decided file by file" is carried per cause, not per file (F-006); "no undecided row" met today; "parser not tuned" met.

## Findings by severity

Blocker: none.

Major: F-001 (untracked `data/review` raws walked), F-002 (CLI untested, M37), F-003 (M40 and M24 survive).

Minor: F-004 (status-only reason incomplete), F-005 (PR body stale), F-006 (decisions keyed by cause), F-007 (outcome-string comparison).

Info: F-008 (symlinks, constant spacing, importer rule).

## Questions

1. Did polls 161 and 162 show the operator each of the 12 files, or only the two causes? Answer recorded by the caller: the polls decided the two causes and the file counts; the replay applies them to the listed files (F-006 is therefore also a process note).
2. Is `.metaproject/data/review` meant to be in the replay? Its `raw/` is gitignored, so it can never hold a tracked closed round. Decision: drop it from `parents` (F-001).
3. Operator re-asked on F-004: poll 163 accepted the verifier row with the corrected reason (file kept with no result, one ledger gap).

## Pre-existing

- `loadRaws` decides "reviewer reply" by the text `REVIEW_RESULT` anywhere in the body, so a file that only quotes the marker is kept as a reviewer raw and becomes a gap.
- M04 and M33 are equivalent; not findings.

## Verified clean

- Legacy parser equals the pre-PR-997 parser; only `replay.ts` imports it.
- Replay is deterministic and read-only by default; `--write` writes one file.
- `classify` returns `unclassified` outside the two causes.
- The `.txt` filter, `raw` name, two parents, `drivers` and `research-evidence` skips and path ordering are pinned (M23, M25 to M32 killed).

## Not run

- Vantage overlays: none selected (CLI TypeScript plus one markdown file).
- review-regression: scope B is empty (3 changed code files, 0 dependents).
- Blast-radius `changedFiles` included 4 uncommitted non-code worktree files; all `not-a-graph-node`.
- Full suite and lint were not rerun (PR is CI-green on this head). Cross-family review was not run.

## Routing audit

graph_used: yes; wiki_used: no (not-relevant); ctx_used: yes; raw_rg_used: no.

## keryx:findings

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "vantage-review (deep pass)",
    "severity": "major",
    "problem": "`replayRepository` walks `.metaproject/data/review` besides `.metaproject/flows`, and `rawDirs` reads whatever directories exist on disk. `.gitignore` line 115 (`.metaproject/data/**/raw/`) ignores that path, and the review-orchestrator skill tells shell-host reviewers to save their replies to `.metaproject/data/review/raw/<reviewer>.txt`. Reproduced: a temp repository with only `.metaproject/data/review/raw/r.txt` yields that file as a replayed row. The repository test `every tracked raw reply is replayed and the checked-in report lists exactly the differences` compares the checked-in report to the rendered one, so any local file there changes `Files replayed` and the same-file list and fails the test. The test title and the report text (`Only tracked raw/ directories ... are replayed`) say tracked.",
    "impact": "The test is green in CI and red on every checkout that has run a shell-host review round, until the raws are deleted. A developer chasing it will regenerate the report, which commits a file list that depends on one machine and makes the report disagree with CI.",
    "suggested_fix": "Replay tracked files only: list them with `git ls-files` (fall back to the walk only inside a test fixture), or drop `.metaproject/data/review` from `parents` (two tracked directories remain, so the AC16 set is unchanged). Add a test with an untracked or ignored raw that expects it to be left out, and keep the report text and test title true.",
    "evidence": "reproduction: replayRepository on a temp root holding .metaproject/data/review/raw/r.txt returns [\".metaproject/data/review/raw/r.txt\"]; git check-ignore -v reports .gitignore:115 for that path; git ls-files shows raw/ only under the two PR 997 round directories",
    "confidence": "high",
    "file": "src/review/replay.ts",
    "quote": "const parents = [\".metaproject/flows\", \".metaproject/data/review\"];",
    "pre_existing": false,
    "location_class": "changed",
    "class_scope": {
      "sites": [
        "replay.ts rawDirs parents list",
        "replay.test.ts walk test that puts .metaproject/data/review/r3/raw in the fixture and expects it replayed",
        "replay.test.ts repository test title 'every tracked raw reply'",
        "replay-report.md line 7 'Only tracked raw/ directories'"
      ],
      "enumeration_method": "keryx ctx rg for `data/review` and `tracked` in src/review/replay.ts, replay.test.ts and replay-report.md; reproduction on a temp root."
    }
  },
  {
    "id": "F-002",
    "reviewer": "vantage-review (mutation pass)",
    "severity": "major",
    "problem": "The CLI of replay.ts has no test. `const root = process.cwd();` is the replayed root; mutant M37 (`path.resolve(process.cwd(), \"..\")`) survived all 20 tests. Run from a subdirectory (or from anywhere but the repository root) the documented `bun src/review/replay.ts --write <path>` finds no `raw/` directory, renders `Files replayed: 0`, and writes that report. The repository test derives its root from `import.meta.dir`, so it does not cover the CLI. M38 (no `--write` target guard) and M39 (`Bun.write(target, ...)`) also survive and are equivalent: the guard's absence still throws a TypeError from `path.resolve`, and `root` equals the cwd.",
    "impact": "The regenerate command named in the report header is the maintenance path of the file the repository test compares against; a wrong cwd silently produces a bad report that is then committed to match a different tree.",
    "suggested_fix": "Derive `root` from `import.meta.dir` as the test does (or from `git rev-parse --show-toplevel`), refuse to write a report with zero files, and add one test that spawns `bun src/review/replay.ts --write <tmp>` from a temp cwd and checks the output file.",
    "evidence": "mutant:M37-cli-root-parent",
    "confidence": "high",
    "file": "src/review/replay.ts",
    "quote": "const root = process.cwd();",
    "pre_existing": false,
    "location_class": "changed",
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-1.json#M37-cli-root-parent"
    },
    "class_scope": {
      "sites": [
        "replay.ts CLI root: `const root = process.cwd();` (M37)",
        "replay.ts CLI write: `--write` target guard and `Bun.write(path.resolve(root, target), report)` (M38, M39, both equivalent)"
      ],
      "enumeration_method": "mutation pass: M37 to M39 on the import.meta.main block survived (mutation-1.json); no test in replay.test.ts spawns the file."
    }
  },
  {
    "id": "F-003",
    "reviewer": "vantage-review (mutation pass)",
    "severity": "major",
    "problem": "Two branches no assertion reaches. In `legacy-result-parser.ts`, `start = end;` (skip the matched object so a nested object is not read again) survived as M40: no test and none of the 19 replayed files has a status-bearing object nested in another. The file header names 'it nests' as one of the three behaviours the replay depends on. In `replay.ts`, `entry !== \"node_modules\" &&` survived as M24; drivers and research-evidence skips are tested, node_modules is not.",
    "impact": "The only property the legacy file has is that it equals the old parser. A later edit to the nesting rule changes the old side of the replay for any future raw without a test failing; the report equality test stays green because no current file exercises it.",
    "suggested_fix": "Add one legacy-parser test with a bare object that nests a status-bearing object (expects the outer one, then the next sibling), and a walk test with `node_modules/raw/x.txt`. Consider a pinned hash of the function text so the verbatim property itself is tested.",
    "evidence": "mutant:M40-legacy-nested-last-status",
    "confidence": "high",
    "file": "src/review/legacy-result-parser.ts",
    "quote": "start = end;",
    "pre_existing": false,
    "location_class": "changed",
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-1.json#M40-legacy-nested-last-status"
    },
    "class_scope": {
      "sites": [
        "legacy-result-parser.ts nested-object skip `start = end;` (M40)",
        "replay.ts rawDirs `entry !== \"node_modules\"` skip (M24)"
      ],
      "enumeration_method": "mutation pass: M40 and M24 survived, M41, M25 and M26 killed (mutation-1.json)."
    }
  },
  {
    "id": "F-004",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "The stated reason for the `status-only-fragment` row is incomplete. The report says the file holds a verifier envelope 'which `loadRaws` already ignored as a non-reviewer result. The new parser returns none.' Under the new parser `loadRaws` keeps PR 997 round 3 `raw/review-verifier.txt` with no result (its body contains REVIEW_RESULT, so `isReviewerReply` is true) instead of listing it in `ignored`, and `buildLedger` reports `raw/review-verifier.txt: no parseable REVIEW_RESULT block` as a gap. Reproduced with `loadRaws` on that package: raws include `raw/review-verifier.txt (NO RESULT)`, ignored is empty.",
    "impact": "This is the one row where an old result is lost, which is the case AC16 exists for. The operator accepted it in poll 162 on a reason that says nothing changed downstream, when the ledger of a closed round now carries a gap it did not before.",
    "suggested_fix": "State the downstream effect in the cause text (kept with no result, one ledger gap) and tell the operator before the merge; if that is unwanted, the fix belongs to the parser or `loadRaws` in a separate PR, not here.",
    "evidence": "loadRaws run on 2026-10-13-pr-997-round3-07730d87; src/commands/review-ledger.ts lines 92-103; src/review/ledger.ts line 331",
    "confidence": "high",
    "file": "src/review/replay.ts",
    "quote": "which `loadRaws` already ignored as a non-reviewer result",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "F-005",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "The PR body disagrees with the head. It says 18 tests (the file has 20), 'every row's decision stays `undecided` until the operator rules file by file' (the head records the two causes as accepted by polls 161 and 162), keeps the checkbox 'Operator decisions on the 12 rows' unchecked, says 'every tracked raw/ reviewer reply' (see F-001), and reports 28 killed and 1 survived on a mutation spec that is not in the repository. A fresh 41-mutant spec gives 34 killed and 7 survived, of which M04, M33, M38 and M39 are equivalent and M24, M37 and M40 are gaps.",
    "impact": "The reader who merges on the PR text believes the report still has undecided rows and the test count, mutation total and equivalence claim they were told.",
    "suggested_fix": "Update the PR body to the head: 20 tests, decisions recorded with their polls, the unchecked box resolved, and the mutation spec committed beside the report or the figures restated.",
    "evidence": "gh pr view 1004 body against replay.test.ts (20 tests) and mutation-1.md (41 mutants)",
    "confidence": "high",
    "file": "src/review/replay.test.ts",
    "quote": "describe(\"replayRepository\", () => {",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "F-006",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "`CAUSE_DECISIONS` maps a cause to a decision string and `renderReplayReport` writes `CAUSE_DECISIONS[row.cause]` for every differing row. Any future raw that the classifier assigns to `fence-inner-backticks` or `status-only-fragment` is printed `accepted (operator, poll 161, ...)` without a poll, and the repository test (it only rejects `unclassified`) stays green. AC16 says every difference is decided file by file and the report has no undecided row.",
    "impact": "The gate AC16 describes cannot fire for the two known causes. The classifier's predicates are broad enough (an old parse failure plus a broken last capture) to cover a file that failed for another reason.",
    "suggested_fix": "Key the decision by file and sha256 (the row already carries both) in a checked-in table, render `undecided` for any row not in it, and have the test fail on undecided.",
    "evidence": "replay.ts lines 18-23 and 114; replay.test.ts 'a difference the classifier does not explain stays undecided' tests only the unclassified path",
    "confidence": "medium",
    "file": "src/review/replay.ts",
    "quote": "\"fence-inner-backticks\": \"accepted (operator, poll 161, 2026-10-13)\",",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "F-007",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "`replayRaw` decides same or different by comparing two outcome strings (`reviewer|status|f=<n>|reviewer-result=<bool>`). AC16 says 'returns the same result as before'. A new parser that returned different findings with the same count, or a different `status` in one finding, would be counted as same. For the 19 files on this head the 7 same rows are deep-equal (checked), so the report is right today.",
    "impact": "The replay is the evidence for AC16 and for any later parser change; it cannot detect a change of content.",
    "suggested_fix": "Compare `JSON.stringify` of the two parsed results (or a deep equality) for `same`, and keep the outcome string only for display.",
    "evidence": "replay.ts lines 27-32 and 55-57; deep-equal check of the 7 same rows run on this head",
    "confidence": "medium",
    "file": "src/review/replay.ts",
    "quote": "const same = before === after;",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "F-008",
    "reviewer": "vantage-review (deep pass)",
    "severity": "info",
    "problem": "`rawDirs` follows symlinks (`statSync`) with no cycle guard, so a symlink to an ancestor under `.metaproject/flows` ends in `ELOOP` or an unbounded walk. `const LABELLED =/```REVIEW_RESULT...` lacks a space after `=`. The legacy file header says `replay.ts` (and its test) are the sole importers; nothing enforces it.",
    "impact": "Low: the walk is a developer tool over a tree the repository controls.",
    "suggested_fix": "Use `lstatSync` or `readdirSync(..., { withFileTypes: true })` and skip symbolic links; format the constant; add a source-audit test that only replay.ts and replay.test.ts import legacy-result-parser.",
    "evidence": "replay.ts lines 25 and 79; keryx ctx rg legacy-result-parser over src shows replay.ts and replay.test.ts only",
    "confidence": "medium",
    "file": "src/review/replay.ts",
    "quote": "if (!statSync(full).isDirectory()) continue;",
    "pre_existing": false,
    "location_class": "changed"
  }
]
```
