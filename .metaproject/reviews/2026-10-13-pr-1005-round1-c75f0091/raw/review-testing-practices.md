STATUS: DONE

```REVIEW_RESULT
{
  "status": "DONE_WITH_CONCERNS",
  "reviewer": "review-testing-practices",
  "summary": "Both test files pass at HEAD (full copy of the tree in scratch) and fail on the bug when run in the author's environment. Three weaknesses: the six jev e2e rows are vacuous in a CI-like environment, the source pin is textual and hand-listed, and two gate mutants survive. No blocker or major in the PR's own tests.",
  "findings": [
    {
      "id": "T-1", "severity": "minor", "reviewer": "review-testing-practices",
      "file": "src/commands/review-revision-operand.test.ts",
      "quote": "// These return early when Jev is not enabled (the CI default), so their exit code proves nothing there; the source pin below covers their call sites.",
      "problem": "The test 'no jev command lets a --flag=--output=<file> revision make git write a file' cannot fail on the bug where Jev is off. The comment says so, but the test name claims otherwise and it is not skipped or marked. Whether it is live depends on the machine: jev-select reaches git only when OPENROUTER_API_KEY resolves (readJevSelectEnabledDetailed is default-on with /external on plus a credential); the other five need a tasks.config.json flag the scratch repo never has.",
      "impact": "In CI the only guard of the six jev call sites is the textual pin (T-2). On a developer machine with a Jev key the same test runs jev-select for real and would reach OpenRouter if the guard regressed.",
      "evidence": "Pre-fix sources (git show 4839dbec for the 8 changed files) + post-fix test file: `env -i PATH HOME=<empty> CI=true bun test src/commands/review-revision-operand.test.ts -t 'jev command'` => (pass), 6 expect(). Same sources in my shell (OPENROUTER_API_KEY set) => (fail) with the file written. The full unfiltered run fails the jev test on the bug only because the first test left `outside-file` in the shared repo (see T-5), not because of a jev site.",
      "suggested_fix": "Drive the jev call sites below the CLI gate: export the six gitDiffFor* helpers (or one shared helper in git-revision.ts) and assert directly that a ref starting with - throws and that argv carries --end-of-options. Or write the opt-in flag into the scratch repo's .metaproject/tasks.config.json and set the Jev key env to a dummy with the network stubbed. Rename the test to say what it checks.",
      "confidence": "high"
    },
    {
      "id": "T-2", "severity": "minor", "reviewer": "review-testing-practices",
      "file": "src/commands/review-revision-operand.test.ts",
      "quote": "expect(text.split(needle).length - 1, `${file}: ${needle}`).toBe(times);",
      "problem": "The pin counts a substring in source text. It passes on a comment or dead code carrying the needle, and on code that keeps the needle but breaks the surrounding expression. The site list is hand-written: a new or unlisted git call that takes a typed ref is invisible to it.",
      "impact": "It is the sole CI guard for six of eight sites. Removal of --end-of-options is caught (R3, R6, R7 killed); misplacement is not.",
      "evidence": "Mutants run under a CI-like env: R8 (invert `ref === undefined` in review-jev-docs.ts, needle intact; tsc would flag it, bun test does not) SURVIVED; R9 (needle moved into a trailing comment, live code `[ref]`) SURVIVED. Unlisted siblings exist, see P-1.",
      "suggested_fix": "Put the argv construction in one helper, e.g. gitRevisionArgs(ref) => ['--end-of-options', assertGitRevision(ref)], unit-test that helper, and have the pin assert every call site calls the helper. Add a repo-wide scan that fails on `\"git\", \"diff\"` / `merge-base` argv built with a non-literal unless it goes through the helper.",
      "confidence": "high"
    },
    {
      "id": "T-3", "severity": "minor", "reviewer": "review-testing-practices",
      "file": "src/lib/trust-routine-command.test.ts",
      "quote": "test(\"F-045: a review flag glued to a value that starts with - prompts, whatever the option is\", () => {",
      "problem": "The title says 'whatever the option is' but the cases use only --ref and --base, and the recursion in hasExecFlag is only exercised through hasDashValue for review commands. Two mutants survive.",
      "impact": "A later narrowing of the gate to the known flags, or loss of recursion for non-review commands, ships green.",
      "evidence": "G6: hasDashValue regex /^--[^=]+=-/ -> /^--(ref|base)=-/ SURVIVED (a --diff=-U0 or --context=-1 review command would be routine again). G1: hasExecFlag recursion replaced by a one-level check SURVIVED (no non-review case has two glued levels, e.g. `git diff --a=--b=--output=/x`). Killed: G2, G3, G4, G7, G8, G9.",
      "suggested_fix": "Add `keryx review slice --diff=-U0`, `keryx review scope --context=-1` to the prompt list, and `git diff --a=--b=--output=/x`, `keryx flow status --a=--b=--output=/x` to the exec-flag list.",
      "confidence": "high"
    },
    {
      "id": "T-4", "severity": "minor", "reviewer": "review-testing-practices",
      "file": "src/lib/trust-routine-command.ts",
      "quote": "/** A `--flag=-...` word: the glued value is an option, not a value. No routine review command is spelled that way. */",
      "problem": "The comment is false and no test pins the over-blocking. The stdin spelling is a glued dash value: `--source=-`, `--catalog=-` (optionValue accepts the `=` form; review.ts reads stdin when the value is `-`).",
      "impact": "Prompt-only, fail closed: commands that were routine before now ask. Not unsafe, but the 'stays routine' list is the place to say which ones are intended.",
      "evidence": "isTrustRoutineCommand, pre vs post: `keryx review ingest --source=-` true -> false; `keryx review reviewers --catalog=-` true -> false; `keryx review ledger build --since=-1` true -> false; `git log --grep=-c` true -> false (hasExecFlag now reads the glued -c).",
      "suggested_fix": "Decide per case. Either exempt a bare `-` value from hasDashValue (`=-$` stays routine) or state in the comment and a test that these now prompt.",
      "confidence": "high"
    },
    {
      "id": "T-5", "severity": "minor", "reviewer": "review-testing-practices",
      "file": "src/commands/review-revision-operand.test.ts",
      "quote": "[\"review\", \"floor\", `--ref=--output=${outside}`],",
      "problem": "(a) The floor row does not exercise the bug: before the fix `review floor` reached `git merge-base HEAD --output=...`, which failed (exit 2, no file), so the row passes on the old code. (b) `outside` is one path shared by all rows and both tests and is never removed between cases, so a leak in one case fails every later assertion and blames the wrong command. (c) The not.toBe(0) check passes on any crash: with a copy of the tree missing docs/ the CLI died at import and four of six tests still passed, only 'a real revision still slices' caught it.",
      "impact": "Weak attribution and a decorative row; no false green in the current tree.",
      "evidence": "hostile.sh on pre-fix sources: slice/scope/jev-select wrote the file (exit 0), blast-radius wrote it (exit 1), floor: exit=2 file=no.",
      "suggested_fix": "Give each case its own output path and rmSync it after; assert the refusal text (`Refusing the revision`) in the CLI row, not just a non-zero exit; keep floor only as a runtime-refusal row.",
      "confidence": "medium"
    },
    {
      "id": "T-6", "severity": "info", "reviewer": "review-testing-practices",
      "file": "src/commands/review-revision-operand.test.ts",
      "quote": "const child = Bun.spawnSync([\"bun\", CLI, ...args], { cwd: repo, stdout: \"pipe\", stderr: \"pipe\" });",
      "problem": "Environment assumptions: `bun` is looked up on PATH (process.execPath is the running binary); spawnSync blocks the event loop so the 120_000 test timeout cannot interrupt a hung child; `git commit` in the scratch repo honours a global commit.gpgsign or hooks template; the legitimate-ref run uses only `HEAD`.",
      "impact": "None in CI (ubuntu-latest, setup-bun, git 2.4x). `--end-of-options` needs git >= 2.24 (2019); a user on git < 2.24 gets 'bad revision' for every typed ref, and the 'real revision' test is what would show it.",
      "evidence": "Local git 2.43.0, bun 1.4.2. Manually confirmed under git 2.43: `git diff --end-of-options 'HEAD^{}'`, `HEAD~1`, `HEAD~1..HEAD`, `HEAD~1...HEAD`, `git merge-base --end-of-options HEAD 'HEAD^{}'` all work; slice with --ref=HEAD~1 and ranges returns the diff.",
      "suggested_fix": "Use process.execPath; pass -c commit.gpgsign=false; add HEAD~1 and a range to the real-revision test; state the git >= 2.24 floor in the docs.",
      "confidence": "medium"
    },
    {
      "id": "P-1", "severity": "major", "reviewer": "review-testing-practices", "location_class": "pre-existing",
      "file": "src/commands/flow-check-ac.ts",
      "quote": "const diff = await spawn([\"git\", \"diff\", \"--no-color\", \"-U20\", ref], opts);",
      "problem": "The PR says the class is closed, but a sibling consumer of a typed or repo-supplied ref still passes it to git bare. resolveDiffAgainstBase takes refName = flow.baseBranch (committed flow metadata) or origin/main; with `--output=<file>` the merge-base call fails, so ref falls back to refName and `git diff ... --output=<file>` writes the file.",
      "impact": "A repo whose flow names baseBranch `--output=/path` makes `keryx flow check-ac` write that file. Existed before this PR; not blocking.",
      "evidence": "Scratch repo, HEAD code: resolveDiffAgainstBase(spawn, `--output=<cwd>/sib-out`) => 'wrote file: true'. Not reproduced for the other sites listed.",
      "suggested_fix": "Route all through one helper (T-2) and pass flow-check-ac.ts:167/170/191/194 through it.",
      "confidence": "high",
      "class_scope": {
        "sites": ["src/commands/flow-check-ac.ts:167,170,191,194", "src/sync/diff.ts:78", "src/health/run.ts:621", "src/wiki/freshness/run.ts:115", "src/commands/review-jev-comments.ts:122", "src/commands/ctx.ts:204"],
        "enumeration_method": "keryx ctx rg --all over src (non-test) for git argv with \"diff\", \"merge-base\", \"log\", \"show\", \"rev-list\"; then read the lines that take a non-literal ref. Only flow-check-ac.ts was reproduced; the others are unverified candidates for the security reviewer."
      }
    }
  ],
  "stats": { "blocker": 0, "major": 1, "minor": 5, "info": 1 },
  "mutants": [
    { "id": "G1", "file": "src/lib/trust-routine-command.ts", "anchor": "hasExecFlag([w.slice(eq + 1)])", "replacement": "(w.slice(eq + 1) === \"-c\" || EXEC_FLAGS.some((f) => w.slice(eq + 1) === f || w.slice(eq + 1).startsWith(`${f}=`)))", "note": "one level of glue only; survives, no non-review two-level case" },
    { "id": "G6", "file": "src/lib/trust-routine-command.ts", "anchor": "/^--[^=]+=-/", "replacement": "/^--(ref|base)=-/", "note": "gate narrowed to known flags; survives" },
    { "id": "R8", "file": "src/commands/review-jev-docs.ts", "anchor": "...(ref === undefined ? [] :", "replacement": "...(ref !== undefined ? [] :", "note": "needle intact, ref dropped; survives under CI env (tsc catches it)" },
    { "id": "R9", "file": "src/commands/review-jev-docs.ts", "anchor": "...(ref === undefined ? [] : [\"--end-of-options\", assertGitRevision(ref)])];", "replacement": "...(ref === undefined ? [] : [ref])]; // \"--end-of-options\", assertGitRevision(ref)", "note": "needle in a comment; survives under CI env" }
  ]
}
```

## Summary

Method: ran both test files against a full scratch copy of HEAD (6/6 and 93/93 pass), then against the pre-fix sources (4839dbec versions of the 8 changed files) to see which tests fail on the bug, then 15 hand-made mutants under the author's env and 5 under `env -i`.

**Blocker / Major (in the PR):** none.

**Minor**
- T-1: the six jev e2e rows are vacuous where Jev is off (verified: passes on the buggy code under `env -i`). Only the textual pin guards them in CI. jev-select is live on machines with OPENROUTER_API_KEY.
- T-2: the source pin is textual and hand-listed. Removing `--end-of-options` is caught; a comment-only needle (R9) or an inverted condition (R8) survives. No enumeration guard for unlisted sites.
- T-3: gate tests: G1 and G6 survive. Title says "whatever the option is", cases use only --ref and --base.
- T-4: the comment "No routine review command is spelled that way" is false: `--source=-` and `--catalog=-` (stdin) were routine and now prompt, as does `git log --grep=-c`. Fail-closed, untested.
- T-5: the floor row does not exercise the bug; one shared `outside` path across cases; non-zero exit passes on any crash.

**Questions**
- Is the git >= 2.24 floor acceptable for users (CI is ubuntu-latest, so CI cannot tell)?
- Should a bare `-` glued value stay routine for stdin (`--source=-`)?

**Pre-existing**
- P-1 (major by impact, does not block): `flow-check-ac.ts` passes `flow.baseBranch` bare to `git diff` / `git merge-base`; reproduced, file written. The PR's "whole class closed" claim is therefore overstated. Other candidate sites listed in class_scope, unverified.

**Verified clean**
- The five review CLI rows (slice, scope, blast-radius, and the --base/--ref variants) fail on the bug in the author's env; the unit assertGitRevision test and the "-U0 refused by name" test fail on the bug everywhere.
- Legitimate refs (HEAD, HEAD~1, ranges `..` and `...`, HEAD^{}) work under `--end-of-options` on git 2.43.
- Scratch repo is created in os.tmpdir, realpath'd, removed in afterAll; no writes into the worktree.
- Mutants killed: G2, G3, G4, G7, G8, G9, R1, R2, R3, R6, R7.

Routing audit: graph_used no (not-relevant, test review of 2 files), wiki_used no (not-relevant), ctx_used yes (keryx ctx rg, ctx read), raw_rg_used no.
Scratch: /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-testing-practices/
