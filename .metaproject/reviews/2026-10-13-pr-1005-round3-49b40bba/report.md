# PR 1005 — review round 3

Verdict: request-changes (final round; fixes verified by mutation, no round 4)

Head reviewed: 49b40bba5bff269073d31891947b6b0b3b7b8cec
Base: 4839dbecaa799c9b75bc19eaa9085d6a889df972
Review id: 2026-10-13-pr-1005-round3-49b40bba
Orchestrator: single-agent deep pass with mutation (vantage-review dispatch not used in this round). Round 3 of 3.

## Summary

The round-2 fixes hold: F-066 to F-071, F-074 and F-077 are fixed in the code and no regression was found. Two majors remain. R3-01 is real: the fail-closed expansion gate refuses backslash, dollar and braces but not unquoted globs or a leading tilde, so a planted file named `--output=injected` becomes a git option through `git log --o*`. R3-02 is major only because it cites two surviving mutants (a test gap on the commit regex). One minor and one info complete the list.

Counts: 0 blockers, 2 majors (1 real, 1 mechanical), 1 minor, 1 info.

## Round-2 disposition

F-066 to F-071, F-074, F-077 fixed. F-072 and F-073 stay skipped (pre-existing; no doctor git-version check to extend). F-075, F-076 and the optional ref helper stay skipped.

## Mutation pass

55 mutants: 51 killed, 4 survived. N22 (end anchor dropped) and N23 (start anchor dropped) survive and are filed as R3-02. S12 is equivalent (the `revisionOperand` call below refuses the same input). N25 (staleness catch rethrows) is an unpinned fail-soft path, low value, not filed. The spec carries 41 round-2 mutants whose anchors still match, drops 15 whose anchors no longer exist, and adds 14. 165 tests in the five test files run pass on the head. Files: `research-evidence/mutants.json`, `mutation-1`, `mutation-2`, `mutation-3`.

## Pre-existing

- F-072 (gate length cap) and F-073 (doctor has no git-version check), carried from round 2.

## Verified clean

- Quoted globs and quoted `$`, braces and backslash stay routine; the quoted spellings of the round-2 bypasses are refused.
- `revisionOperand` guards every ref in the changed git calls; `readProvenance` validates hex before use; `staleness.ts` no longer reads an unguarded `provenance.commit`.

## Not run

- vantage-review multi-reviewer dispatch and review-verifier (single-agent pass), macOS and git older than 2.24.

## Routing audit

graph_used: yes (blast-radius); wiki_used: no (not-relevant); ctx_used: yes; raw_rg_used: no.

## keryx:findings

