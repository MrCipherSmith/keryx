# Acceptance Criteria - Review Tails

Status: DRAFT. Not frozen. Awaiting the operator's review; no AC is final until the operator freezes the flow.

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.
- "Red before, green after" means the named test is added in the same change and fails on `origin/main` at `0ca99fb1`.
- The operator answered Decisions 1 to 5 of the PRD in poll 143 (2026-10-13), all with the recommended option; the criteria below are written for those answers. Poll 146 (2026-10-13) settled AC8: `e2e/` and the non-TypeScript script extensions from today's `src/testing/selection.ts` stay on top of the definition poll 143 named.

## Criteria

### Git output and the pre-push hook (R1)

- AC1: A test runs the generated pre-push hook in a scratch repository with a pushed file named `файл.env` (non-ASCII) containing a secret fixture; `keryx security scan` is invoked for that path and the hook blocks in enforced mode - red before (the file is skipped silently), green after.
- AC2: A pushed commit that is later changed in the working tree is scanned in its pushed state, not its working-tree state; a file deleted by the push is skipped, a file deleted only in the working tree is still scanned - one test per case.
- AC3: With no ref lines on stdin the fallback range names the commits being pushed; an uncommitted change in the working tree is not scanned - red before, green after.
- AC4: `gitChangedFiles` returns a non-ASCII path as the path, not as a quoted string, and `gitTestFiles` classifies a non-ASCII test file name as a test - tests over a scratch repository.
- AC5: `gitChangedFiles` without a ref lists a staged change and an unstaged change; with a ref it is unchanged - red before for the staged case, green after.
- AC6: The release note says the hook template changed and that `keryx update` is needed in each project to receive it.

### One test-file predicate (R2)

- AC7: `src/testing/selection.ts` exports the one predicate; `src/testing/service.ts`, `src/review/coverage.ts`, `src/review/jev-risk.ts` and `src/review/jev-contract.ts` use it and none keeps its own pattern - a repository test fails when a second test-file pattern appears in those files.
- AC8: The one definition is: a file named `*.test.*` or `*.spec.*` with a TypeScript or JavaScript extension (`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`), or any such script file under a directory named `test`, `tests`, `__tests__` or `e2e` (poll 143, 2026-10-13: "*.test.ts(x), *.spec.ts(x), test/tests/__tests__"; `e2e` and the extra extensions are kept from the current `src/testing/selection.ts`, confirmed in poll 146). A table-driven test pins one answer per path and runs through each of the five call sites: true for `tests/api.ts`, `e2e/login.ts`, `src/test/a.ts`, `test/a.ts`, `src/__tests__/a.ts`, `foo.test.ts`, `foo.spec.tsx`, `foo.spec.mjs`; false for `foo.test.md`, `latest/a.ts`, `contest/a.ts`, `src/attests.ts` - red before for the paths on which the old patterns disagree.
- AC9: `requiredReviewers` adds `review-testing-practices` for `tests/api.ts` - red before, green after.

### Rule category (R3)

- AC10: `classifyRuleSourceCategory` returns "code" for `rules/digital-signature-validation.mdc`, `rules/legitimate-redirects.mdc` and `rules/explanation-of-errors.mdc`, and "process" for `rules/commit-workflow.mdc` and `rules/git-rules.mdc` - red before for the first three, green after.
- AC11: A frontmatter `applies_to` or `metadata.category` still wins over the heuristic; the existing tests for it stay green.
- AC12: A replay of `classifyRuleSourceCategory` over every rule file in `.metaproject/rules` and the bundled rule corpus gives the same category as before the change, or a listed, explained difference; the report is checked in with the change.

### Startup replay and transcript (R4, R5)

- AC13: The wrap-up of a preserved session does not write `archive.jsonl` into the project tree by default (poll 143, Decision 1: outside the tree, by default); the evidence record names the transcript by path and hash, the reference outside the project passes the same containment check project files get, and a test asserts no `*.archive.jsonl` exists under `.metaproject/workspaces/` after a wrap-up - red before, green after. Evidence already written stays where it is.
- AC14: A test makes `replayProjectPreservationOutboxes` throw in the readline shell; the shell reaches its normal end, the lease is released and no unhandled rejection is raised.
- AC15: The same test exists for the TUI shell.
- AC16: Each test of AC14 and AC15 is red against a build with the `try/catch` removed (one mutation per site, recorded in the PR).

### Close phrase, ask_user, help (R6, R7, R8)

- AC17: `isClosePhrase` is false for "don't wrap up yet", "do not close the slate", "never wrap-up without asking" and "not yet, wrap up later", and true for "no, we're done", "wrap up now" and "close the slate please" - red before for the negated lines, green after.
- AC18: The existing tests of the object followers and subordinating followers stay green; the English-only limit is stated in the function comment.
- AC19: In an automatic review, `answerAskUser` returns `undefined` (the question goes to the operator) for a question whose option label contains "release", "publish", "delete" or "push to main", with `irreversible` unset and no `action` - red before, green after, one test per word.
- AC20: In an automatic review, a question asked after untrusted content was seen in the turn is never defaulted by `answerAskUser`.
- AC21: A model-supplied `irreversible: false` or an absent `policy` does not turn an irreversible-looking question into a defaulted one; a question with no irreversible vocabulary, no untrusted content and no flags is still answered by the recommended option, and the count of questions put to the operator because of the vocabulary is written to the run's disclosure.
- AC22: The `/mode` entry in `src/standard/help-groups.ts` states no hard-coded round limit, or is built from `describeRoundLimitSplit()`; a test compares it with the `/mode` entry in `src/commands/agent-commands.ts` with `KERYX_AGENT_MAX_ROUNDS` unset and set to `60`.

### Flow ids (R9)

- AC23: `.metaproject/flows/` holds no two directories with the same numeric id, or every shared id has an entry in `.metaproject/flows/id-map.json`; `keryx flow list` on a fresh checkout shows 352 once.
- AC24: The repair of 352 uses the renumber path from PR 205; the renumbered flow keeps its history and its `id-map.json` entry names both old and new directory.
- AC25: A repository test fails when two flow directories share an id and no `id-map.json` entry accounts for it - red on `origin/main` at `0ca99fb1`, green after AC23.

### Generated build output (C5)

- AC29: `classifyPath` marks build output as generated (poll 143, Decision 3: "generated, not reviewed") for `packages/app/dist/a.js`, `apps/web/build/x.js`, `lib/target/x.rs` and `build/out.js`, and does not mark `packages/app/src/index.ts`, `src/build.ts` or `src/target.ts`; the paths classified today (`docs/out/index.html`, `packages/core/generated/types.ts`) keep their class - table-driven test, red before for the first four paths.
- AC30: A generated-classified path is not sent to a reviewer and is not counted as uncovered in `review complete`; a test over a changed-file list that holds one source file and one `build/` file shows the reviewer set and the coverage ledger ignore the second.

### Process

- AC26: Every task closes with a review round in mode `all` whose package records no unaddressed major; the mutation pass for the changed functions (`isClosePhrase`, `answerAskUser`, `classifyRuleSourceCategory`, the git readers, the hook scan loop) is run, and its outcome table is attached to the round.
- AC27: The release note names each of the eleven tails by its ID from the PRD (C1 to C5, P984-1, P984-2, P986-1 to P986-3, F-ID) and the pull request each came from where it has one (984, 986).
- AC28: The "Unverified" items of the PRD are either closed with a pointer and a new criterion, by `keryx flow ac update` on the operator's decision, or stay out of the release note as fixed.
