# PR 1008 — review round 1

**Verdict: not mergeable at 0eba4d3.** One blocker (R1-00): the PR's own Evidence-level refusal breaks an unmigrated end-to-end fixture, and it is the single failing test behind both red required checks. Two majors (R1-01, R1-02) are mutation survivors on the new head and merge gate: the production default lookup and the offline contract are not pinned. The remaining eight findings are minor and local.

Evidence level: ran — bun test (focused suite of 9 files), mutation pass of 26 mutants, CI log of the head, executed probes of the new parsers

## Summary

Head `0eba4d308e30f32aa16eacc0c47e682d77d44bc1`, merge base `060701ca`. Review id `2026-10-14-pr-1008-round1-0eba4d30`, mode all, scope A+B, flow 445 (review-quality rules), worktree `/home/altsay/keryx-f445`, branch `flow-445-review-quality-rules`.

Findings: 13 filed: 1 blocker (R1-00), 2 major (R1-01, R1-02), 10 minor (R1-03, R1-04, R1-05, R1-06, R1-07, R1-08, R1-09, R1-10, R1-11, R1-12).

Mutation pass (focused command of 9 test files, baseline green): 26 mutants, 18 killed, 8 survived. Survivors: r1-gate-offline-throws (R1-02), r1-cli-lookup-off and r1-cli-warnings-silent (R1-01), r1-loc-external-asked and r1-loc-dismissed-asked (R1-08), r1-lex-dotdot-ok, r1-lex-absolute-ok and r1-cite-url-kept (R1-09). Evidence: `research-evidence/mutation-1.md`, `mutation-1.json`.

The local full check showed environmental failures only (digest-surface, ci-triage-source); the single failure in CI is the one in R1-00.

## Findings by severity

- Blocker: R1-00.
- Major: R1-01, R1-02.
- Minor: R1-03, R1-04, R1-05, R1-06, R1-07, R1-08, R1-09, R1-10, R1-11, R1-12.

### R1-00 — blocker — src/flow/review-gate.e2e.test.ts

**Problem.** The PR makes `review complete` refuse a package whose report has no `Evidence level:` line (AC2) and stamps every newly ingested manifest with `report_fields: ["evidence-level"]`. The existing end-to-end suite ingests a report without that line and then completes it, so `flow complete revalidates dispatch on a closed review round` now fails at its first `review complete` (exit code 1, expected 0). The PR did not touch this fixture.

**Impact.** Reproduced locally (`bun test src/flow/review-gate.e2e.test.ts`: 1 fail, 12 pass) and in CI, where it is the single failing test behind both red checks, `AC8 full suite` and `typecheck-and-tests`. With a required check red the PR cannot merge. The same test goes green when the fixture report carries `Evidence level: static only — did not run: tests` (13 pass), so the refusal is the intended behaviour and the break is the unmigrated fixture; any other caller that ingests a minimal report and then closes it breaks the same way.

**Suggested fix.** Give the shared fixture in ingestRound an `Evidence level:` line (and grep the other tests and docs that ingest a hand-written report and then complete it); consider a one-line hint in the refusal that names the line to add.

**Evidence.** CI log (typecheck-and-tests): `(fail) flow complete revalidates dispatch on a closed review round [64.80ms]`, `Expected: 0 Received: 1` at src/flow/review-gate.e2e.test.ts:614; local run of the same file at head 0eba4d3 reproduces it; patched fixture (reverted afterwards) gives 13 pass, 0 fail.

### R1-01 — major — src/commands/review.ts

**Problem.** The only place the head and merge gate is switched on for the real command is the default `seams?.prLookup ?? trackerPrLookup` in runComplete. Every test of the gate passes `prLookup` through the seam or calls completeHeadGate directly, so no test runs `review complete` with the default lookup. `trackerPrLookup` itself (githubAdapter.detect, then prStatus mapping state and headRefOid into a PrSnapshot) has no test either.

**Impact.** Trigger: any later edit that drops the default, or breaks the adapter mapping (for example a renamed field in prStatus). Outcome, checked by mutation at head: removing `prLookup: seams?.prLookup ?? trackerPrLookup, ` leaves all 9 focused test files green (the gate is then never asked for a library or CLI close), so AC1 silently stops holding in production while its test passes. The warnings print line next to it is unpinned the same way (r1-cli-warnings-silent survived).