```json keryx:findings
[
  {"id":"R3-01","reviewer":"vantage-review (single-agent deep pass)","severity":"major","problem":"hasUnquotedExpansion refuses an unquoted backslash, dollar and braces but not unquoted glob characters (`*`, `?`, `[`) or a word-initial `~`. The shell expands a glob against the working directory before git runs, so a file named `--output=injected` turns into a git option while the gate judged the command routine.","impact":"A command typed by a model or an operator that carries a glob (`git log --o*`) is auto-approved as a read, and git writes the file `injected`; the precondition is a matching file in the working directory, which a cloned repository can supply. `git log *` is judged routine but git exits 128 and writes nothing; `keryx ctx diff *` is judged routine but assertNoWritingDiffOption refuses it at runtime, so the keryx rows are protected only by the second layer.","suggested_fix":"Refuse `*`, `?`, `[` and a word-initial `~` in hasUnquotedExpansion, the way isExpandable already does, and keep quoted globs routine. Add tests for the git read row and the keryx rows, both unquoted (refused) and quoted (routine).","evidence":"Reproduced: with a file named `--output=injected` in the cwd, `git log --o*` was judged routine by trust-routine-command and, run through a shell, wrote the file `injected`. A 23-spelling probe of word-building shell features found the glob and tilde spellings as the only gaps left after the round-2 fixes.","confidence":"high","file":"src/lib/shell-syntax.ts","quote":"else if (ch === \"\\\\\" || ch === \"$\" || ch === \"{\" || ch === \"}\") return true;","pre_existing":false,"location_class":"changed","class_scope":{"sites":["src/lib/shell-syntax.ts:125 (hasUnquotedExpansion character set)","src/lib/trust-routine-command.ts:354 (the git/keryx words-judged gate that calls it)","the git read row and the keryx review/ctx diff rows that rely on that gate","isExpandable in the same module (the model: it already refuses glob characters)"],"enumeration_method":"Code read of every word-building shell feature (parameter expansion, command substitution, backslash, brace expansion, glob, tilde, ANSI-C quoting, IFS splitting) against the character set, plus a 23-spelling probe run through the gate and a shell; only glob characters and a leading tilde passed the gate."}},
  {"id":"R3-02","reviewer":"vantage-review (mutation pass)","severity":"major","problem":"Nothing pins the anchors of the commit regex in readProvenance. With the end anchor dropped (mutant N22) or the start anchor dropped (mutant N23) every test still passes.","impact":"A provenance commit with a leading dash, a trailing non-hex character or an embedded space would be accepted if an anchor regressed. The revisionOperand guard downstream still stops git from reading the value as an option, so there is no exploit today. It is a test gap on a covered operation, major only because it cites surviving mutants.","suggested_fix":"Add provenance tests for a leading dash, a trailing non-hex character and an embedded space, each expecting null.","evidence":"mutant:N22-end-anchor-dropped and mutant:N23-start-anchor-dropped survived (mutation-3.json, research-evidence/mutants.json).","confidence":"high","file":"src/sync/provenance.ts","quote":"if (typeof commit === \"string\" && /^[0-9a-f]{4,64}$/i.test(commit)) {","pre_existing":false,"location_class":"changed","class_scope":{"sites":["src/sync/provenance.ts:243 (the only commit regex in readProvenance)"],"enumeration_method":"Searched src/sync and src/gdgraph with keryx ctx rg for every read of provenance.commit and every hex validation; the regex at provenance.ts:243 is the single validation site."}},
  {"id":"R3-03","reviewer":"vantage-review (single-agent deep pass)","severity":"minor","problem":"The fail-closed expansion gate now asks for approval for harmless commands such as `git show HEAD@{1}` and `keryx ctx rg foo \\.ts`, because braces and backslashes are refused whatever they build. The quoted spellings stay routine.","impact":"Extra approval prompts for two common spellings; no safety impact. A trade-off of failing closed, noted so the release notes can say to quote such arguments.","suggested_fix":"Accept as is and mention it in the release notes, or allow a brace or backslash only where it cannot build a word starting with a dash.","evidence":"Probe of `git show HEAD@{1}` and `keryx ctx rg foo \\.ts` through the gate: both refused; the quoted forms routine.","confidence":"medium","file":"src/lib/trust-routine-command.ts","quote":"!(isJudgedByWords(seg.words) && hasUnquotedExpansion(seg.raw)) &&","pre_existing":false,"location_class":"changed"},
  {"id":"R3-04","reviewer":"vantage-review (single-agent deep pass)","severity":"info","problem":"The revisionOperand doc comment says every git call that takes a ref a person, a model or a repository file supplied puts it there. That is broader than the code: commitsAheadOfMain builds `${mainBranch}..HEAD` from a parameter whose default is \"main\" and does not go through it.","impact":"None today: the value is the literal default or comes from the caller, and a range string cannot start with a dash unless mainBranch does. A future reader may trust the claim.","suggested_fix":"Narrow the comment to the call sites that use the helper, or route the range through assertGitRevision.","evidence":"git-worktrees.ts:224 spawns git rev-list with `${mainBranch}..HEAD` and no --end-of-options.","confidence":"medium","file":"src/lib/git-revision.ts","quote":"Every git call that takes a ref a person, a model or a repository file supplied puts this where the revision","pre_existing":false,"location_class":"changed"}
]
```
