STATUS: DONE

```REVIEW_RESULT
{
  "status": "DONE_WITH_CONCERNS",
  "reviewer": "review-highload",
  "summary": "The gate and the six jev + review.ts git calls are sound: no unbounded input in the git calls, legitimate refs behave the same under --end-of-options. Two real problems: the class claim is false (flow-check-ac.ts still hands a repo-supplied ref to git diff, reproduced end to end), and hasExecFlag's new recursion overflows the stack on a ~34 KB word.",
  "findings": [
    {
      "id": "F-001",
      "reviewer": "review-highload",
      "severity": "major",
      "file": "src/commands/flow-check-ac.ts",
      "quote": "const diff = await spawn([\"git\", \"diff\", \"--no-color\", \"-U20\", ref], opts);",
      "problem": "resolveDiffAgainstBase and resolveIngestDiff (lines 167, 170, 191, 194) pass refName/head to git merge-base and git diff with no --end-of-options and no assertGitRevision. refName is opts.diffRef (flow check-ac --diff), flow.baseBranch (flow init --base=..., stored raw in flow.json, never validated on read) or, in resolveIngestDiff, the review manifest's target.ref/head. When merge-base fails on an option-shaped ref, ref falls back to refName and git diff reads it as an option.",
      "impact": "Same primitive as F-045: git diff --output=<abs> truncates and writes an arbitrary file. Entry points with no hostile flag on the command line: (1) keryx flow check-ac <id> reading a committed flow.json baseBranch; (2) the TUI flow inspector, loadInspectorFlows -> computeAcCheckStaleness (src/tui/inspector-sources.ts:283), which runs it on render with no command at all; (3) keryx review ingest <dir>, which the gate judges routine (true), reading the committed manifest ref/head when review.jev.ac_check is on (src/commands/review.ts:976). The PR says every consumer is closed; this one is not.",
      "evidence": "Scratch repo, real CLI: `keryx flow init --title t --base=--output=<victim>` stored baseBranch \"--output=<victim>\" in flow.json; then `keryx flow check-ac 001` (no flag) exit 0 and <victim>, pre-filled with ORIGINAL, now holds \"diff --git a/f.ts b/f.ts ...\". Direct calls resolveDiffAgainstBase(defaultGitSpawn, \"--output=<victim>\") and resolveIngestDiff(..., \"HEAD\") overwrote it the same way. Gate: `keryx review ingest .metaproject/reviews/x` -> true; `keryx flow check-ac 441` -> false (prompts, but shows nothing hostile). Scripts: scratchpad/highload/e2e.ts, siblings.ts.",
      "suggested_fix": "In both functions: `[\"git\",\"merge-base\",\"--end-of-options\",\"HEAD\",assertGitRevision(refName)]`, `[\"git\",\"diff\",\"--no-color\",\"-U20\",\"--end-of-options\",assertGitRevision(ref)]`, and the same for `head` in resolveIngestDiff (diff ref head becomes `--end-of-options ref head`). Optionally refuse a leading `-` at `flow init --base`. Add the two files to the source-pin list in review-revision-operand.test.ts, plus a runtime test through defaultGitSpawn.",
      "confidence": "high",
      "class_scope": {
        "sites": [
          "src/commands/flow-check-ac.ts:167,170,191,194 (UNFIXED, reproduced)",
          "src/health/run.ts:621 git diff --name-only <--since> (unfixed; keryx health run --changed --since=; non-routine, prompts)",
          "src/testing/service.ts:759 git diff --name-only <--since> (unfixed; keryx test run --since=; non-routine, prompts)",
          "src/commands/ctx.ts:204 git diff ...args (passthrough by design; gated by EXEC_FLAGS, abbreviations rejected by git)",
          "src/review/bot/run.ts:184 baseSha...HEAD (GitHub API sha, trusted)",
          "src/review/managed.ts:1184, src/review/ci-triage.ts:438 git show <sha>:<path> (sha from local rev-parse / hex-validated head / gh payload; not traced further)",
          "src/commands/review-jev-comments.ts:122 git log <ref> (ref is the constant default HEAD at both callers)",
          "src/flow/service.ts:2527-2550, src/flow/review-gate.ts:1904,1968, src/lib/git-worktrees.ts:224 (rev-parse/merge-base/rev-list: no file-writing option; flow/service prefixes origin/)",
          "FIXED: review.ts gitDiff, gitChangedFiles, mergeBaseWithHead; review-jev-{select,risk,contract,docs,scenarios,rules}.ts"
        ],
        "enumeration_method": "keryx ctx rg --all over src (non-test) for git/gh spawn argv: `\"git\", \"(diff|merge-base|log|show|rev-parse|rev-list|...)\"`, gitOutput([, gitLines([, plus callers of resolveDiffAgainstBase/resolveIngestDiff/gitDiff/gitChangedFiles/mergeBaseWithHead; each ref source traced to its flag, flow.json, manifest or payload. Only diff/log/show accept --output, so merge-base/rev-parse/rev-list sites were judged read-only. Spawns built in other shapes (execFile, Bun.$, helper wrappers outside these names) were not separately enumerated."
      }
    },
    {
      "id": "F-002",
      "reviewer": "review-highload",
      "severity": "minor",
      "file": "src/lib/trust-routine-command.ts",
      "quote": "return w.startsWith(\"-\") && eq !== -1 && hasExecFlag([w.slice(eq + 1)]);",
      "problem": "hasExecFlag recurses once per `=` in a word that keeps starting with `-`, with no depth bound. Depth grows with the input, so a word like `--ref=` + `-=` x 17000 overflows the stack.",
      "impact": "isTrustRoutineCommand throws RangeError for a command of about 34 KB instead of answering. Base returned true for the same input (no recursion). The only caller, agent.ts:5650, runs inside executeCall, whose catch at agent.ts:4391 turns it into a per-call error, so it fails closed, not open; the cost is an errored tool call. Time is fine (10k pairs: 27 ms).",
      "evidence": "`isTrustRoutineCommand(\"keryx review slice --ref=\" + \"-=\".repeat(n))`: n=10000 -> false in 27 ms; n=50000, 200000, 1000000 -> RangeError (head), true (base). Threshold about 16875 pairs. scratchpad/highload/thresh.ts.",
      "suggested_fix": "Make it a loop: `let v = w; while (v.startsWith(\"-\") && v.includes(\"=\")) { v = v.slice(v.indexOf(\"=\") + 1); if (matchesExec(v)) return true; }`, or cap the depth.",
      "confidence": "high"
    },
    {
      "id": "F-003",
      "reviewer": "review-highload",
      "severity": "minor",
      "file": "src/lib/trust-routine-command.ts",
      "quote": "return words.some((w) => /^--[^=]+=-/.test(w));",
      "problem": "hasDashValue refuses `--diff=-`, but `-` is the documented stdin sentinel of --diff (readDiffSource, review.ts:3581; docs/docs/cli-reference.md:5827 uses the spaced form). The spaced `--diff -` stays routine, the glued `--diff=-` now prompts.",
      "impact": "Over-block: `keryx review slice|scope|blast-radius|... --diff=-` was routine at base and now asks. A prompt only, no loss of safety, and an inconsistent verdict for two spellings of one thing.",
      "evidence": "Differential run of base (git archive 4839dbec) against head over 1445 commands (docs-harvested plus table rows x flags): 48 verdicts changed, all true -> false. Hostile ones are intended. Legitimate: `--diff=-` on every review verb. `--max-files=-1` is not a legitimate value. No `--flag=-...` appears in skills, rules or docs. scratchpad/highload/diffcorpus.ts.",
      "suggested_fix": "Exempt exactly `--diff=-` in hasDashValue (value `-` for the --diff flag only), and add it to the 'stays routine' test.",
      "confidence": "high"
    },
    {
      "id": "F-004",
      "reviewer": "review-highload",
      "severity": "info",
      "file": "src/commands/review.ts",
      "quote": "const { stdout, stderr, exitCode } = await gitOutput([\"merge-base\", \"--end-of-options\", \"HEAD\", assertGitRevision(ref)]);",
      "problem": "--end-of-options needs git >= 2.24 (Nov 2019). The repo had no use of it before this PR and documents no minimum git version.",
      "impact": "CI is ubuntu-latest (git 2.43 here), so it passes. A user on git < 2.24 gets a git error on every review command that takes a ref. Not measured: no old git available.",
      "evidence": "keryx ctx rg for --end-of-options in src (non-test) lists only this PR's files; .github/workflows use ubuntu-latest only; no minimum-git text in README, docs, doctor.ts. Also: `--ref f.ts` (a path used as a ref) now yields an empty diff silently (plain git printed f.ts); not a supported use.",
      "suggested_fix": "State git >= 2.24 in the docs or in keryx doctor.",
      "confidence": "medium"
    },
    {
      "id": "F-005",
      "reviewer": "review-highload",
      "severity": "info",
      "file": "src/commands/review-revision-operand.test.ts",
      "quote": "// These return early when Jev is not enabled (the CI default), so their exit code proves nothing there; the source pin below covers their call sites.",
      "problem": "The jev runtime test is vacuous when Jev is off (as it states). The compensating source pin counts needle strings in eight named files, so it catches removing a fix at a known site but cannot see a new site (F-001) or a site outside the list.",
      "impact": "The class claim is guarded only at the sites someone remembered. Mutation view by reading, not executed: dropping assertGitRevision or --end-of-options alone at a jev site is caught only by the pin; dropping hasDashValue or the recursion is caught by the gate tests.",
      "evidence": "Test lines 219-227, 263-278.",
      "suggested_fix": "Add a repo-wide guard: every `\"git\", \"diff\"|\"log\"|\"show\"` argv in src carrying a variable operand must contain --end-of-options, or be on a reviewed allowlist.",
      "confidence": "medium"
    }
  ],
  "stats": { "blocker": 0, "major": 1, "minor": 2, "info": 2 }
}
```

## High-Load Review, PR 1005 round 1 (concurrency and load)

**Findings**
- F-001 major: flow-check-ac.ts (resolveDiffAgainstBase, resolveIngestDiff) still passes a flow.json baseBranch, `--diff` value or manifest ref/head to `git diff` bare. Reproduced: `flow init --base=--output=<f>` then `flow check-ac 001` overwrote `<f>`. Reachable from the TUI inspector and routine `review ingest` with no hostile flag. The class is not closed.
- F-002 minor: hasExecFlag recursion overflows the stack at about 34 KB (RangeError; caught upstream, fails closed).
- F-003 minor: `--diff=-` (stdin) newly prompts; spaced `--diff -` still routine.
- F-004 info: git >= 2.24 is now required, undocumented. CI ubuntu-latest, local 2.43.0.
- F-005 info: jev runtime test vacuous when Jev is off; source pin cannot see new sites.

**Questions**
- Should `flow init --base` and `flow.json` baseBranch be validated on write and read, so repo content cannot carry an option-shaped base?

**Pre-existing (not blocking)**
- health/run.ts:621 and testing/service.ts:759 take `--since` bare; both commands are non-routine, so the operator is asked.
- readFlow does not validate baseBranch (F-001 feeds on it).

**Verified clean**
- Legit refs under `git diff --end-of-options` and `merge-base --end-of-options HEAD`: HEAD~1, HEAD^, HEAD^{}, HEAD^{commit}, tag, branch, a..b and a...b (diff), @, HEAD@{0}, :/x all exit as plain git does. `a..b` as a merge-base operand fails 128 with and without the flag (unchanged). `@{u}` is 128 in both with no upstream.
- `--end-of-options` + `--output=...` -> 128, no file written. Git rejects abbreviated `--outpu=`/`--out=` (129), so EXEC_FLAGS exact match is enough there.
- Gate: `--ref=--outpu=`, `--ref --output=` refused; plain `--ref=HEAD`, `HEAD~1..HEAD`, `HEAD^{}`, `@{u}` stay routine. No per-call process, pool or queue added; the git calls are bounded as before.
- Callers of gitDiff/gitChangedFiles/mergeBaseWithHead in review.ts all go through the fixed helpers; merge-base output (a sha) is what the second gitDiff gets.

Routing audit: graph_used no (not-relevant, call-site enumeration via rg); wiki_used no (not-relevant); ctx_used yes; raw_rg_used no. Side effect: `keryx ctx rg` wrote gitignored gdctx artifacts under the worktree's .metaproject/data/gdctx; nothing tracked was touched.
