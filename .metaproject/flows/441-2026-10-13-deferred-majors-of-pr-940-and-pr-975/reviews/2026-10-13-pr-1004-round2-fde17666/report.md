# PR 1004 — review round 2

Verdict: request-changes

Head reviewed: fde176665b5b5aa9c08920f46d4d3395af074b84 (code equals eeb0816c)
Merge base: 0629e797578c4cd11a0224ec8c1d474095885e29
Review id: 2026-10-13-pr-1004-round2-fde17666
Orchestrator: vantage-review (generic engine review-orchestrator). Mode: all, deep round, mutation pass, severity-audit. Round 2 of 3.

## Summary

All eight round-1 findings (F-001 to F-008) are fixed. The fixes introduced two majors with a narrow trigger (a direct `bun test` with `GIT_DIR` exported, or a failing `git ls-files`) and eight minors. Neither major affects `keryx test run` or a clean CI checkout. The 11 inner-backtick differences (poll 161) and the verifier status-only difference (polls 162 and 163) are carried faithfully in the report.

Counts: 0 blockers, 2 majors, 8 minors.

## Round-1 disposition

F-001 closed (tracked files via `git ls-files`, walk is a fallback; residual R2-02). F-002 closed (CLI root from `import.meta.dir`, zero rows throw, spawn tests). F-003 closed (N43 killed). F-004 closed (cause text names the kept-with-no-result file and the one ledger gap, polls 162 and 163). F-005 closed (PR body). F-006 closed (decisions keyed by file and hash; residual R2-09). F-007 closed (outcome equality and deep equality; R03 equivalent). F-008 closed for leaf links (residual R2-06).

## Poll 161, 162 and 163 carriage

`DECISIONS` has 12 entries for the 12 differing rows: 11 name poll 161, the PR 997 round 3 `review-verifier.txt` row (hash fcbf6b25c7c4) names polls 162 and 163. The report names the one residual gap: `loadRaws` keeps the file with no result and `ledger build` records "no parseable REVIEW_RESULT block". The report is byte-identical to a fresh run. `src/review/ledger.ts` is untouched; the legacy parser equals `parseReviewResult` at 249bc59b.

## Mutation pass

59 mutants (N01 to N45 from round 1 plus R01 to R14): 56 killed, 3 survived, 0 timeout, 0 invalid. N34 (`ls-files` status ignored) is a real gap (R2-02). R01 and R03 are equivalent. Files: `research-evidence/mutants-r2.json`, `mutation-1.json`, `mutation-1.md`.

## Pre-existing

- The legacy parser is quadratic on pathological input (frozen copy; the largest tracked raw is 11 KB).
- `loadRaws` treats any body that quotes REVIEW_RESULT as a reviewer reply.

## Verified clean

- `git ls-files -z -- <pathspec>` is an argv array, NUL separated; odd file names are handled.
- Tracked symlinks are skipped; the CLI root does not depend on cwd.
- No catastrophic backtracking in `LABELLED`; 33 tests in about 380 ms.

## Not run

- review-regression (scope B empty, graph predates the files); stack-gated and path-gated reviewers; no Vantage overlay.
- `keryx review ingest` and `complete` are the caller's steps.

## Routing audit

graph_used: no (not-relevant); wiki_used: no (not-relevant); ctx_used: yes; raw_rg_used: no.

## keryx:findings

