# Keryx Review Tails PRD
Version: 0.1.0 (draft, awaiting the operator's review before the flow is registered and frozen)

## Origin

- **origin:** the operator's task from the helyx channel (message 200493, 2026-10-12): finish the debts planned before the release; and poll 141 (2026-10-13), answer 2: "Один flow на все хвосты, PRD и AC вам до заморозки".
- **trigger:** several review rounds and merged pull requests left small follow-ups outside their own change: classifier holes found while reviewing, tails of PR 984 and PR 986, and a duplicated flow id in `keryx flow list`.
- **owner:** MrCipherSmith.
- **verification:** every "current behaviour" below was re-read on `origin/main` at `0ca99fb1` on 2026-10-13, in a worktree that is up to date with it. Items that could not be established are listed under "Unverified" and are not part of the acceptance criteria.

## Problem

| ID | Where | Defect | Open on main |
|---|---|---|---|
| C1 | `src/lib/templates.ts:2256`, `:2274` (pre-push hook) | Paths git quotes (non-ASCII names) fail `[ -f ]` and are skipped by the security scan; the fallback diff compares against the working tree | yes |
| C2 | `src/commands/review.ts:3538`, `:3544` | `gitChangedFiles` and `gitTestFiles` read quoted git output; `gitChangedFiles` without a ref lists unstaged changes only | yes |
| C3 | `src/review/coverage.ts:29`, `src/review/jev-risk.ts:170-171`, `src/review/jev-contract.ts:235`, `src/testing/selection.ts:12`, `src/testing/service.ts:49` | Five definitions of "is a test file" that disagree | yes |
| C4 | `src/review/jev-rules.ts:185-199`, `:224-244` | Process/code rule category is chosen by substring match on the file path and title | yes |
| C5 | `src/review/scope.ts` (`classifyPath`) | Build output under a workspace package or under `build/`, `target/` is not classified as generated | question, see Decision 3 |
| P984-1 | `src/commands/shell.ts:2611-2613`, `src/tui/tui-shell.ts:6806-6808` | The startup replay in `try/catch` has no test that proves a throwing replay does not end the shell or hold the lease | yes |
| P984-2 | `src/sac/preserved-wrap-up.ts:30-31`, `:41` | The whole session transcript (`archive.jsonl`) is written into the project tree by default | yes |
| P986-1 | `src/session/slate-lifecycle.ts:420-436` | The close-phrase matcher has no negation handling | yes |
| P986-2 | `src/commands/automatic-review.ts:299-342` | `answerAskUser` decides what is irreversible from flags the model supplies | yes |
| P986-3 | `src/standard/help-groups.ts:222` | The `/help` summary of `/mode` carries hard-coded round limits | yes |
| F-ID | `.metaproject/flows/352-*` | Two flow directories share id 352 | yes |

## Goal

Each tail is closed by a test that is red before and green after, and the one definition of a test file, a changed file list, and a flow id cannot silently drift apart again.

## Non-goals

- The depth, parity and metaproject-in-review work (`docs/requirements/keryx-review-depth-parity/`, `docs/requirements/keryx-review-metaproject/`, flows 428 and 431).
- The five majors of PR 940 and PR 975 (`docs/requirements/keryx-deferred-majors-940-975/`).
- Redesign of the pre-push hook, of the scope classifier, or of automatic review.
- Anything under "Unverified".

## Users

- The operator, whose pushes pass through the pre-push security scan and whose reviews depend on the changed-file list.
- The review orchestrator, which chooses reviewers from file classification (`requiredReviewers`).
- The operator in an automatic review, who relies on `ask_user` reaching them for irreversible questions.
- Anyone reading `keryx flow list` or confirming an AC by bare flow id.

## Requirements

### R1 - A path is scanned or listed whatever its name (C1, C2)

**Current behaviour.** The pre-push hook builds its file list from `git diff --name-only --diff-filter=ACMR` (`src/lib/templates.ts:2220`, `:2234`, `:2256`) and reads it line by line. Git quotes a path with non-ASCII bytes in that output: `"\321\204\320\260\320\271\320\273.env"`, quotes and escapes included (reproduced in a scratch repository on 2026-10-13; `a b.env` comes out unquoted). The loop then tests `[ -f "$file" ]` (`:2274`); the quoted string is no file, so the file is skipped without a message and never reaches `keryx security scan`. Two further effects in the same lines: the `[ -f ]` test reads the working tree, not the pushed commit, so a file changed or deleted after the commit is scanned in its later state or not at all; and when stdin carries no ref lines the fallback range is `HEAD` (`:2246`), and `git diff --name-only HEAD` lists uncommitted changes, not the commits being pushed.

`src/commands/review.ts:3538` has the same shape. `gitChangedFiles` runs `git diff --name-only --diff-filter=d [ref]` and returns the lines as paths; a quoted path is not a path. With no `ref` the command lists unstaged changes only (staged changes are not listed). `gitTestFiles` (`:3544`) runs `git ls-files`, which quotes the same way, so a test file with a non-ASCII name is not matched by `TEST_FILE_RE`.

**Desired behaviour.** Both read git output with `-z` (NUL separated) or set `core.quotePath=false` and still split on NUL, so a name reaches the next step as the file it names. The hook scans the pushed content (`git show <sha>:<path>` or a temporary checkout of the blob), not the working tree, and skips a path only when it was deleted by the push. The `HEAD` fallback names the commits being pushed, not the working tree. `gitChangedFiles` without a ref lists staged and unstaged changes (`HEAD` as the base).

**Risks.** The hook is shell, run under `sh`; `read -d ''` is not POSIX, so the NUL split needs `xargs -0` or a `while IFS= read -r -d ''` guarded for bash. The hook template is installed into projects: a change here needs `keryx update` to reach them, and the release note must say so.

### R2 - One definition of a test file (C3)

**Current behaviour.** Five patterns, each with a different answer:

| Where | Pattern, in words |
|---|---|
| `src/testing/selection.ts:12` (exported `TEST_FILE_RE`, used by `review.ts:130`) | `__tests__/`, `.test.`/`.spec.` + js/ts extension, `e2e/` and `tests/` + js/ts extension |
| `src/testing/service.ts:49` | a verbatim copy of the one above |
| `src/review/coverage.ts:29` | `.test.`/`.spec.` with any extension; `src/test/`, `test/`, `e2e/` as a directory prefix; not `tests/`, not `__tests__/` |
| `src/review/jev-risk.ts:170-171` | `.test.`/`.spec.` with any extension; `__tests__/`, `test/`, `tests/`; not `e2e/` |
| `src/review/jev-contract.ts:235` | `.test.`/`.spec.` followed by letters at the end of the name; no directory rule |

Consequences read from the patterns: `tests/api.ts` is a test file for `selection.ts` and `jev-risk.ts` and is not one for `coverage.ts`, so `requiredReviewers` does not add `review-testing-practices` for it; `e2e/login.ts` is the other way round for `jev-risk.ts`.

**Desired behaviour.** One exported predicate, owned by `src/testing/selection.ts`, used by the other four. The decision which paths count (see Decision 2) is written once, with a table-driven test over the paths above.

**Risks.** The reviewer set changes for the paths on which the patterns disagree; that is the point, but it must be visible in the release note. `.test.` with a non-js extension (`foo.test.md`) is a test for `coverage.ts` today.

### R3 - A rule is "process" because of its frontmatter or a whole word, not a substring (C4)

**Current behaviour.** `classifyRuleSourceCategory` (`src/review/jev-rules.ts:224`) lowercases `filePath + title` and takes the first `PROCESS_RULE_HEURISTIC_TERMS` entry it contains (`:185-199`), a substring test. Probed on 2026-10-13: `rules/digital-signature-validation.mdc` is classified "process" (matched `git`), `rules/legitimate-redirects.mdc` too (`git`), `rules/explanation-of-errors.mdc` as "process" (`plan`). A process rule is not applied to code hunks, so a code rule with such a name silently stops being checked.

**Desired behaviour.** A term matches a whole word of the file name or title (split on non-letters), or the frontmatter says so. The frontmatter branch (`applies_to`, `metadata.category`) is unchanged and still wins.

**Risks.** Terms that are meant as stems (`orchestrat`) need an explicit stem form. The corpus of this repository's own rules must classify the same before and after; a replay over `.metaproject/rules` and the bundled rule corpus is the check.

### R4 - The startup replay cannot end the shell, and a test says so (P984-1)

**Current behaviour.** Both shells call `replayProjectPreservationOutboxes` inside `try { ... } catch { /* an unreadable sessions root must not keep the lease held or end the shell */ }` (`src/commands/shell.ts:2611-2613`, `src/tui/tui-shell.ts:6806-6808`). The function itself is tested (`src/sac/preservation-replay.test.ts`). The call sites are tested only by a source-text audit (`src/commands/shell.test.ts:1225-1227`, which checks that a string is present in the cleanup block), not by a run in which the replay throws.

**Desired behaviour.** A test per shell makes the replay throw (an unreadable sessions root) and asserts: the shell reaches its normal end, the lease is released, and no uncaught rejection is raised. The review finding is recorded as F-005 in the operator's brief; the report that named it was not found in the repository (see Unverified), so the test is anchored to the behaviour the comment promises.

**Risks.** The replay call is inside a large function; the test needs the existing seams of `shell.ts` and `tui-shell.ts`, and a new seam only if none fits.

### R5 - The transcript is not copied into the project tree unless asked (P984-2)

**Current behaviour.** Wrapping up a preserved session writes two files into the project: `wrap-up.md` and `archive.jsonl`, the full transcript of the session, at `.metaproject/workspaces/<id>/preserved-evidence/<snapshot>/<revision>.archive.jsonl` (`src/sac/preserved-wrap-up.ts:18-41`). This happens for every preserved session, by default. The mitigations in place: a `.gitignore` containing `*` in the evidence directory (`:22`), file mode `0o600`, and the redaction floor `applyEvidenceRedactionFloor` (`:33`). The transcript still lands in a directory that backup tools, project search and `keryx ctx` can read.

**Desired behaviour.** A decision for the operator (Decision 1). Recommended: the transcript stays in the session directory and is referenced by path and hash from the evidence record; copying it into the project tree is an explicit option.

**Risks.** The wrap-up reviewer reads the evidence by `uri` under the project; a reference outside the project needs the same containment check the project files get. Existing evidence already written stays where it is.

### R6 - The close-phrase matcher understands "do not" (P986-1)

**Current behaviour.** `isClosePhrase` (`src/session/slate-lifecycle.ts:420`) finds a phrase from `CLOSE_PHRASES` (`:357`) by substring and then looks only at the words after it (object followers, subordinating followers). Nothing looks before the phrase, so "don't wrap up yet" and "do not close the slate" close the slate. Closing archives live Course and Seeds (the module comment at `:350` names this cost).

**Desired behaviour.** A negation among the words before the phrase (within the same clause) makes it no close intent: `don't`, `do not`, `never`, `not yet`, `no need to`. The existing "after" rules are unchanged.

**Risks.** A negation list in English only; the matcher is English-only today. A phrase after "no, we're done" is a close intent and must stay one: the check is the clause before the phrase, not any "no" in the line.

### R7 - Automatic review does not decide irreversibility from the model's own flags (P986-2)

**Current behaviour.** `AutomaticReviewRun.answerAskUser` (`src/commands/automatic-review.ts:299`) puts a question to the operator only when the model-supplied input says so: `emergency` in the closed list and a gate refusal seen (`:301`), `irreversible === true` or a non-empty `action` (`:307`), or a `policy` object (`:312`). Otherwise it answers with the recommended option or the first option (`:325`). A question whose options release, publish, delete or push, asked without `irreversible: true`, is answered by the default. The untrusted-content flag exists on the request (`src/harness/tool/builtin/ask-user-tool.ts:42`, set from the agent loop) and is read by the arbiter floor (`src/review/arbiter-floor.ts:31`), but `answerAskUser` does not read it: `src/commands/agent.ts:5562` calls it with the raw tool input only.

**Desired behaviour.** The host decides, from what it controls: the question goes to the operator when untrusted content was seen this turn, or when the question or any option label matches the irreversible-action vocabulary the tool description already names (release, publish, deploy, delete, push, merge to a shared branch, drop, force, reset, tag a version), whatever flags the model sent. The model's flags can only add a reason to ask, never remove one.

**Risks.** A vocabulary match asks the operator more often in an automatic review, the opposite of its purpose. The match is on the option labels and the question only, and the count of such questions per run is reported so the cost is visible. The arbiter path (`policy`) is unchanged.

### R8 - The `/help` summary of `/mode` is built from the limits (P986-3)

**Current behaviour.** `src/standard/help-groups.ts:222` hard-codes `"Round limit: 40 rounds per turn, 200 in trust, 200 in auto and in automatic review; KERYX_AGENT_MAX_ROUNDS overrides."`. The slash-command description in `src/commands/agent-commands.ts:515` already builds the same sentence with `describeRoundLimitSplit()` (`src/commands/round-limit.ts:76`), and the readline `/mode` output uses `describeRoundLimit` (`src/commands/shell.ts:3025`). Today the numbers agree. They stop agreeing when a constant in `round-limit.ts` changes (as it did within PR 986) or when `KERYX_AGENT_MAX_ROUNDS` is set, and no test compares the two.

**Desired behaviour.** The static group text states no number, or is produced from `describeRoundLimitSplit()`. A test compares the `/mode` entry of the help groups with the one in `agent-commands.ts`.

**Risks.** `help-groups.ts` is under `src/standard/` and may be generated into the docs; if the docs copy needs a number, it is rendered from the same function.

### R9 - Flow ids are unique in a checkout (F-ID)

**Current behaviour.** `.metaproject/flows/` on `origin/main` holds two directories with id 352: `352-2026-09-27-audit-fixes-credential-leaks-to-external` (status `implemented`) and `352-2026-09-29-health-runs-the-project-s-real-linter-an` (status `in-progress`). `keryx flow list` therefore shows the id twice, and a bare reference to `352` is refused as ambiguous (`src/flow/store.ts`, `resolveFlowDir` and `assertUnambiguous`). Cause: ids are allocated from the local directory listing (`nextFlowId`, `src/flow/store.ts:92`), with a ledger in the git common directory since PR 205 (`src/flow/allocation.ts`) that keeps linked worktrees of one clone apart. The 09-27 folder was created in a checkout and stayed untracked until commit `b71404cd` of 2026-10-01 ("commit the untracked flow folders"), while the 09-29 folder was merged by `68616a75` of 2026-09-29. A folder that is not in the listing and not in the ledger of the clone that allocates is invisible, so the number is handed out again. The same commit renumbered 360-365 to 378-383 for a related clash and recorded them in `.metaproject/flows/id-map.json`; 352 has no entry there.

**Desired behaviour.** (a) The existing collision is repaired through the renumber path that PR 205 introduced, with an `id-map.json` entry, so that both flows keep their history. (b) A repository test or CI check fails when two flow directories share an id and no `id-map.json` entry accounts for it, so a collision is caught at the pull request, not on the operator's machine. Decision 4 picks how much more is done to the allocator.

**Risks.** Renumbering changes references in journals and review records of the renumbered flow; `id-map.json` is what lets a reader follow them. Flow 352 is `implemented`; the other one is open, so the open one is the natural one to move.

## Unverified

These were named in the brief and could not be established from the code and records available. They are not acceptance criteria. Each needs a pointer from the operator or a first task that finds it.

- The exact hole in `src/lib/templates.ts` at the lines the brief gave (`~2256-2274`): the quoting hole and the working-tree reads above are real and reproduced; whether the brief meant those or another one is not known.
- The finding F-005 of PR 984: neither a review report nor a comment on the pull request carries it (the pull request body does not). R4 anchors to the behaviour, not to the finding text.
- Concrete holes in `src/review/jev-risk.ts` beyond the duplicated test-file predicate: `isNonCodeHunk` treats every `.md`/`.txt` as prose, including `SKILL.md` and `.mdc` rules that drive agent behaviour (`.mdc` is not matched); whether that is a defect is a design question not decided here.
- Holes in `src/testing/service.ts` beyond the copy of the test-file pattern: the file (1108 lines) was not read in full.
- Whether the allocator already consults the remote listing (`src/flow/remote-flows.ts`) when it allocates; read only far enough to see the module exists.

## Decisions for the operator

1. **Transcript in the project tree (R5).** Recommended: keep it in the session directory and reference it by path and hash. Alternative: keep copying, but only with an explicit flag, and say so in the wrap-up output. Third option: keep today's behaviour and document it.
2. **Which paths are tests (R2).** Recommended: the pattern of `src/testing/selection.ts` (it already covers `__tests__/`, `e2e/`, `tests/`, `.test.`, `.spec.` for js/ts), plus `src/test/` and `test/` as directories. The reviewer set will change for the paths on which the five definitions disagree.
3. **Build output under packages (C5).** Probe on 2026-10-13 with `classifyPath`: `packages/app/dist/a.js`, `apps/web/build/x.js`, `lib/target/x.rs` and `src/generated/api.ts` are not classified; `docs/out/index.html` and `packages/core/generated/types.ts` are. `build/` is in neither directory list. Options: leave it (the rule is deliberately conservative: a generated directory is dropped only when no source root precedes it); add `build/` to the ambiguous list; recognise workspace roots (`packages/*`, `apps/*`). The criteria below cover only the choice recorded in the PR; the operator picks.
4. **How far to go on flow ids (R9).** Recommended: repair 352 and add the CI check. Larger: also make the allocator consult `origin/main` so an untracked local folder cannot reuse a number; that touches `flow init` and needs its own review.
5. **Flow shape.** Recommended: one flow, five task groups (T1 to T5), one pull request chain, because each item is small and local. Alternative: split the hook and git-output work (R1) from the rest.

## Tasks

- T1: R1 (hook template and `review.ts` git readers), including the test of the hook with a non-ASCII file name.
- T2: R2 and R3 (one test-file predicate, whole-word rule categories), including the replay over the rule corpus.
- T3: R4 and R5 (startup replay tests, transcript placement).
- T4: R6, R7 and R8 (close phrase negation, host-side irreversibility, help summary).
- T5: R9 (repair flow 352, duplicate-id check) and the release note.

## Out of scope for this draft

No flow is registered, no AC is frozen or confirmed, no `keryx flow` state command was run, and no source file is changed by this document. The operator reviews it, answers the decisions, and freezes the flow.
