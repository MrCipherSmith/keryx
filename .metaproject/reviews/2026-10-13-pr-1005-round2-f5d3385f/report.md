# PR 1005 — review round 2

Verdict: request-changes

Head reviewed: f5d3385ff723617418127c4eb8c5ea2870b752f4
Merge base: 4839dbecaa799c9b75bc19eaa9085d6a889df972
Review id: 2026-10-13-pr-1005-round2-f5d3385f
Orchestrator: vantage-review (generic engine review-orchestrator). Mode: all, deep round with scope B and a mutation pass. Round 2 of 3.

## Summary

Round-1 fixes F-057 to F-064 are mostly closed, with residue. Two majors remain, both gaps the round-1 fixes left open rather than regressions: F-066 (five spellings that pass the routine-command gate yet make git write a file) and F-067 (`src/gdgraph/staleness.ts:240` is an unguarded git argv site, and the PR's scan test exempts it with a false reason). Five minors and five infos follow. F-065 is unchanged from round 1 (pre-existing, no new entry).

Counts: 0 blockers, 2 majors, 5 minors, 5 infos.

## Round-1 disposition

F-057 partial (class open at staleness.ts:240, see F-067). F-058 partial (five bypasses remain, see F-066). F-059 closed. F-060 closed (200k pairs in 422 ms, no RangeError). F-061 closed. F-062 partial (see F-070). F-063 closed. F-064 partial (README says git >= 2.24; no doctor check, see F-073). F-065 unchanged.

## Mutation pass

41 mutants over `review-revision-operand.test.ts`, `trust-routine-command.test.ts`, `flow-check-ac.test.ts`: 38 killed, 3 survived (C13 `sync/diff.ts:78`, S9 `wiki/freshness/run.ts:117`, S12 `wiki/service.ts:1621`), 0 timeout, 0 invalid. The three survivors have a second guard on the same path; no finding cites one for severity. The round-1 survivors B2, B3, B12, B13, B16 and B17 are now killed. The majors are missing spellings, not weak assertions. Files: `research-evidence/mutants.json`, `mutation-2.json`, `mutation-2.md`.

## Questions

1. Should `readProvenance` validate that `commit` is hex, so every consumer is covered, or should each consumer use `revisionOperand`? Suggested: both.
2. Should the gate stop parsing shell and refuse any word with an unquoted `$`, backslash or brace in the git and keryx rows? Suggested: yes, the cheaper and safer reading of F-066.

## Pre-existing (never blocks)

- F-065, unchanged. F-072: the gate has no length cap; nested `ctx run --` is quadratic (x40k took 13.5 s). The `staleness.ts:240` code pre-dates the PR; only the false exemption is in the diff.

## Verified clean

- The nine round-1 argv sites and the 28 other changed sites use `revisionOperand`, `assertGitRevision` or a literal ref.
- Other git argv sites that cannot write a file or take a user ref: git-worktrees rev-list, ci-triage, managed.ts, bot/run.ts, flow/service.ts and review-gate rev-parse/merge-base, staleness `cat-file -e`, rewind diff-tree.
- `isExecWord` handles the `=` chain, `-c` and `EXEC_FLAGS` at 200k pairs. `git diff --diff=-` and similar stay routine. Abbreviations `--outp=` and `--o=` are refused.
- Regressions from the fixes all fail closed: 17 of 3227 corpus commands moved from routine to prompt, none the other way; a dash-leading `--since` now throws in `health/run.ts` and `testing/service.ts`.

## Not run

- 98 blast-radius files past the 40-file cap; git < 2.43; cross-family review; ingest, complete and push (caller's steps).

## Routing audit

graph_used: yes; wiki_used: no (not-relevant); ctx_used: yes; raw_rg_used: no.

## keryx:findings

```json keryx:findings
[
  {
    "id": "F-066",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "The round 1 fix for F-058 (isShellSpelledOption) catches only dash-leading words that contain a backslash, brace or dollar. splitWords does not honour a backslash inside double quotes and does not expand $IFS, brace lists or $'..', so the words the gate judges differ from the words the shell hands to git. isTrustRoutineCommand returns true for commands that make git write or truncate a file.",
    "impact": "Trigger: an agent or a pasted command such as `git log -S \"\\\"\" --output=X`, `git diff HEAD$IFS--output=X`, `git diff \"HEAD\"$IFS\"--output=X\"`, `git diff $'\\x2d\\x2doutput=X'` (bash) or `git diff {HEAD,--output=X}` (bash) is auto-approved by the trust/review-auto routine-command gate without a prompt. Outcome: git writes or truncates an arbitrary file, X. The plain `git diff --output=X` control is correctly refused. Reproduced by the orchestrator, review-security-code and the Wave C verifier (all five cases).",
    "suggested_fix": "Fail closed on any unquoted dollar, backslash, open brace or close brace in the git read rows and the keryx review rows, or compute the shell's real words. Fix the backslash-in-double-quote handling in splitWords. Add a pinned row in src/lib/trust-routine-command.test.ts for each of the five spellings.",
    "evidence": "orch/gate.ts and gate2.ts in the scratchpad t5pkg-r2 directory print `true` for the five commands above and `false` for the plain control. The git side was confirmed by running the commands in a scratch repo, where the file X was created. mutation-2.md shows the existing mutants are all killed, so the gap is a missing spelling, not a weak assertion.",
    "confidence": "high",
    "file": "src/lib/trust-routine-command.ts",
    "line": 110,
    "quote": "return words.some(isExecWord) || words.some(isShellSpelledOption);",
    "dedupe_key": "gate-shell-spelling-bypass",
    "class_scope": {
      "sites": [
        "src/lib/trust-routine-command.ts:110 (hasExecFlag)",
        "src/lib/trust-routine-command.ts:129 (isShellSpelledOption)",
        "src/lib/trust-routine-command.ts:318 (keryx review rows, hasDashValue)",
        "src/lib/shell-syntax.ts splitWords (double-quote backslash, $IFS, brace lists, $'..')",
        "git read rows (GIT_READ_SUBCOMMANDS) and keryx ctx diff / review rows judged by the same words"
      ],
      "enumeration_method": "Generated 36 hostile spellings across git, keryx ctx diff and keryx review rows in orch/gate.ts and gate2.ts, ran each through isTrustRoutineCommand, and compared with what sh and bash pass to git. Cross-checked with the security reviewer's independent probe."
    }
  },
  {
    "id": "F-067",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "src/gdgraph/staleness.ts:240 passes provenance.commit to `git diff --name-only -z <fromCommit> <toCommit>` with neither assertGitRevision nor --end-of-options. readProvenance only checks typeof commit === \"string\", and .metaproject/data/gdgraph/.provenance.json is a tracked repository file. The PR's scan test exempts this file with a false reason (\"operands are commits recorded in the graph provenance\"), so the PR's claim to have closed the ref-to-git class does not hold.",
    "impact": "Trigger: a committed .provenance.json containing {\"commit\":\"--output=<path>\"} and any `keryx gdgraph find <query>` run or opening the TUI inspector, both of which call checkGraphStaleness. Outcome: git runs `git diff --name-only -z --output=<path> HEAD` and writes or truncates <path>. Reproduced by the orchestrator in scratch repos, by review-logic (`keryx gdgraph find a`), review-security-code, review-architecture and the Wave C verifier.",
    "suggested_fix": "Spell the call as `[\"diff\", \"--name-only\", \"-z\", ...revisionOperand(fromCommit), toCommit]` inside a try/catch that returns [] on a rejected value, and validate that commit is hex in readProvenance (src/sync/provenance.ts ~235-249). Remove the false ALLOWED entry at src/commands/review-revision-operand.test.ts:184 and add a behavioural row with a hostile provenance file.",
    "evidence": "orch/stale.ts with scratch repos orch/repo and orch/repo2 (graph file at .metaproject/data/gdgraph/storage/nodes.jsonl, two commits) created the target file. mutation-2 does not cover staleness.ts and the scan test skips the file, so nothing in the suite would fail.",
    "confidence": "high",
    "file": "src/gdgraph/staleness.ts",
    "line": 240,
    "quote": "const diff = await gitCmd(cwd, [\"diff\", \"--name-only\", \"-z\", fromCommit, toCommit]);",
    "dedupe_key": "ref-class-staleness",
    "class_scope": {
      "sites": [
        "src/gdgraph/staleness.ts:240 (diff --name-only -z fromCommit toCommit; fromCommit is provenance.commit at line 314)",
        "src/sync/provenance.ts ~235-249 (readProvenance accepts any string)",
        "src/commands/review-revision-operand.test.ts:184 (ALLOWED exemption with a false reason)",
        "callers: keryx gdgraph find and the TUI inspector via checkGraphStaleness"
      ],
      "enumeration_method": "Enumerated every git argv builder that takes a non-literal operand with `keryx ctx rg` (orch/gitsites1.txt, gitsites2.txt, gitsites3.txt in the scratchpad t5pkg-r2 directory): diff, log, show, merge-base, rev-list, rev-parse, cat-file and diff-tree. Classified each by operand origin and whether the subcommand can write a file. staleness.ts:240 is the only remaining unguarded member that can write."
    }
  },
  {
    "id": "F-068",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "In wiki freshness the early `return []` at line 116 makes the assertGitRevision call on the next line dead for a dash-leading value.",
    "impact": "Trigger: `keryx wiki freshness --since=--output=X`. Outcome: no error and no file written, but a silent all-clear report with no changes. The guard intent is lost.",
    "suggested_fix": "Drop the early return and let assertGitRevision throw, or return an explicit error. Add a behavioural row.",
    "evidence": "Read of src/wiki/freshness/run.ts:116-117. Mutant S9 (assert off) survives, which confirms the dead guard.",
    "confidence": "high",
    "file": "src/wiki/freshness/run.ts",
    "line": 116,
    "quote": "if (fromRev.startsWith(\"-\")) return [];",
    "dedupe_key": "wiki-freshness-dead-guard"
  },
  {
    "id": "F-069",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "review-revision-operand.test.ts has no behavioural row for `wiki collect --changed --since=--output=X`. The scan's substring match can be fooled by a decoy, the scan is file-granular (28-file ALLOWED map), and VERBS omits worktree, checkout and similar verbs.",
    "impact": "Trigger: a future edit adds an unguarded call in an already allowed file, or a decoy string satisfies the scan. Outcome: the scan stays green. F-067 is an instance of this gap.",
    "suggested_fix": "Make the scan per call site, not per file. Extend VERBS. Add the wiki collect row.",
    "evidence": "Independent mutation by the testing reviewer (52 mutants) found only these gaps and the tail-position gaps.",
    "confidence": "medium",
    "file": "src/commands/review-revision-operand.test.ts",
    "line": 159,
    "quote": "ALLOWED",
    "dedupe_key": "scan-test-granularity"
  },
  {
    "id": "F-070",
    "reviewer": "review-architecture",
    "severity": "minor",
    "problem": "Residue of F-062. Four sites still spell the guard by hand instead of using revisionOperand: flow-check-ac.ts:192 and :195, sync/diff.ts:78-79, wiki/service.ts:1621-1623 and wiki/freshness/run.ts:116-117. The 8 `ref === undefined ? [] :` ternaries also remain.",
    "impact": "Trigger: a later edit changes one half of a hand-spelled guard. Outcome: the guard and the end-of-options marker drift apart. Mutants C13, S9 and S12 survive for this reason.",
    "suggested_fix": "Use revisionOperand at these sites and add an optional-ref helper for the ternary.",
    "evidence": "Round 1 F-062 recommendation, current source, and mutation-2 survivors C13, S9, S12.",
    "confidence": "high",
    "file": "src/commands/flow-check-ac.ts",
    "line": 192,
    "quote": "\"--end-of-options\", assertGitRevision(head), assertGitRevision(refName)]",
    "dedupe_key": "revision-operand-hand-spelled"
  },
  {
    "id": "F-071",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "problem": "hasExecFlag now also covers shell-spelled options, so the name no longer says what it checks. Its comment sits on the wrong function.",
    "impact": "Trigger: a reader or a later change relies on the name or the comment. Outcome: wrong assumption about what the gate covers, which is how F-066 went unnoticed.",
    "suggested_fix": "Rename it (for example hasUnsafeOption) and move the comment to the function it describes.",
    "evidence": "Read of src/lib/trust-routine-command.ts around lines 105-140.",
    "confidence": "medium",
    "file": "src/lib/trust-routine-command.ts",
    "line": 110,
    "quote": "return words.some(isExecWord) || words.some(isShellSpelledOption);",
    "dedupe_key": "hasexecflag-naming"
  },
  {
    "id": "F-072",
    "reviewer": "review-highload",
    "severity": "minor",
    "problem": "Pre-existing. The routine-command gate has no input length cap, and nested `ctx run --` is quadratic.",
    "impact": "Trigger: a command with 40k nested `ctx run --`. Outcome: the gate takes 13.5 s. Operator-supplied input only.",
    "suggested_fix": "Cap the command length before judging it, or unwrap the nesting iteratively.",
    "evidence": "Measured by the highload reviewer: x40k took 13.5 s.",
    "confidence": "high",
    "file": "src/lib/trust-routine-command.ts",
    "line": 318,
    "quote": "args[0] === \"review\" && hasDashValue(args)",
    "dedupe_key": "gate-length-cap",
    "pre_existing": true
  },
  {
    "id": "F-073",
    "reviewer": "review-regression",
    "severity": "info",
    "problem": "--end-of-options needs git >= 2.24. The README now says so in two places, but there is no `keryx doctor` check.",
    "impact": "Trigger: running on git < 2.24. Outcome: every guarded call fails with a git usage error that does not name the version.",
    "suggested_fix": "Add a doctor check for the git version.",
    "evidence": "Round 1 F-064 recommendation and the README diff.",
    "confidence": "medium",
    "file": "src/lib/git-revision.ts",
    "line": 7,
    "quote": "if (ref.startsWith(\"-\")) throw",
    "dedupe_key": "git-min-version"
  },
  {
    "id": "F-074",
    "reviewer": "review-highload",
    "severity": "info",
    "problem": "isExecWord rebuilds the `${f}=` strings on each step of the loop.",
    "impact": "No observable effect at 200k pairs (422 ms).",
    "suggested_fix": "Hoist the prefixes into a constant list.",
    "evidence": "Timing in the F-060 check.",
    "confidence": "high",
    "file": "src/lib/trust-routine-command.ts",
    "line": 119,
    "quote": "word.startsWith(`${f}=`, at)",
    "dedupe_key": "exec-prefix-rebuild"
  },
  {
    "id": "F-075",
    "reviewer": "review-style",
    "severity": "info",
    "problem": "Naming and comment notes: baseBranchOption in flow.ts does more than parse an option, and the over-refusal comments in the gate do not say which common commands now prompt.",
    "impact": "Readability only.",
    "suggested_fix": "Rename and list the over-refused forms in the comment.",
    "evidence": "Corpus run: 17 of 3227 commands moved from routine to prompt.",
    "confidence": "low",
    "file": "src/commands/flow.ts",
    "line": 401,
    "quote": "return value === undefined ? undefined : assertGitRevision(value);",
    "dedupe_key": "naming-notes"
  },
  {
    "id": "F-076",
    "reviewer": "review-security-code",
    "severity": "info",
    "problem": "Latent cases that are safe today: review-jev-comments.ts:122 takes a ref that defaults to HEAD and no caller overrides, createGhJevCommentsFactsPort has an unvalidated ref that is unreachable, and page-freshness verifiedAt relies on `cat-file -e` failing.",
    "impact": "None today. A future caller that passes a user value would reopen the class.",
    "suggested_fix": "Route these through revisionOperand when next touched.",
    "evidence": "Site enumeration in orch/gitsites1.txt to gitsites3.txt.",
    "confidence": "medium",
    "file": "src/commands/review-jev-comments.ts",
    "line": 122,
    "quote": "ref",
    "dedupe_key": "latent-ref-sites"
  },
  {
    "id": "F-077",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "problem": "Two CLI-spawning tests lack a 60_000 timeout, and a tail `-c` or `--ext-diff` after `=` is pinned only through hasDashValue on the review rows.",
    "impact": "Possible flake on a slow CI runner. A tail spelling on a non-review row has no direct pin.",
    "suggested_fix": "Add the timeout and a direct row for the tail spellings.",
    "evidence": "Testing reviewer's report.",
    "confidence": "low",
    "file": "src/lib/trust-routine-command.test.ts",
    "line": 1,
    "quote": "import",
    "dedupe_key": "test-timeouts-tail"
  }
]
```