```json keryx:findings
[
  {
    "id": "R2-01",
    "reviewer": "vantage-review (deep pass)",
    "severity": "major",
    "problem": "trackedFiles in replay.ts and the git helper and git init in replay.test.ts spawn git with the inherited environment. GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE exported by a hook or wrapper redirect rev-parse, ls-files and the fixture add and commit to another repository.",
    "impact": "A direct bun test (not through keryx test run) with GIT_DIR exported commits the fixture files into the repository GIT_DIR names and fails 9 of 33 tests with ENOENT at lstatSync. src/lib/git-env.ts documents the same incident (246 wrong-author reflog entries). keryx test run and the pre-push path are scrubbed and safe; this was introduced by eeb0816c.",
    "suggested_fix": "Pass env: withoutGitDiscoveryOverrides(process.env) to both spawnSync calls in replay.ts, to the test git helper and the git init call, and to the CLI spawn.",
    "evidence": "Reproduced by five reviewers and the verifier (V1): GIT_DIR=<disposable>/.git bun test src/review/replay.test.ts gave 24 pass 9 fail and a commit tracked in the disposable repo; without GIT_DIR 33 pass. src/testing/service.ts:932-937 scrubs for keryx test run.",
    "confidence": "high",
    "file": "src/review/replay.ts",
    "quote": "const top = spawnSync(\"git\", [\"-C\", root, \"rev-parse\", \"--show-toplevel\"], { encoding: \"utf8\" });",
    "pre_existing": false,
    "location_class": "changed",
    "class_scope": {
      "sites": [
        "replay.ts trackedFiles rev-parse spawnSync",
        "replay.ts trackedFiles ls-files spawnSync",
        "replay.test.ts git helper (add, commit)",
        "replay.test.ts git init call",
        "replay.test.ts CLI spawn from another cwd",
        "replay.test.ts CLI --write spawn"
      ],
      "enumeration_method": "keryx ctx rg for spawnSync and Bun.spawn in src/review/replay.ts and replay.test.ts; compared with the callers of withoutGitDiscoveryOverrides in src/lib/git-env.ts."
    }
  },
  {
    "id": "R2-02",
    "reviewer": "vantage-review (deep pass)",
    "severity": "major",
    "problem": "A non-zero exit of git ls-files makes trackedFiles return undefined, and replayRepository then silently walks the directory, including untracked and gitignored raws. rev-parse can succeed while ls-files fails (corrupt index). No test exercises a failing ls-files and the report does not say which mode produced it.",
    "impact": "The F-001 guarantee (only tracked raws are replayed) is lost without any message; a local untracked raw is replayed into the report or fails the repository test.",
    "suggested_fix": "Treat a git failure inside a real checkout as an error, or record the mode used in the report; add a test with a garbage .git/index that expects the specified behaviour.",
    "evidence": "mutant:N34-ls-files-status-ignored survived (mutation-1.json#N34-ls-files-status-ignored). Verified (V4): with garbage in .git/index, ls-files exits 128 and rev-parse exits 0; the driver returned both the tracked and the untracked file without throwing.",
    "confidence": "high",
    "file": "src/review/replay.ts",
    "quote": "if (listed.status !== 0) return undefined;",
    "pre_existing": false,
    "location_class": "changed",
    "class_scope": {
      "sites": [
        "replay.ts trackedFiles: ls-files non-zero status returns undefined",
        "replay.ts trackedFiles: rev-parse failure or toplevel mismatch returns undefined",
        "replay.ts replayRepository: `?? walkFiles(...)` fallback"
      ],
      "enumeration_method": "reading trackedFiles and replayRepository in replay.ts; mutation pass N34 survived, N35 to N38 on the other early returns were killed (mutation-1.json)."
    }
  },
  {
    "id": "R2-03",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "replayRepository calls lstatSync on every path git ls-files lists. A tracked raw deleted from the working tree but not staged is still listed, so lstatSync throws ENOENT and the whole replay fails.",
    "impact": "After rm of a tracked raw, the repository test and the CLI crash with a bare ENOENT until the deletion is staged. A clean CI checkout is unaffected.",
    "suggested_fix": "Skip paths that no longer exist (catch ENOENT in the symlink filter) and add a test for an unstaged deletion.",
    "evidence": "Verified (V2): repo with committed a.txt and b.txt, rm b.txt unstaged, the driver printed THROWS ENOENT lstat .../raw/b.txt; git ls-files -z still lists both.",
    "confidence": "high",
    "file": "src/review/replay.ts",
    "quote": ".filter((relative) => !lstatSync(path.join(root, relative)).isSymbolicLink())",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "R2-04",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "The Old and New outcome strings contain the pipe character and are written unescaped into markdown table cells, so each differing row has 9 cells against a 6-column header.",
    "impact": "The checked-in replay-report.md table renders broken on GitHub: the New outcome is split across cells and the Cause and Decision columns are shifted.",
    "suggested_fix": "Escape the pipe in table cells (or render outcomes so they contain none), regenerate replay-report.md and update the equality test's expectation.",
    "evidence": "Verified (V3): rows 13-24 of replay-report.md each split into 9 cells on unescaped pipes; the New outcome has 3 pipes.",
    "confidence": "high",
    "file": "src/review/replay.ts",
    "quote": "| ${row.file} | ${row.hash} | ${row.old} | ${row.next} | ${row.cause} | ${decisionFor(row, decisions)} |",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "R2-05",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "The report prose is partly wrong or vague: a typo (with no reviewer name, The new parser returns none); the scope paragraph omits the .txt suffix, the drivers, research-evidence and node_modules skips and the nested-raw rule, and says the directory is walked only outside a git checkout although it is also walked for a root below the checkout top; the bare (F-016) names no package or round; the regenerate line does not name the checked-in report path.",
    "impact": "A reader cannot tell from the checked-in report which raws will be replayed or how to regenerate it, and the operator-facing acceptance sentence reads as a typo.",
    "suggested_fix": "Fix the typo, state the full isReplayable rule and both walk cases, cite F-016 with its package, name the report path in the regenerate line, then regenerate replay-report.md.",
    "evidence": "replay.ts line 161 and replay-report.md line 29 (typo); isReplayable at replay.ts:102; the test named a root below the top of a git checkout is walked; style reviewer R2-S-001..003.",
    "confidence": "high",
    "file": "src/review/replay.ts",
    "quote": "with no reviewer name, The new parser returns none",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "R2-06",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "Only the final path component is lstat-checked. A symlinked ancestor directory is followed, in git mode when a tracked directory is locally replaced by a symlink and in walk mode when .metaproject/flows is a link, so a file outside the root is read.",
    "impact": "The report states that symbolic links are skipped, which is wrong for ancestors. The leak is limited to a sha256 prefix plus the parsed reviewer, status and finding count in the generated report.",
    "suggested_fix": "Reject a path whose realpath is not inside realpath(root), or narrow the claim in the report.",
    "evidence": "Verified (V5): a committed real directory replaced by an uncommitted symlink to an outside directory; the driver listed the path and returned the outside file's outcome (OUTSIDE-SECRET).",
    "confidence": "high",
    "file": "src/review/replay.ts",
    "quote": "readFileSync(path.join(root, relative), \"utf8\")",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "R2-07",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "The git fixture helper passes only user.name and user.email. It inherits the developer's global git config, so commit.gpgsign=true or a global hooksPath makes the fixture commit fail.",
    "impact": "The suite fails locally for a reason unrelated to replay (32 pass, 1 fail). Seven other src test files already pass commit.gpgsign=false.",
    "suggested_fix": "Add -c commit.gpgsign=false and -c core.hooksPath=/dev/null to the fixture git calls (or set GIT_CONFIG_GLOBAL to an empty file).",
    "evidence": "Verified (V6): with GIT_CONFIG_GLOBAL setting commit.gpgsign=true and gpg.program=/bin/false the test inside a git checkout it replays tracked files only and leaves out untracked and ignored ones fails at expect(run.status).toBe(0).",
    "confidence": "high",
    "file": "src/review/replay.test.ts",
    "quote": "inside a git checkout it replays tracked files only and leaves out untracked and ignored ones",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "R2-08",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "The repository test compares the whole checked-in report with the rendered one, and the CLI test hard-codes the count of replayed files, so the tests are coupled to the exact set of tracked raws under .metaproject/flows.",
    "impact": "Any later PR that commits a raw/*.txt there turns CI red with a multi-KB string diff and no regeneration hint (PR 997 rounds 2 and 3 did commit raws). Today it passes.",
    "suggested_fix": "Derive the expected count from replayRepository, and make the report-equality failure name the regenerate command.",
    "evidence": "19 tracked raws, all from PR 997; reported by highload (rated major), architecture and testing (minor); the CLI test asserts Files replayed: 19.",
    "confidence": "medium",
    "file": "src/review/replay.test.ts",
    "quote": "Files replayed: 19.",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "R2-09",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "Nothing checks that every DECISIONS key matches a currently differing row, and a decision is bound only to file and hash, not to the old and new outcome it was accepted for. The undecided test scans rendered table text and passes if its filter matches no line.",
    "impact": "After a rename, an edit or a parser change a stale or mistyped key is silently ignored, and an accepted decision can survive a different outcome pair.",
    "suggested_fix": "Add a test that DECISIONS keys equal the set of differing rows' keys, and assert decisionFor over the rows instead of grepping the table.",
    "evidence": "DECISIONS is referenced only inside replay.ts and the test imports decisionKey; logic R2-002 and testing F-R2-002.",
    "confidence": "high",
    "file": "src/review/replay.ts",
    "quote": "export const DECISIONS: Record<string, string> = {",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "R2-10",
    "reviewer": "vantage-review (deep pass)",
    "severity": "minor",
    "problem": "The assertion that the data/review/r3 raw is left out of the replay passes because replayRepository only asks git for .metaproject/flows, not because the file is untracked or ignored. In the fixture that file is tracked and not ignored.",
    "impact": "A broken tracked-only filter would still pass this assertion, so the test name overclaims what it pins.",
    "suggested_fix": "Move the r3 case under .metaproject/flows as a genuinely untracked or ignored raw, or rename the assertion to say it checks the flows-only scope.",
    "evidence": "Verified (V7): in a scratch repo git ls-files lists the r3 file and git check-ignore exits 1, yet the replay result omits it.",
    "confidence": "high",
    "file": "src/review/replay.test.ts",
    "quote": "data/review/r3/raw/architecture.txt",
    "pre_existing": false,
    "location_class": "changed"
  }
]
```
