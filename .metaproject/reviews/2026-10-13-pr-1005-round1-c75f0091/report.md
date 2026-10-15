# PR 1005 — review round 1

- Review id: `2026-10-13-pr-1005-round1-c75f0091`
- Target: MrCipherSmith/keryx PR 1005, flow 441 F-045 (`--flag=--option` spelling slipped past the exec-flag gate of `keryx review slice|scope|blast-radius`)
- Orchestrator: `vantage-review` (generic engine: `review-orchestrator`, Keryx v1.11.0)
- Head reviewed: `c75f0091da095a2d90ce0f03ffbf8c29fdb7abd6`; merge-base `4839dbec`; branch `fix/flow-441-f045-exec-flag-equals-spelling`
- Mode: all, deep round, mutation pass, severity-audit. Round 1 of 3.
- Note: the reviewer subagent could not write this file (the harness refuses subagent Write of report.md). The parent assembled it from the hand-back text; the machine-readable block below is `findings.json` of this package, so the report and the ledger agree.

Verdict: request-changes

## Summary

Request changes. The fix closes the reported spelling for the three review commands it names, but the class is wider than the sites it touches: other callers pass a user-controlled ref to git without `--end-of-options`, the gate still misses several shell spellings, and the new tests leave four mutants alive. No blocker.

Counts: 0 blockers, 2 majors, 4 minors (F-061 is expected to be raised to major by severity-audit), 3 info.

## Author gate

The PR body claims were checked against the diff: the nine fixed sites exist, `assertGitRevision` and `--end-of-options` are used where stated, and the test counts match. The claim that the class is closed is not supported (F-057).

## Questions

1. `--diff=-` and similar stdin spellings: should the gate refuse every `--flag=-...` value, or keep a lone `-` routine? Decision noted: a lone `-` glued value stays routine, any other `--flag=-...` is refused (F-059).
2. Git older than 2.24 has no `--end-of-options`. Decision noted: document the requirement in the release note (F-064).

## Pre-existing (never blocks)

- F-065: `git diff --no-index` can read arbitrary paths; unchanged by this PR.

## Not run

- The mounted shell was not run. Cross-family review: not run.

## Routing audit

graph_used: yes (review scope and blast-radius); wiki_used: no (not-relevant); ctx_used: yes; raw_rg_used: no.

## Findings (machine-readable)

