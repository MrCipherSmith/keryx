STATUS: DONE

```REVIEW_RESULT
{
  "status": "DONE_WITH_CONCERNS",
  "reviewer": "review-regression",
  "summary": "No legitimate-ref or legitimate-command regression from the PR (assertGitRevision, --end-of-options argv, hasExecFlag/hasDashValue). Two pre-existing majors in the blast radius show the PR's 'whole class closed' claim is false: unguarded flow-check-ac.ts git sinks reachable from the auto-approved review ingest row, and a backslash spelling that bypasses the gate. Radius caveat: 98 files dropped by the 40-file cap (incl. tui-shell.ts, trigger-dispatch.ts, review-system.ts, cli.ts); 4 changed non-code files unresolved. The code graph has no runtime edges, so hooks and string-keyed lookups were swept by keryx ctx rg instead.",
  "findings": [
    {
      "id": "RG-1",
      "severity": "major",
      "file": "src/commands/review.ts",
      "quote": "const diffText = await resolveIngestDiff(defaultGitSpawn, target.ref, target.head, { cwd });",
      "location_class": "pre-existing",
      "problem": "The PR closes user-ref-to-git only for review.ts (gitDiff, gitChangedFiles, mergeBaseWithHead) and the six review-jev-* readers. The sibling consumer src/commands/flow-check-ac.ts resolveDiffAgainstBase and resolveIngestDiff still spawn git merge-base HEAD <ref> and git diff --no-color -U20 <ref> with no assertGitRevision and no --end-of-options. review.ts:976 (the ingest ac-check block, in the changed file) feeds target.ref from --ref/--target-ref into it. merge-base fails on a dashed value, the code falls back to the raw ref, so git diff -U20 --output=<file> runs.",
      "impact": "Trigger: keryx review ingest --target branch --ref=--output=/abs/file --head <sha> (with an AC-check flow). Outcome: git writes or truncates /abs/file. Reproduced: resolveDiffAgainstBase(defaultGitSpawn, '--output=<f>') and resolveIngestDiff(defaultGitSpawn, '--output=<f>', head) both created the file. The PR's gate change does not cover the review ingest row for the backslash spelling (RG-2), so the same primitive stays reachable without a prompt.",
      "suggested_fix": "In flow-check-ac.ts call assertGitRevision(refName) and put --end-of-options before the ref in both git merge-base calls and both git diff calls; validate flow.baseBranch the same way. Add a hostile-ref test per function.",
      "evidence": "regr/sink.ts: 'resolveDiffAgainstBase file written: true', 'resolveIngestDiff file written: true'. Source: flow-check-ac.ts:167 ['git','merge-base','HEAD',refName], :170 ['git','diff','--no-color','-U20',ref], :191, :194. Plain --ref=--output= and space forms are refused by the new gate; the backslash form is not (RG-2).",
      "confidence": "high",
      "reviewer": "review-regression",
      "class_scope": {
        "sites": [
          "src/commands/flow-check-ac.ts:167",
          "src/commands/flow-check-ac.ts:170",
          "src/commands/flow-check-ac.ts:191",
          "src/commands/flow-check-ac.ts:194",
          "src/commands/review.ts:976",
          "src/tui/inspector-sources.ts:283",
          "src/commands/flow.ts:1362",
          "src/commands/flow.ts:409"
        ],
        "enumeration_method": "keryx ctx rg over spawn/exec sites for git|gh (merge-base, diff, rev-parse, log, show, cat-file) and every caller of resolveDiffAgainstBase/resolveIngestDiff; classified each ref source: CLI flag, flow.baseBranch from flow.json, TUI state. Sites in review/bot/run.ts, review-gate.ts, flow/service.ts, harness/external/write-run.ts, git-worktree-port.ts, review/managed.ts, tui-shell.ts were hex/sha-validated, internal, or read-only and are excluded."
      }
    },
    {
      "id": "RG-2",
      "severity": "major",
      "file": "src/lib/trust-routine-command.ts",
      "quote": "if (w === \"-c\" || EXEC_FLAGS.some((f) => w === f || w.startsWith(`${f}=`))) return true;",
      "location_class": "pre-existing",
      "problem": "hasExecFlag (and the new recursive glued-value judgement and hasDashValue) compare raw words from splitSegments, which keeps backslashes that bash strips. --\\output=, --\\pre=, --\\exec, --ref=\\--output= are judged routine by the new code exactly as before, so the F-045 fix is bypassed by one backslash.",
      "impact": "Trigger: an auto-approved agent command 'git diff --\\output=/abs/file' or 'keryx review ingest --target branch --ref=\\--output=/abs/file --head <sha> --flow 1'. Outcome: isTrustRoutineCommand returns true (no prompt) and bash passes --output=/abs/file; confirmed bash -c 'git diff --\\output=...' wrote the file. Same for keryx ctx rg --\\pre=sh (preprocessor exec) and the keryx review rows.",
      "suggested_fix": "In isTrustRoutineCommand refuse any word containing a backslash (or decode escapes before judging), and add tests for the backslash spellings next to the F-045 ones.",
      "evidence": "regr/cmp2.ts: old and new gate both return true for 'git diff --\\output=/tmp/x', 'keryx ctx rg --\\pre=sh foo', 'keryx review slice --ref=\\--output=/tmp/x'. regr/sink.ts: true for review ingest --ref=\\--output= and --target-ref=\\--output=; false for the unescaped forms and for flow check-ac --diff=.",
      "confidence": "high",
      "reviewer": "review-regression",
      "class_scope": {
        "sites": [
          "src/lib/trust-routine-command.ts:109",
          "src/lib/trust-routine-command.ts:111",
          "src/commands/agent.ts:5650"
        ],
        "enumeration_method": "keryx ctx rg for isTrustRoutineCommand: one production consumer (agent.ts:5650); every routine row (git read subcommands, keryx ctx rg, keryx review, keryx flow) goes through hasExecFlag on unescaped words; reproduced with old-trust.ts (base copy) versus the new file on 14 spellings."
      }
    }
  ],
  "stats": { "blocker": 0, "major": 2, "minor": 0, "info": 0 }
}
```