**Suggested fix.** Add a `review complete` CLI test on a PR-bound package that stubs only the `gh` binary (or `githubAdapter.prStatus`) and asserts a refusal for a merged PR and a moved head, and a stderr warning for an unreachable tracker; assert the legacy-package warning reaches stderr.

**Evidence.** mutant:r1-cli-lookup-off survived; mutant:r1-cli-warnings-silent survived (mutation-1.json, focused command of 9 test files, baseline green). Killed for contrast: r1-gate-moved-off, r1-gate-merged-off, r1-gate-says-so-off, r1-gate-sha-name-off, r1-gate-nonpr-off. Source: review.ts:3898-3899, 573-580.

### R1-02 — major — src/review/complete-head-gate.ts

**Problem.** The offline contract of the gate ("a tracker that cannot be reached is a warning: the gate must not make an offline close impossible", and AC1's unreachable-tracker warning) is not pinned. No test gives completeHeadGate a lookup that returns null, `{exists:false}`, or throws, and asserts the warning and no refusal.

**Impact.** Trigger: an edit that turns the null / not-found branch into a throw (or drops the try/catch). Outcome, checked by mutation at head: replacing the branch with `throw new Error("offline")` leaves the focused suite green. `review complete` then fails on any machine where `gh` is missing, unauthenticated or offline, which is exactly the case the design says must still close.

**Suggested fix.** Three cases in complete-head-gate.test.ts: lookup resolves null; lookup resolves `{exists:false}`; lookup rejects. Each returns one warning naming the PR and never throws.

**Evidence.** mutant:r1-gate-offline-throws survived (mutation-1.json). Source: complete-head-gate.ts:31-33.

### R1-03 — minor — src/review/ledger.ts

**Problem.** A research obligation can close as `narrowed` with only a non-empty `remains` string. Unlike `finding`, it carries no link to a canonical finding, so what "still stands" lives only in research.json. findings.json, the severity counts and the formal state never see it.

**Impact.** Trigger: a reviewer's raw major is dispositioned `narrowed` with `remains: "see report"`. Outcome: the obligation reads closed, the ledger is READY, and the surviving part of the claim is in no canonical finding; the template's "Refuted and narrowed" section is prose only and nothing generates it. `narrowed` is then no stricter than `refuted`, which the flow set out to improve on.

**Suggested fix.** Require `narrowed` to name a canonical finding that carries the remainder (the same unique-link check `finding` has), or write the `remains` text into findings.json as a minor finding at ingest.

**Evidence.** Source: ledger.ts:465-470 (the `finding` branch checks the canonical link, the `narrowed` branch only the text), research.ts:25-30. Killed: r1-narrowed-remains-off, r1-narrowed-research-remains-off, r1-narrowed-not-closed.

### R1-04 — minor — src/review/rebuttal-citation.ts

**Problem.** citedPaths matches any bare file name with a document extension and looks it up at the repository root. A rebuttal that mentions a package file (`research.json`, `findings.json`, `scope.md`), a version string (`v1.2.json`) or `i.e.md` gets a `citation not found` line although it cites no rule.

**Impact.** Trigger: an ordinary dismissal such as "see research.json: the obligation is closed". Outcome: the finding's evidence gains `citation not found: research.json`, which tells the reader the author invented a source. The finding is kept, so the cost is a wrong accusation and noise on every dismissal that names a package file.

**Suggested fix.** Require a directory component or a known rule/doc root (`.metaproject/`, `docs/`, `rules/`), or skip names that exist in the package directory; keep a test for `research.json` and `v1.2.json`.

**Evidence.** Probe at head: citedPaths("per research.json and findings.json, see package.json, docs/a.md#x, README.md:12, ../up/b.md, https://x.io/a.md, v1.2.json, e.g. i.e.md") -> research.json, findings.json, package.json, docs/a.md, README.md, ../up/b.md, v1.2.json, i.e.md (URL correctly dropped). Source: rebuttal-citation.ts:4-10, managed.ts citationExists.

### R1-05 — minor — src/review/complete-head-gate.ts

**Problem.** The first-line check accepts any of `merged|moved|advanced|stale|superseded|closed|force-pushed|no longer` anywhere in the line, so a first line that names the SHA and uses one of those words for something else passes.

**Impact.** Trigger: first line `Reviewed 0eba4d3 — closed loop on the cache.` Outcome (probed): the gate returns no warning although the PR moved, so the refusal can be satisfied by accident. The check proves a SHA and a word are present, not that the PR moved.

**Suggested fix.** Match a phrase (`the PR has since (merged|moved|been force-pushed)`), or require the new head's short SHA as well as the reviewed one.

**Evidence.** Probe at head: completeHeadGate with head moved and first line "Reviewed 0eba4d3 — closed loop on the cache." -> {warnings: []}. Source: complete-head-gate.ts:6,44.

### R1-06 — minor — src/review/complete-head-gate.ts

**Problem.** sameCommit treats either side as a prefix of the other, with no minimum length. An empty or very short `target.head` ("", "0e") equals every PR head, so the moved check is skipped.

**Impact.** Trigger: a package attached with `--head 0e`, or a manifest with an empty head string. Outcome (probed): head "" and head "0e" against 0eba4d30… both read as unmoved; the gate returns no warning.

**Suggested fix.** Compare only when both sides are at least 7 hex characters; otherwise treat the reviewed head as unknown and warn.

**Evidence.** Probe at head: head "" and head "0e" -> {warnings: []} against a different PR head. Source: complete-head-gate.ts:8-11,38.

### R1-07 — minor — src/review/evidence-level.ts

**Problem.** parseEvidenceLevel takes the first line anywhere in the report that matches, including one inside a fenced code block, and accepts a content-free list (`ran — nothing`).

**Impact.** Trigger: a report that quotes the template line in a code fence before the real one, or `Evidence level: ran — nothing`. Outcome (probed): both parse ok, so the field the flow adds to stop "static only" with no detail from passing can be satisfied by a placeholder.

**Suggested fix.** Ignore fenced blocks, and reject a list whose only item is `none`, `nothing` or `n/a` under `ran`.

**Evidence.** Probe at head: parseEvidenceLevel("# Review\n```\nEvidence level: ran — tests\n```\n") -> ok; "Evidence level: ran — nothing" -> ok. Source: evidence-level.ts:8,25-35.

### R1-08 — minor — src/review/managed.ts

**Problem.** Two exemptions of the new ingest refusal are unpinned: findings with source `external` and findings the round already dismissed. Both mutants survived. A regression would make `review ingest` refuse comments from other reviewers or dismissed findings whose quote is stale by design.

**Impact.** Trigger: an edit that drops either condition. Outcome: ingest of a round with a dismissed finding or an external comment aborts with "cite a quote that does not resolve" although the design exempts them. Judged minor, not major: the exemptions are explicit in the doc comment and the failure is loud, not silent.

**Suggested fix.** Add two cases to ingest-locator-sha.test.ts: an external finding with an unresolvable quote and a dismissed one; both ingest.

**Evidence.** Survivors in mutation-1.json: r1-loc-external-asked, r1-loc-dismissed-asked (judged in research-evidence/survivors.md). Source: managed.ts:1219-1230.

### R1-09 — minor — src/review/managed.ts

**Problem.** lexicalRelativePath replaced the realpath containment. Its `..` and absolute branches are unpinned (both mutants survived), and so is the URL stripping in citedPaths (r1-cite-url-kept survived).

**Impact.** For the head-pinned read the change is safe: `git show <sha>:<path>` reads a blob and never follows a link, so a symlink in the tree cannot lead the read out of it (checked: the working-tree fallback `readFromWorkingTree` keeps its realpath containment). The residual is `citationExists`, whose `lstat` on the working tree uses the lexical check alone: without it a rebuttal citing `../x.md` becomes an existence oracle outside the tree. Judged minor.

**Suggested fix.** Test `../x.md` and an absolute path through citationExists, and a rebuttal that cites only a URL.

**Evidence.** Survivors in mutation-1.json: r1-lex-dotdot-ok, r1-lex-absolute-ok, r1-cite-url-kept (judged in survivors.md). Source: managed.ts:1257-1268.

### R1-10 — minor — src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md

**Problem.** The skill stays under its line ceiling because three unrelated hard-wrapped paragraphs (the unrecognised-option note, the do-not-write-the-record note, the closing-without-dispositions note) were joined into single long lines, while four new lines of 190 to 330 characters were added. The line count is unchanged; the byte size grew.

**Impact.** AC6 holds to the letter (at most four lines, under the ceiling) but not to its purpose of keeping the skill short; the edit also creates a diff on text the flow did not touch, and the four gate lines sit in the `--refuted` section, away from where an orchestrator looks for complete and ingest.

**Suggested fix.** Restore the three paragraphs as they were, put the four gate lines next to the `complete` and `ingest` usage, and if the ceiling is then exceeded raise it deliberately in skill-length-ceilings.ts with the reason.

**Evidence.** Source: SKILL.md:210, 236, 252-255 against origin/main (git diff: 8 insertions, 8 deletions).

### R1-11 — minor — src/review/managed.ts

**Problem.** The new ingest refusal covers every case the locator calls `unlocatable`, and the locator's own contract says a quote that matches in more than one place is unlocatable. The refusal message blames the quote in all of them ("Re-quote from the file as it stands at that commit"): a SHA not in the local object store, a file the PR deleted, and a quote that repeats in the file.

**Impact.** Trigger: ingesting on a checkout that lacks the PR head (a fork PR not fetched), a finding about code the PR removed, or a quote of a repeated line such as `return null;`. Outcome: the whole ingest aborts, minors included, and the message points the reviewer at the wrong cause; the only way out is dropping `--head`, which the message does not say. Not proven against a missing-object checkout; the ambiguity case follows from locate.ts:21.

**Suggested fix.** Name the cause per finding (`unlocatable` reason is already recorded), say `git cat-file -e <sha>` when the commit is absent, and name the escape (dismiss with evidence, or ingest without --head).

**Evidence.** Source: managed.ts:1219-1241, locate.ts:21 and 143-157.

### R1-12 — minor — src/flow/tracker/github.ts

**Problem.** `prStatus` runs `gh pr checks` after `gh pr view` to fill `checksGreen`, which the new gate never reads; `trackerPrLookup` adds `gh auth status` before both. Every `review complete` on a PR-bound package now makes three `gh` round trips, one of them waiting on CI state.

**Impact.** Cost: seconds on each close and one more network dependency on a path whose design says an unreachable tracker must only warn. The adapter code is not part of this diff; the new caller makes the cost visible.

**Suggested fix.** Give the adapter a `prHead` read (`gh pr view --json state,headRefOid`) and use it from trackerPrLookup.

**Evidence.** Source: github.ts:76-87 (pre-existing), review.ts:573-580.

## Structured findings

```json keryx:findings
[
  {
    "id": "R1-00",
    "reviewer": "review-regression",
    "severity": "blocker",
    "confidence": "high",
    "file": "src/flow/review-gate.e2e.test.ts",
    "quote": "\"# Round\\n\\nNothing outstanding.\\n\"",
    "problem": "The PR makes `review complete` refuse a package whose report has no `Evidence level:` line (AC2) and stamps every newly ingested manifest with `report_fields: [\"evidence-level\"]`. The existing end-to-end suite ingests a report without that line and then completes it, so `flow complete revalidates dispatch on a closed review round` now fails at its first `review complete` (exit code 1, expected 0). The PR did not touch this fixture.",
    "impact": "Reproduced locally (`bun test src/flow/review-gate.e2e.test.ts`: 1 fail, 12 pass) and in CI, where it is the single failing test behind both red checks, `AC8 full suite` and `typecheck-and-tests`. With a required check red the PR cannot merge. The same test goes green when the fixture report carries `Evidence level: static only — did not run: tests` (13 pass), so the refusal is the intended behaviour and the break is the unmigrated fixture; any other caller that ingests a minimal report and then closes it breaks the same way.",
    "suggested_fix": "Give the shared fixture in ingestRound an `Evidence level:` line (and grep the other tests and docs that ingest a hand-written report and then complete it); consider a one-line hint in the refusal that names the line to add.",
    "evidence": "CI log (typecheck-and-tests): `(fail) flow complete revalidates dispatch on a closed review round [64.80ms]`, `Expected: 0 Received: 1` at src/flow/review-gate.e2e.test.ts:614; local run of the same file at head 0eba4d3 reproduces it; patched fixture (reverted afterwards) gives 13 pass, 0 fail.",
    "class_scope": {
      "sites": [
        "src/flow/review-gate.e2e.test.ts:205"
      ],
      "enumeration_method": "Full CI log of the head searched for `(fail)`: the only failing test in the whole suite (34114 tests) is this one, so no other fixture that ingests then completes is affected in CI. The local-only failures (digest-surface, ci-triage-source) do not appear in CI and are environmental."
    }
  },
  {
    "id": "R1-01",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "confidence": "high",
    "file": "src/commands/review.ts",
    "quote": "prLookup: seams?.prLookup ?? trackerPrLookup",
    "problem": "The only place the head and merge gate is switched on for the real command is the default `seams?.prLookup ?? trackerPrLookup` in runComplete. Every test of the gate passes `prLookup` through the seam or calls completeHeadGate directly, so no test runs `review complete` with the default lookup. `trackerPrLookup` itself (githubAdapter.detect, then prStatus mapping state and headRefOid into a PrSnapshot) has no test either.",
    "impact": "Trigger: any later edit that drops the default, or breaks the adapter mapping (for example a renamed field in prStatus). Outcome, checked by mutation at head: removing `prLookup: seams?.prLookup ?? trackerPrLookup, ` leaves all 9 focused test files green (the gate is then never asked for a library or CLI close), so AC1 silently stops holding in production while its test passes. The warnings print line next to it is unpinned the same way (r1-cli-warnings-silent survived).",
    "suggested_fix": "Add a `review complete` CLI test on a PR-bound package that stubs only the `gh` binary (or `githubAdapter.prStatus`) and asserts a refusal for a merged PR and a moved head, and a stderr warning for an unreachable tracker; assert the legacy-package warning reaches stderr.",
    "evidence": "mutant:r1-cli-lookup-off survived; mutant:r1-cli-warnings-silent survived (mutation-1.json, focused command of 9 test files, baseline green). Killed for contrast: r1-gate-moved-off, r1-gate-merged-off, r1-gate-says-so-off, r1-gate-sha-name-off, r1-gate-nonpr-off. Source: review.ts:3898-3899, 573-580.",
    "class_scope": {
      "sites": [
        "src/commands/review.ts:3898",
        "src/commands/review.ts:3899",
        "src/commands/review.ts:573"
      ],
      "enumeration_method": "Every production default the PR adds behind a test seam (`ReviewCommandSeams.prLookup` is the only new one) and every new CLI-level output (the warnings loop); both were mutated and both survived. Gate internals in complete-head-gate.ts were mutated separately and are covered in R1-02."
    }
  },
  {
    "id": "R1-02",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "confidence": "high",
    "file": "src/review/complete-head-gate.ts",
    "quote": "if (pr === null || !pr.exists) return",
    "problem": "The offline contract of the gate (\"a tracker that cannot be reached is a warning: the gate must not make an offline close impossible\", and AC1's unreachable-tracker warning) is not pinned. No test gives completeHeadGate a lookup that returns null, `{exists:false}`, or throws, and asserts the warning and no refusal.",
    "impact": "Trigger: an edit that turns the null / not-found branch into a throw (or drops the try/catch). Outcome, checked by mutation at head: replacing the branch with `throw new Error(\"offline\")` leaves the focused suite green. `review complete` then fails on any machine where `gh` is missing, unauthenticated or offline, which is exactly the case the design says must still close.",
    "suggested_fix": "Three cases in complete-head-gate.test.ts: lookup resolves null; lookup resolves `{exists:false}`; lookup rejects. Each returns one warning naming the PR and never throws.",
    "evidence": "mutant:r1-gate-offline-throws survived (mutation-1.json). Source: complete-head-gate.ts:31-33.",
    "class_scope": {
      "sites": [
        "src/review/complete-head-gate.ts:31",
        "src/review/complete-head-gate.ts:33"
      ],
      "enumeration_method": "All six mutants of complete-head-gate.ts (moved, merged, says-so, sha-name, non-pr, offline) were run; five were killed and this is the only survivor, so the offline branch is the whole unpinned set for this file."
    }
  },
  {
    "id": "R1-03",
    "reviewer": "review-logic",
    "severity": "minor",
    "confidence": "medium",
    "file": "src/review/ledger.ts",
    "quote": "if (given.status === \"narrowed\" && !text(given.remains)) return undefined;",
    "problem": "A research obligation can close as `narrowed` with only a non-empty `remains` string. Unlike `finding`, it carries no link to a canonical finding, so what \"still stands\" lives only in research.json. findings.json, the severity counts and the formal state never see it.",
    "impact": "Trigger: a reviewer's raw major is dispositioned `narrowed` with `remains: \"see report\"`. Outcome: the obligation reads closed, the ledger is READY, and the surviving part of the claim is in no canonical finding; the template's \"Refuted and narrowed\" section is prose only and nothing generates it. `narrowed` is then no stricter than `refuted`, which the flow set out to improve on.",
    "suggested_fix": "Require `narrowed` to name a canonical finding that carries the remainder (the same unique-link check `finding` has), or write the `remains` text into findings.json as a minor finding at ingest.",
    "evidence": "Source: ledger.ts:465-470 (the `finding` branch checks the canonical link, the `narrowed` branch only the text), research.ts:25-30. Killed: r1-narrowed-remains-off, r1-narrowed-research-remains-off, r1-narrowed-not-closed.",
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:468",
        "src/review/research.ts:28"
      ],
      "enumeration_method": "Both validators the PR touched (buildLedger's closeWith and researchErrors) accept `narrowed` on text alone."
    }
  },
  {
    "id": "R1-04",
    "reviewer": "review-logic",
    "severity": "minor",
    "confidence": "high",
    "file": "src/review/rebuttal-citation.ts",
    "quote": "const CITED =",
    "problem": "citedPaths matches any bare file name with a document extension and looks it up at the repository root. A rebuttal that mentions a package file (`research.json`, `findings.json`, `scope.md`), a version string (`v1.2.json`) or `i.e.md` gets a `citation not found` line although it cites no rule.",
    "impact": "Trigger: an ordinary dismissal such as \"see research.json: the obligation is closed\". Outcome: the finding's evidence gains `citation not found: research.json`, which tells the reader the author invented a source. The finding is kept, so the cost is a wrong accusation and noise on every dismissal that names a package file.",
    "suggested_fix": "Require a directory component or a known rule/doc root (`.metaproject/`, `docs/`, `rules/`), or skip names that exist in the package directory; keep a test for `research.json` and `v1.2.json`.",
    "evidence": "Probe at head: citedPaths(\"per research.json and findings.json, see package.json, docs/a.md#x, README.md:12, ../up/b.md, https://x.io/a.md, v1.2.json, e.g. i.e.md\") -> research.json, findings.json, package.json, docs/a.md, README.md, ../up/b.md, v1.2.json, i.e.md (URL correctly dropped). Source: rebuttal-citation.ts:4-10, managed.ts citationExists.",
    "class_scope": {
      "sites": [
        "src/review/rebuttal-citation.ts:4"
      ],
      "enumeration_method": "One regex; probed with eight spellings."
    }
  },
  {
    "id": "R1-05",
    "reviewer": "review-logic",
    "severity": "minor",
    "confidence": "high",
    "file": "src/review/complete-head-gate.ts",
    "quote": "const SAYS_SO =",
    "problem": "The first-line check accepts any of `merged|moved|advanced|stale|superseded|closed|force-pushed|no longer` anywhere in the line, so a first line that names the SHA and uses one of those words for something else passes.",
    "impact": "Trigger: first line `Reviewed 0eba4d3 — closed loop on the cache.` Outcome (probed): the gate returns no warning although the PR moved, so the refusal can be satisfied by accident. The check proves a SHA and a word are present, not that the PR moved.",
    "suggested_fix": "Match a phrase (`the PR has since (merged|moved|been force-pushed)`), or require the new head's short SHA as well as the reviewed one.",
    "evidence": "Probe at head: completeHeadGate with head moved and first line \"Reviewed 0eba4d3 — closed loop on the cache.\" -> {warnings: []}. Source: complete-head-gate.ts:6,44.",
    "class_scope": {
      "sites": [
        "src/review/complete-head-gate.ts:6",
        "src/review/complete-head-gate.ts:44"
      ],
      "enumeration_method": "One word list, used once."
    }
  },
  {
    "id": "R1-06",
    "reviewer": "review-security-code",
    "severity": "minor",
    "confidence": "high",
    "file": "src/review/complete-head-gate.ts",
    "quote": "return x.startsWith(y) || y.startsWith(x);",
    "problem": "sameCommit treats either side as a prefix of the other, with no minimum length. An empty or very short `target.head` (\"\", \"0e\") equals every PR head, so the moved check is skipped.",
    "impact": "Trigger: a package attached with `--head 0e`, or a manifest with an empty head string. Outcome (probed): head \"\" and head \"0e\" against 0eba4d30… both read as unmoved; the gate returns no warning.",
    "suggested_fix": "Compare only when both sides are at least 7 hex characters; otherwise treat the reviewed head as unknown and warn.",
    "evidence": "Probe at head: head \"\" and head \"0e\" -> {warnings: []} against a different PR head. Source: complete-head-gate.ts:8-11,38.",
    "class_scope": {
      "sites": [
        "src/review/complete-head-gate.ts:9"
      ],
      "enumeration_method": "The one comparison helper."
    }
  },
  {
    "id": "R1-07",
    "reviewer": "review-logic",
    "severity": "minor",
    "confidence": "high",
    "file": "src/review/evidence-level.ts",
    "quote": "const LINE =",
    "problem": "parseEvidenceLevel takes the first line anywhere in the report that matches, including one inside a fenced code block, and accepts a content-free list (`ran — nothing`).",
    "impact": "Trigger: a report that quotes the template line in a code fence before the real one, or `Evidence level: ran — nothing`. Outcome (probed): both parse ok, so the field the flow adds to stop \"static only\" with no detail from passing can be satisfied by a placeholder.",
    "suggested_fix": "Ignore fenced blocks, and reject a list whose only item is `none`, `nothing` or `n/a` under `ran`.",
    "evidence": "Probe at head: parseEvidenceLevel(\"# Review\\n```\\nEvidence level: ran — tests\\n```\\n\") -> ok; \"Evidence level: ran — nothing\" -> ok. Source: evidence-level.ts:8,25-35.",
    "class_scope": {
      "sites": [
        "src/review/evidence-level.ts:8",
        "src/review/evidence-level.ts:25"
      ],
      "enumeration_method": "One parser; six spellings probed."
    }
  },
  {
    "id": "R1-08",
    "reviewer": "review-logic",
    "severity": "minor",
    "confidence": "medium",
    "file": "src/review/managed.ts",
    "quote": "finding.source !== \"external\" && finding.disposition === undefined",
    "problem": "Two exemptions of the new ingest refusal are unpinned: findings with source `external` and findings the round already dismissed. Both mutants survived. A regression would make `review ingest` refuse comments from other reviewers or dismissed findings whose quote is stale by design.",
    "impact": "Trigger: an edit that drops either condition. Outcome: ingest of a round with a dismissed finding or an external comment aborts with \"cite a quote that does not resolve\" although the design exempts them. Judged minor, not major: the exemptions are explicit in the doc comment and the failure is loud, not silent.",
    "suggested_fix": "Add two cases to ingest-locator-sha.test.ts: an external finding with an unresolvable quote and a dismissed one; both ingest.",
    "evidence": "Survivors in mutation-1.json: r1-loc-external-asked, r1-loc-dismissed-asked (judged in research-evidence/survivors.md). Source: managed.ts:1219-1230.",
    "class_scope": {
      "sites": [
        "src/review/managed.ts:1229"
      ],
      "enumeration_method": "One predicate with two clauses, both mutated."
    }
  },
  {
    "id": "R1-09",
    "reviewer": "review-security-code",
    "severity": "minor",
    "confidence": "high",
    "file": "src/review/managed.ts",
    "quote": "normalised === \"..\" || normalised.startsWith(\"../\")",
    "problem": "lexicalRelativePath replaced the realpath containment. Its `..` and absolute branches are unpinned (both mutants survived), and so is the URL stripping in citedPaths (r1-cite-url-kept survived).",
    "impact": "For the head-pinned read the change is safe: `git show <sha>:<path>` reads a blob and never follows a link, so a symlink in the tree cannot lead the read out of it (checked: the working-tree fallback `readFromWorkingTree` keeps its realpath containment). The residual is `citationExists`, whose `lstat` on the working tree uses the lexical check alone: without it a rebuttal citing `../x.md` becomes an existence oracle outside the tree. Judged minor.",
    "suggested_fix": "Test `../x.md` and an absolute path through citationExists, and a rebuttal that cites only a URL.",
    "evidence": "Survivors in mutation-1.json: r1-lex-dotdot-ok, r1-lex-absolute-ok, r1-cite-url-kept (judged in survivors.md). Source: managed.ts:1257-1268.",
    "class_scope": {
      "sites": [
        "src/review/managed.ts:1262",
        "src/review/rebuttal-citation.ts:9"
      ],
      "enumeration_method": "Every containment or filtering branch the PR added to the citation and locator reads."
    }
  },
  {
    "id": "R1-10",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "confidence": "medium",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md",
    "quote": "**An unrecognised option is refused, not ignored** — a misspelled flag exits non-zero rather than printing",
    "problem": "The skill stays under its line ceiling because three unrelated hard-wrapped paragraphs (the unrecognised-option note, the do-not-write-the-record note, the closing-without-dispositions note) were joined into single long lines, while four new lines of 190 to 330 characters were added. The line count is unchanged; the byte size grew.",
    "impact": "AC6 holds to the letter (at most four lines, under the ceiling) but not to its purpose of keeping the skill short; the edit also creates a diff on text the flow did not touch, and the four gate lines sit in the `--refuted` section, away from where an orchestrator looks for complete and ingest.",
    "suggested_fix": "Restore the three paragraphs as they were, put the four gate lines next to the `complete` and `ingest` usage, and if the ceiling is then exceeded raise it deliberately in skill-length-ceilings.ts with the reason.",
    "evidence": "Source: SKILL.md:210, 236, 252-255 against origin/main (git diff: 8 insertions, 8 deletions).",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:210",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:236",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:252"
      ],
      "enumeration_method": "The whole SKILL.md diff (both copies are identical, the installed one is pinned by a test)."
    }
  },
  {
    "id": "R1-11",
    "reviewer": "review-logic",
    "severity": "minor",
    "confidence": "medium",
    "file": "src/review/managed.ts",
    "quote": "finding(s) cite a quote that does not resolve at the reviewed SHA",
    "problem": "The new ingest refusal covers every case the locator calls `unlocatable`, and the locator's own contract says a quote that matches in more than one place is unlocatable. The refusal message blames the quote in all of them (\"Re-quote from the file as it stands at that commit\"): a SHA not in the local object store, a file the PR deleted, and a quote that repeats in the file.",
    "impact": "Trigger: ingesting on a checkout that lacks the PR head (a fork PR not fetched), a finding about code the PR removed, or a quote of a repeated line such as `return null;`. Outcome: the whole ingest aborts, minors included, and the message points the reviewer at the wrong cause; the only way out is dropping `--head`, which the message does not say. Not proven against a missing-object checkout; the ambiguity case follows from locate.ts:21.",
    "suggested_fix": "Name the cause per finding (`unlocatable` reason is already recorded), say `git cat-file -e <sha>` when the commit is absent, and name the escape (dismiss with evidence, or ingest without --head).",
    "evidence": "Source: managed.ts:1219-1241, locate.ts:21 and 143-157.",
    "class_scope": {
      "sites": [
        "src/review/managed.ts:1239"
      ],
      "enumeration_method": "One error message; causes taken from locate.ts's reasons."
    }
  },
  {
    "id": "R1-12",
    "reviewer": "review-performance",
    "severity": "minor",
    "confidence": "medium",
    "file": "src/flow/tracker/github.ts",
    "quote": "const checks = await gh([\"pr\", \"checks\", url]);",
    "problem": "`prStatus` runs `gh pr checks` after `gh pr view` to fill `checksGreen`, which the new gate never reads; `trackerPrLookup` adds `gh auth status` before both. Every `review complete` on a PR-bound package now makes three `gh` round trips, one of them waiting on CI state.",
    "impact": "Cost: seconds on each close and one more network dependency on a path whose design says an unreachable tracker must only warn. The adapter code is not part of this diff; the new caller makes the cost visible.",
    "suggested_fix": "Give the adapter a `prHead` read (`gh pr view --json state,headRefOid`) and use it from trackerPrLookup.",
    "evidence": "Source: github.ts:76-87 (pre-existing), review.ts:573-580.",
    "class_scope": {
      "sites": [
        "src/flow/tracker/github.ts:87",
        "src/commands/review.ts:578"
      ],
      "enumeration_method": "The one new caller of prStatus."
    }
  }
]
```