```json keryx:findings
[
  {
    "id": "F-057",
    "severity": "major",
    "reviewer": "review-security-code",
    "location_class": "in-diff",
    "file": "src/commands/review.ts",
    "quote": "const diffText = await resolveIngestDiff(defaultGitSpawn, target.ref, target.head, { cwd });",
    "problem": "The fix closes the ref-to-git class at nine hand-picked argv builders (review.ts gitChangedFiles, gitDiff, mergeBaseWithHead and six review-jev-* files) and no more. The sibling consumers of a user-, repo- or manifest-supplied ref still put it after `git merge-base`/`git diff` with no `--end-of-options` and no assertGitRevision: src/commands/flow-check-ac.ts resolveDiffAgainstBase (lines 167, 170) and resolveIngestDiff (191, 194), reached from review.ts:976 (this line, in the changed file), `flow check-ac --diff` (flow.ts:1362), `flow init --base` / flow.json baseBranch (flow.ts:409, flow-check-ac.ts:282) and the TUI flow inspector (tui/inspector-sources.ts:283); and the `--since` operand of health run --changed (health/run.ts:621), test run --changed (testing/service.ts:759) and wiki freshness (wiki/freshness/run.ts:115). When `git merge-base` rejects a dash-leading ref, flow-check-ac falls back to the raw ref and `git diff ... <ref>` reads it as an option.",
    "impact": "Trigger: `keryx flow check-ac <id> --diff=--output=/abs/file`; a committed flow.json whose baseBranch is `--output=/abs/file` (then plain `keryx flow check-ac <id>`, or merely rendering the TUI /flows list, which runs computeAcCheckStaleness with no command at all); `keryx review ingest <dir>` with review.jev.ac_check on and a manifest ref of that shape (the gate judges the ingest row routine); `--since=--output=/abs/file` on health, test or wiki freshness. Outcome, reproduced independently by five reviewers and the orchestrator against the PR head: git writes (truncates and overwrites) the named file with diff text; no prompt on the repo-content paths. The PR's own title and test header claim every place a typed ref reaches git is closed; this class member is the same primitive as F-045.",
    "suggested_fix": "Add one function to src/lib/git-revision.ts that returns the argv fragment (e.g. revisionOperand(ref): string[] = [\"--end-of-options\", assertGitRevision(ref)]) and use it at the nine fixed sites and at flow-check-ac.ts:167/170/191/194, health/run.ts:621, testing/service.ts:759 and wiki/freshness/run.ts:115. In resolveDiffAgainstBase and resolveIngestDiff stop falling back to the raw refName after a failed merge-base. Optionally refuse a dash-leading value at `flow init --base` and when reading baseBranch/target.ref. Replace the 8-file needle pin with a guard that enumerates every non-literal git diff/log/show/merge-base argv in src.",
    "evidence": "Scratch repo, PR-head src/cli.ts: `flow check-ac 001 --diff=--output=<abs>` wrote the file; `flow init --title t --base=--output=<abs>` then `flow check-ac 001` wrote it; `test run --changed --since=--output=<abs>`, `health run --changed --since=--output=<abs>`, `wiki freshness --since=--output=<abs>` wrote it; resolveDiffAgainstBase(defaultGitSpawn, '--output=<abs>') and resolveIngestDiff(defaultGitSpawn, '--output=<abs>', 'HEAD') returned normally with the file created (review-architecture, review-highload, review-logic, review-regression, review-security-code, review-testing-practices; orchestrator probe/q1.ts). `git merge-base HEAD --output=x` exits 129, which is the fallback trigger.",
    "confidence": "high",
    "dedupe_key": "ref-class-not-closed",
    "class_scope": {
      "sites": [
        "src/commands/flow-check-ac.ts:167 (merge-base HEAD refName)",
        "src/commands/flow-check-ac.ts:170 (git diff -U20 ref)",
        "src/commands/flow-check-ac.ts:191 (resolveIngestDiff merge-base)",
        "src/commands/flow-check-ac.ts:194 (resolveIngestDiff git diff)",
        "src/commands/flow-check-ac.ts:282 (opts.diffRef ?? flow.baseBranch ?? origin/main)",
        "src/commands/flow.ts:1362 (--diff) and src/commands/flow.ts:409 (--base)",
        "src/commands/review.ts:976 (ingest ac-check, target.ref/target.head from the manifest)",
        "src/tui/inspector-sources.ts:283 (computeAcCheckStaleness, runs on render)",
        "src/health/run.ts:621 (--since)",
        "src/testing/service.ts:759 (--since)",
        "src/wiki/freshness/run.ts:115 (--since)",
        "src/commands/ctx.ts:204 (ctx diff passthrough, gate-only, see F-058)"
      ],
      "enumeration_method": "keryx ctx rg --all over non-test src for optionValue(args, --ref|--base|--diff|--since|--from|--to|--head|--target) (39 matches, each read) and for every git argv spawn with diff, merge-base, log, show or rev-list (148 matches in 65 files), then each non-literal operand traced to its source (CLI flag, flow.json, review manifest, GitHub payload). Excluded after reading: review/bot/run.ts:184 (GitHub base.sha), flow/service.ts, review-gate.ts, git-worktrees.ts, ci-triage.ts, managed.ts (sha-sourced, hex-validated or no file-writing option), review-jev-comments.ts:122 (ref is the constant HEAD). Only diff, log and show accept --output, so merge-base, rev-parse and rev-list sites were judged read-only. Spawns built through execFile or Bun.$ wrappers were not separately enumerated."
    }
  },
  {
    "id": "F-058",
    "severity": "major",
    "reviewer": "review-security-code",
    "location_class": "in-diff",
    "file": "src/lib/trust-routine-command.ts",
    "quote": "if (w === \"-c\" || EXEC_FLAGS.some((f) => w === f || w.startsWith(`${f}=`))) return true;",
    "problem": "The fixed gate still judges words as the tokenizer left them: splitWords strips quotes but not backslashes, so `\\--output=X`, `--out\\put=X`, `--\\pre=X` and `--ref=\\--output=X` match no EXEC_FLAGS entry and no hasDashValue pattern. A POSIX shell removes the backslash before git or keryx sees the word, so the same file-writing option reaches git. The same applies to `{--output=X}` and `$'--output'=X` under a bash-like sh. `keryx ctx diff` forwards all its arguments to `git diff` (src/commands/ctx.ts:204) with no runtime guard, so for that row and the git read rows the gate is the only protection.",
    "impact": "Trigger: a trust or review-auto turn after an MCP or web result in which the model emits `git diff \\--output=/home/u/file` or `keryx ctx diff \\--output=/home/u/file` (or `keryx ctx rg --\\pre=sh foo`). Outcome, reproduced: isTrustRoutineCommand returns true (no prompt), `sh -c 'git diff \\--output=OUT'` wrote OUT under dash, bash and zsh, and `bun src/cli.ts ctx diff \\--output=OUT` with the PR code wrote OUT. This is the F-045 outcome by a spelling the PR's gate still misses; the review rows are saved by the new runtime refusal, the git and ctx rows are not. The word-splitting weakness predates the PR, but the PR's stated purpose is to make the gate judge every spelling of these options.",
    "suggested_fix": "Fail closed in the gate: treat any word containing a backslash, a brace expansion or `$'` / `$\"` as not routine (or unescape in splitWords before hasExecFlag judges it). Add `assertGitRevision` and `--end-of-options` for the base operand in ctx diff and reject dash-leading args it does not own. Pin tests for `\\--output=`, `--out\\put=`, `--ref=\\--output=` and `--\\pre=`.",
    "evidence": "Gate: `git diff \\--output=/tmp/x`, `git diff --out\\put=/tmp/x`, `keryx ctx diff \\--output=/tmp/x`, `keryx review slice --ref=\\--output=/tmp/x` all true (orchestrator v.ts and review-security-code, review-logic, review-regression probes); execution under sh wrote the file (orchestrator, throwaway temp repo). git rejects abbreviated options (`--out=` exits 129), so only the backslash-split spelling works.",
    "confidence": "high",
    "dedupe_key": "gate-backslash-flag-spelling",
    "class_scope": {
      "sites": [
        "src/lib/trust-routine-command.ts:111 hasExecFlag (EXEC_FLAGS match on the raw word)",
        "src/lib/trust-routine-command.ts:118 hasDashValue (regex on the raw word)",
        "src/lib/shell-syntax.ts splitWords / METACHARACTERS (no backslash, brace or $' handling)",
        "src/lib/trust-routine-command.ts:319 GIT_READ_SUBCOMMANDS row (status diff log show rev-parse rev-list ls-files merge-base blame)",
        "keryx ctx diff and ctx rg rows (ctx.ts:204 passthrough, --pre)",
        "keryx review slice, scope, blast-radius, floor rows (protected at runtime by assertGitRevision once unescaped)",
        "src/commands/agent.ts:5650 (only production caller of isTrustRoutineCommand)"
      ],
      "enumeration_method": "isTrustRoutineCommand run over about 65 spellings (glued, spaced, quoted, uppercase, split-quote, backslash, brace, $'..') for each git read subcommand, ctx diff and ctx rg and each review row; each spelling the gate accepted was executed under /bin/sh (dash), bash and zsh, and through the PR CLI for the ctx and review rows. keryx ctx rg for isTrustRoutineCommand found one production caller."
    }
  },
  {
    "id": "F-059",
    "severity": "minor",
    "reviewer": "review-logic",
    "location_class": "in-diff",
    "file": "src/lib/trust-routine-command.ts",
    "quote": "return words.some((w) => /^--[^=]+=-/.test(w));",
    "problem": "hasDashValue refuses every `--flag=-...` word on a review entry, including the documented stdin spellings: `--diff=-`, `--result=-`, `--payload=-`, `--scope=-`, `--refuted=-`, `--source=-`, `--catalog=-` (the readers treat a lone `-` as standard input). The separated form (`--diff -`) stays routine, so one request has two verdicts. Its doc comment (\"No routine review command is spelled that way\") is false, and `--since=-1` (ledger build) and `git log --grep=-c` now prompt as well.",
    "impact": "Prompt only, fail closed: under review-auto `keryx review slice --diff=-`, `review complete --result=-`, `review ingest --scope=-` were routine at the base and now ask; 48 of 1445 differential verdicts changed, all true to false. No safety loss; the comment and the stays-routine test misstate the intent.",
    "suggested_fix": "Decide per case. Either exempt a lone `-` value (/^--[^=]+=-.+/ or compare w.slice(eq + 1) !== \"-\") and add a stays-routine test for `--diff=-`, or keep the rule and correct the comment and add a prompts test that names the stdin spellings.",
    "evidence": "isTrustRoutineCommand base vs head: `review slice --diff=-` true to false; `review complete --result=-` false, `--result -` true; `review ingest --scope=-` false; `review ledger build --since=-1` true to false; `git log --grep=-c` true to false (orchestrator v.ts, review-logic gate.ts, review-highload diffcorpus.ts, review-architecture, review-testing-practices).",
    "confidence": "high",
    "dedupe_key": "dash-value-overblocks-stdin"
  },
  {
    "id": "F-060",
    "severity": "minor",
    "reviewer": "review-performance",
    "location_class": "in-diff",
    "file": "src/lib/trust-routine-command.ts",
    "quote": "return w.startsWith(\"-\") && eq !== -1 && hasExecFlag([w.slice(eq + 1)]);",
    "problem": "hasExecFlag now recurses once per `=` in a word that keeps starting with `-`, copies the tail with slice at each level, and has no depth bound. A single word of about 34 KB (`--ref=` followed by `-=` repeated about 17000 times) overflows the stack. Before the PR hasExecFlag was a flat words.some and could not throw.",
    "impact": "Trigger: a crafted single-word shell command of tens of KB. Outcome, reproduced (orchestrator, `--ref=` + `-=` x 50000): isTrustRoutineCommand throws RangeError (Maximum call stack size exceeded) instead of returning a verdict; the base returned true. The only caller, agent.ts:5650, sits inside executeCall whose catch (agent.ts:4391) turns it into a per-call error, so it fails closed: an errored tool call, not an auto-approval.",
    "suggested_fix": "Make it a loop: for a word starting with `-`, step through successive `=` positions, test each tail against `-c` and EXEC_FLAGS, and stop at the first tail that does not start with `-`. Same verdicts, constant stack, no copies. Or return false for any command over a few KB.",
    "evidence": "isTrustRoutineCommand('keryx review slice --ref=' + '-='.repeat(n)): n=10000 false in 27 ms; n=50000 RangeError; threshold about 16875 pairs (review-highload thresh.ts, review-performance m.ts, orchestrator v.ts).",
    "confidence": "high",
    "dedupe_key": "hasexecflag-recursion-depth"
  },
  {
    "id": "F-061",
    "severity": "minor",
    "reviewer": "review-testing-practices",
    "location_class": "in-diff",
    "file": "src/commands/review-revision-operand.test.ts",
    "quote": "expect(text.split(needle).length - 1, `${file}: ${needle}`).toBe(times);",
    "problem": "The tests leave the PR's own guarantees partly unpinned. (a) The six JEV_HOSTILE rows return early when Jev is off (the CI default), so they pass on the buggy code; only the source-text needle count guards the six jev call sites in CI. (b) The needle count is textual and hand-listed: it passes when the needle sits in a comment (mutant R9) or the condition around it is inverted (R8), and it cannot see an unlisted site (F-057 is exactly that). (c) In trust-routine-command.test.ts the title `whatever the option is` is wider than the cases (only --ref and --base): narrowing the regex to `^--(ref|base)=-` (G6) and replacing the recursion with a one-level check (G1) both survive. (d) The `review floor` row does not exercise the bug (floor died in merge-base before the fix), `outside` is one shared path never removed between cases, and `not.toBe(0)` passes on any crash.",
    "impact": "Maintenance cost with a named trigger: a later edit that drops the guard at a jev site in a way the needle still matches, or narrows the gate to known flags, ships green. No wrong behaviour at the PR head. Mutation evidence: G1, G6, R8, R9 survived; G2, G3, G4, G7, G8, G9, R1, R2, R3, R6, R7 were killed.",
    "suggested_fix": "Put the argv construction in one helper (F-062) and unit-test it; drive the six jev gitDiffFor* helpers directly or enable Jev in the scratch repo; give each hostile row its own output path removed afterwards and assert the refusal text; add `keryx review slice --diff=-U0`, `review scope --context=-1` to the prompt list and `git diff --a=--b=--output=/x`, `keryx flow status --a=--b=--output=/x` to the exec-flag list; add a repo-wide scan that fails on a non-literal git diff/log/show/merge-base argv without the helper.",
    "evidence": "mutant:G1 mutant:G6 mutant:R9 mutant:R8b-condition-inverted-needle-intact survived in mutation-1.md and mutation-2.md (research-evidence); killed: G2-no-recursion, G7-dashvalue-off, G8-dashvalue-never, R1-assert-off, R2, R3, R4, R8 (needle changed), R10. review-testing-practices: pre-fix sources with the post-fix test under `env -i CI=true` pass the jev test (6 expect(), no failure); hostile.sh on pre-fix sources: floor exits 2 with no file. Corroborated by review-logic, review-security-code, review-architecture, review-highload, review-style.",
    "confidence": "high",
    "dedupe_key": "tests-weak-jev-pin-and-gate-mutants"
  },
  {
    "id": "F-062",
    "severity": "minor",
    "reviewer": "review-clean-code",
    "location_class": "in-diff",
    "file": "src/commands/review.ts",
    "quote": "const command = [\"git\", \"diff\", \"--no-color\", `-U${contextLines}`, ...(ref === undefined ? [] : [\"--end-of-options\", assertGitRevision(ref)])];",
    "problem": "The two-obligation rule (refuse a leading dash, then put --end-of-options before the operand) is spelled out by hand at nine argv builders: the same ternary at eight sites (review.ts gitChangedFiles and gitDiff, six review-jev-* files) and a differently shaped ninth (mergeBaseWithHead). assertGitRevision already lives in src/lib, so a lib-level helper would widen no export surface.",
    "impact": "No wrong behaviour today. Trigger for harm: the next git call that takes a typed ref copies an older `[ref]` spelling and F-045 returns there; the source-count test only protects the sites it lists (see F-057, F-061).",
    "suggested_fix": "Add to src/lib/git-revision.ts `export function revisionOperand(ref: string | undefined): string[] { return ref === undefined ? [] : [\"--end-of-options\", assertGitRevision(ref)]; }` and use `...revisionOperand(ref)` at the eight sites and in the merge-base call. One unit test on the helper then replaces the eight text-count assertions.",
    "evidence": "keryx ctx rg 'ref === undefined \\? \\[\\]|assertGitRevision|--end-of-options' over non-test src: 18 matches in 8 files (review-clean-code); the same duplication noted by review-style, review-architecture and review-logic.",
    "confidence": "high",
    "dedupe_key": "revision-operand-duplicated"
  },
  {
    "id": "F-063",
    "severity": "info",
    "reviewer": "review-style",
    "location_class": "in-diff",
    "file": "src/lib/trust-routine-command.ts",
    "quote": "// a revision, and the next layer down may read it as an option, so every `=` value is judged as a word of its own.",
    "problem": "Wording and naming nits. The comment (and the matching test comment) says git reads the glued value; in the bug keryx's own optionValue splits `--ref=` first and hands the value to git, which then reads it as an option. assertGitRevision is an assert that returns its argument and only rejects a leading `-` (it says nothing about existence), and its doc comment names --ref and --base but the function also guards --diff. The recursive hasExecFlag re-enters through a one-element array.",
    "impact": "Names neither a trigger nor an outcome: the code is right; a reader may misattribute who parses the value, or assume assertGitRevision checks that the ref exists.",
    "suggested_fix": "Reword the comment (\"keryx hands the value glued after `=` on to git, which reads an option-shaped value as an option\"); add --diff to the git-revision.ts doc comment or rename to checkedGitRevision; optionally extract isExecWord(w).",
    "evidence": "trust-routine-command.ts lines 107-113, git-revision.ts doc comment and line 7, review-revision-operand.test.ts header.",
    "confidence": "medium",
    "dedupe_key": "comment-and-name-nits"
  },
  {
    "id": "F-064",
    "severity": "info",
    "reviewer": "review-security-code",
    "location_class": "in-diff",
    "file": "src/lib/git-revision.ts",
    "quote": "if (ref.startsWith(\"-\")) throw new Error(`Refusing the revision \"${ref}\": a revision never starts with \"-\".`);",
    "problem": "`--end-of-options` needs git >= 2.24 (Nov 2019) and this repository used it nowhere before; no minimum git is documented in README, docs, package.json or keryx doctor. On an older git every guarded diff and merge-base fails with a git usage error, for every ref, not only hostile ones.",
    "impact": "Names no default trigger. CI (ubuntu-latest, one macos-latest) and the local 2.43.0 are fine; the option was verified on git 2.25.1 (Ubuntu 20.04) and 2.34.1 (22.04).",
    "suggested_fix": "State git >= 2.24 in the docs or have keryx doctor check it.",
    "evidence": "review-regression (2.25.1 and 2.34.1), review-logic, review-highload, review-performance, review-security-code; keryx ctx rg for --end-of-options lists only this PR's files.",
    "confidence": "medium",
    "dedupe_key": "git-minimum-version"
  },
  {
    "id": "F-065",
    "severity": "info",
    "reviewer": "review-logic",
    "location_class": "pre-existing",
    "file": "src/lib/trust-routine-command.ts",
    "quote": "return words[1] !== undefined && GIT_READ_SUBCOMMANDS.has(words[1]) && !hasExecFlag(words);",
    "problem": "Other routine git read options are not covered by EXEC_FLAGS: `git diff --no-index <file> /dev/null` reads any file and is routine, and `--textconv` is routine. Neither writes a file.",
    "impact": "Names no trigger that writes or executes; a confidentiality note only, and the model can already read project files. Existed before the PR.",
    "suggested_fix": "None required here; if the operator wants git read rows confined to the repository, add --no-index to the refused list in a separate change.",
    "evidence": "review-security-code and review-logic gate probes (gate3.ts): both routine at base and head.",
    "confidence": "medium",
    "dedupe_key": "git-no-index-routine"
  }
]
```