## Findings by severity

Blocker: none. Major (both pre-existing, so they do not block this PR; the second is a bypass of the PR's own fix):
- RG-1 (review.ts:976 -> flow-check-ac.ts:167/170/191/194): `resolveDiffAgainstBase` and `resolveIngestDiff` pass `--ref`, `--target-ref` and `flow.baseBranch` to `git merge-base` and `git diff` without `assertGitRevision` or `--end-of-options`. A dashed ref falls back to the raw ref and `git diff --output=<file>` writes a file (reproduced). The PR's "whole class closed" claim is false.
- RG-2 (trust-routine-command.ts `hasExecFlag`): backslash spellings (`--\output=`, `--\pre=`, `--ref=\--output=`) are judged routine because `splitSegments` keeps the backslash and bash drops it. Confirmed a file written through bash.

## Questions

- Is the `review ingest` ac-check path meant to be reachable on the auto-approved row at all? If not, the gate should drop it as well.
- Do the six jev tests ever run in CI with Jev on? The test file returns early when Jev is off, so only the source-pin test (counting `--end-of-options` strings) guards those six files. That is a scope-A matter; flagging it here only because it limits the regression evidence.

## Pre-existing

RG-1 and RG-2 above. Also: `flow-check-ac.ts` refs from `flow.json` (`baseBranch`) are repo-supplied content and reach the same sink (:409, :1362).

## Verified clean

- Legit refs under `--end-of-options`: HEAD~1, origin/main..HEAD, a...b, tags, shas, @{u}, HEAD^{} (19 shapes) give identical `git diff` and `git merge-base` output versus the old argv on git 2.43.0. `--end-of-options` also works on git 2.25.1 (Ubuntu 20.04) and 2.34.1 (22.04); the 2.24 minimum is met by every distro CI or users run (debian:11 check skipped, git not installable in the container).
- Over-blocking: old versus new gate on 58 command lines. New prompts appear only for exotic values (negative numbers like `--depth=-1`, quoted text starting with `-`, `-c` inside a glued value on non-review rows such as `ctx rg --glob=-c`). Cost is an extra prompt, never a refusal of a documented command.
- No doc, skill, rule, hook or script in the repo (searched `.metaproject/skills`, `docs/`, rules, hooks, tests) uses a now-refused spelling; only the PR's own tests do.
- Callers of `gitDiff`, `gitChangedFiles`, `mergeBaseWithHead` in review.ts and the six jev readers keep their signatures and results; `--diff` in jev-select is a file or stdin, only `--ref` reaches git.
- Dependents that validate refs themselves (hex `--head` in `resolveCreateHead`, sha-sourced `commitContainedIn`/`verifyCommitOnMain`, bot/run.ts, write-run.ts, git-worktree-port.ts) are unaffected.
- Radius limits: 98 files dropped by the cap, 4 non-code changed files unresolved; the graph has no runtime edges, so those parts rest on text search, not the graph.

Routing audit: graph_used yes (blast radius), wiki_used not-relevant, ctx_used yes, raw_rg_used no.
