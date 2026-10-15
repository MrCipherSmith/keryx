STATUS: DONE

```REVIEW_RESULT
{
  "status": "DONE_WITH_CONCERNS",
  "reviewer": "review-performance",
  "summary": "No added subprocess and no per-command cost regression. One Minor: hasExecFlag recursion depth equals the number of '=' in a word, so a single 80-200 KB word of repeated '=--a' makes isTrustRoutineCommand throw RangeError (the old code returned a verdict).",
  "findings": [
    {
      "id": "F-001",
      "reviewer": "review-performance",
      "severity": "minor",
      "file": "src/lib/trust-routine-command.ts",
      "quote": "return w.startsWith(\"-\") && eq !== -1 && hasExecFlag([w.slice(eq + 1)]);",
      "problem": "hasExecFlag recurses once per '=' in a dash-prefixed word and copies the tail with slice at each level (quadratic copying, recursion depth = count of '='). A word such as `--ref=--a=--a=...` with between 20000 and 50000 repeats exhausts the stack and isTrustRoutineCommand throws RangeError instead of returning false. Before the PR hasExecFlag was a flat words.some and could not throw.",
      "impact": "Measured with a bun script calling isTrustRoutineCommand (cwd = worktree). `keryx review slice --ref` + '=--a' x N: N=1000 (4 KB) 8.5 ms false; N=10000 (40 KB) 37 ms false; N=20000 (80 KB) 94 ms false; N=50000 (200 KB) THROW RangeError 'Maximum call stack size exceeded'; N=100000 and N=200000 THROW. `git diff --a` + '=--a' x 100000 (400 KB) also THROWs (verdict true at 40 KB). Words whose tail does not start with '-' never recurse: `git diff -x` + '=' x 100000 true in 39 ms, `keryx flow status --x` + '=a' x 100000 true in 108 ms. The only production caller, src/commands/agent.ts:5650 (isRoutine closure), has no local try/catch (the nearby try at 5615 wraps only the pre-tool hook), so the exception leaves the approval path. Direction is fail-closed (no auto-approval), so this is robustness, not a bypass. The trigger is a deliberately crafted 200 KB single-word shell command. I did not verify what the outer agent loop does with the throw.",
      "evidence": "Script: /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/performance/m.ts (run with bun). For comparison, ordinary commands: `keryx review slice --ref=origin/main --context=3` costs 0.105 ms per isTrustRoutineCommand call (2000-call average), short hostile `--ref=--output=/x` 0.082 ms.",
      "suggested_fix": "Make it iterative and copy-free: for a word starting with '-', loop over successive '=' positions, test the tail against '-c' and EXEC_FLAGS, and stop at the first tail that does not start with '-'. That gives the same verdicts as the recursion (each level only recurses when the tail starts with '-') with constant stack. Alternatively return false from isTrustRoutineCommand for any command over a few KB; no real review command is that long.",
      "confidence": "high",
      "location_class": "in-diff"
    }
  ],
  "stats": { "blocker": 0, "major": 0, "minor": 1, "info": 0 }
}
```

## Summary (review-performance, round 1 of 3)

Findings by severity
- Minor F-001: recursive hasExecFlag throws RangeError on one word with between 20k and 50k '=' (details in the JSON). Fail-closed direction, crafted input only. An iterative loop or a command-length cap fixes it.

Questions
- None.

Pre-existing
- None found in this domain.

Verified clean
- Added subprocesses: none. assertGitRevision is a synchronous startsWith check; `--end-of-options` is one more argv entry on git calls that already ran (gitDiff, gitChangedFiles, mergeBaseWithHead, the six jev diff helpers). No new spawn, no extra git call.
- Per-command cost in the trust gate: 0.105 ms (routine) and 0.082 ms (short hostile) per call. The added hasDashValue regex `/^--[^=]+=-/` is anchored and linear, and runs only for `review` entries after the table match.
- The quadratic part is real but small: 40 KB word 37 ms, 80 KB word 94 ms. Commands are bounded by MAX_CHAIN_SEGMENTS=4 segments, not by length (no length cap exists).
- Legitimate refs under `git diff --end-of-options <x>` and `git merge-base --end-of-options HEAD <x>` (git 2.43.0, scratch repo, script refs.sh in the scratchpad folder): HEAD~1, origin/main..HEAD, HEAD...origin/main, v1, full sha, HEAD^{}, main@{1}, HEAD~1.. give the same exit code as the old spelling for diff and for diff --name-only. merge-base with a range (a..b, a...b, x..) exits 128 both before and after, so it was never valid. `@{u}` exits 128 in my scratch repo in both spellings (no upstream configured there), so that case is not conclusive.
- git version floor: `--end-of-options` needs git >= 2.24 (Nov 2019); local git is 2.43.0. The 12 workflow matches I saw showed no pinned git version; hosted ubuntu images ship a newer git. What a user on git < 2.24 would see I did not test; outside my domain.
- Not examined (other reviewers): the class scope of other ref consumers, over-blocking, test mutation strength.

Scratch: /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/performance/ (m.ts, refs.sh). Nothing written to the worktree except this report.
Routing audit: graph_used no (not-relevant), wiki_used no (not-relevant), ctx_used yes, raw_rg_used no.
