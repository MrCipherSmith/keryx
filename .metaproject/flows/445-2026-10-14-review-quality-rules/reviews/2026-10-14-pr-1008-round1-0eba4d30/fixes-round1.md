# Round 1 fixes — PR 1008 (head 0eba4d30)

| Id | Severity | Disposition | What changed |
|----|----------|-------------|--------------|
| R1-00 | blocker | fixed | `src/flow/review-gate.e2e.test.ts` fixture now carries an `Evidence level:` line. The scope-B screen listed it as outside the computed set; it is the one failing CI test, so it was fixed anyway. |
| R1-01 | major | fixed | `src/commands/review.test.ts`: `review complete` runs in a child process with a stand-in `gh` first on PATH; a merged PR gives code 1 and a `merged` message, so the production default lookup is pinned. Kills r1-cli-lookup-off and r1-cli-warnings-silent. |
| R1-02 | major | fixed | The offline contract is pinned at the gate (null, `{exists:false}`, rejection) and through the CLI (`gh` exit 1 gives code 0, the `could not read the PR state` warning, status closed). Kills r1-gate-offline-throws. |
| R1-03 | minor | deferred | Whether `narrowed` needs a link to a canonical finding is a design question for the operator; no code change. |
| R1-04 | minor | fixed | Bare package-file names, versions and abbreviations (`research.json`, `v1.2.json`, `e.g.md`) are not citations; root documents (`README.md`, `AGENTS.md`) are. |
| R1-05 | minor | fixed | The first-line check now needs a PR word (`pr`, `pull request`, `head`) within 40 characters of a move word, so an unrelated "closed" no longer passes. `stale` and `no longer` were dropped from the move words. |
| R1-06 | minor | fixed | A recorded head that is not a 7–40 digit hex SHA skips the moved-head check with a warning instead of matching every PR head. |
| R1-07 | minor | fixed | Fenced `Evidence level:` lines are ignored, and placeholder items (`none`, `nothing`, `n/a`, `-`) are not items. |
| R1-08 | minor | fixed | Dismissed and external findings are exempt from the unlocatable refusal, now with tests. Kills r1-loc-external-asked and r1-loc-dismissed-asked. |
| R1-09 | minor | fixed | `lexicalRelativePath` (`..`, absolute) and URL-only rebuttals are tested. Kills r1-lex-dotdot-ok and r1-lex-absolute-ok; r1-cite-url-kept was not killed by this test (round 2, R2-02, fixed there). |
| R1-10 | minor | deferred | The review-orchestrator SKILL.md sits at its length ceiling; the unwrapping of three paragraphs and a ceiling change are an operator decision. |
| R1-11 | minor | fixed | The unlocatable-quote refusal names its causes (quote absent, ambiguous, file or commit not in this checkout) and the `git cat-file -e` check. |
| R1-12 | minor | deferred | Reading the head through a lighter adapter call (`prHead`) instead of `gh pr checks` is a follow-up. |

Verification: 321 tests in 11 focused files pass; typecheck and eslint clean. The full `bun run check` is left to CI.
