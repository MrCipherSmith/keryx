# Reviewer brief — round 5, package `.metaproject/reviews/2026-11-23-review-flow-branch-r05`

You are one reviewer of round 5 of a managed review, the last round the loop allows. Worktree root (your only
checkout): `/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/metaproject-redesign`, branch
`feat/desktop-metaproject-redesign`. Round 4 reviewed the commits of fix round 3 at
`744d9ef7542f94e3442b120fe265d97f11923ea1` and raised 10 findings, 5 of them minor; the operator dismissed one (F-004),
and fix tasks T26 and T27 answered the other four. This round reviews `744d9ef7542f..857036d02174` (head
`857036d02174a396b2acecf09cdcaf2560484a93`): three commits, `c8db67492` (T26: four DOM tests at the end of
`apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx`, no production change), `924b2b82c` (T27: the flow's
record) and `857036d02` (the flow's record of the round). There is no pull request; the target is the branch.

The review tool does not take round 4 as a previous round, because round 4 was run on part of its plan by the operator's
choice (no second look at earlier rounds' diff), so this package covers only the range since round 4's head, and the
tool records it as a first round. The round has one slice, `slice-01` (113 KB, 11 files): the test file and, of the
flow's record, `journal.md`, `tasks.md`, `flow.json`, `results/T24.result.json`, `verification/fix-round-3.md`,
`verification/fix-round-4.md` (new) and T26's dispatch, request, resolved-context and result files.

## What to read, in this order

1. Your reviewer skill: the `skill_path` of your payload. It overrides any same-named agent type.
2. The shared reviewer laws: `.metaproject/rules/activity/review.mdc`.
3. Your payload (a `reviewer-input`): `review_context` (request, git, scope, the 21 acceptance criteria, rules, memory),
   `slices`, `round`, `is_fix_round`, `prior_findings`, `known_findings`, `allowed_tools`, `exec_budget_s`.
4. `slice-01` in full: the path your dispatch prompt names. A slice you did not read in full is not covered and must not
   be listed.

## A fix is new code

The production code of the explorer's error state did not change in this round. The four tests pin what round 4 found
unpinned: a failed rebuild's banner against the clears a read or a rebuild the user starts makes at its start (round 4's
F-001, mutants R4-10 and R4-11) and the order of a superseded read against the banner (round 4's F-002, mutants R4-7 and
R4-8). The production code they test is `apps/desktop/src/metaproject/MetaprojectView.tsx` lines 373-420 (the catalog
effect) and 675-685 (`rebuild()`); read it at head. `is_fix_round` is true. You do two things.

- Review the new tests and the record on their own merits, through your lens. A defect the fix introduced is a new
  finding; say which finding the fix was answering.
- For the prior findings in your payload (round 4's F-001, F-002, F-003, F-005): each carries `claimed_disposition` and
  `claimed_evidence`, which are the fix round's claims, not facts. Check the code or the record, not the commit message.
  In your `REVIEW_RESULT` return `prior_dispositions: [{ "id": "F-0NN", "disposition": "closed" | "open" | "partial" |
  "regressed" | "withdrawn" }]`: one entry for every prior finding marked `"disposition_owner": true` in your payload, and
  for any other you checked. Leave out a finding you did not check; do not guess.

`known_findings` in your payload are findings already in the record that are not in the fix loop: round 4's F-004
(dismissed by the operator: a fix task's result file writes its own round's finding ids bare) and its info findings F-006
to F-010, round 3's info findings F-009 to F-015, and round 2's F-005 (dismissed) and info findings. Do not report those
again.

## Evidence the orchestrator already holds

All under `.metaproject/reviews/2026-11-23-review-flow-branch-r05/research-evidence/` unless a path says otherwise.

- On this tree before the commits, run by the orchestrator: `cd apps/desktop && bunx tsc --noEmit` exit 0; `bun test src`
  935 pass, 0 fail across 89 files; `bunx vite build` exit 0; root `bun run typecheck` exit 0.
- The impacted test files at head, one process each: `verify-tests-to-run-1.txt`.
- Round 4's twelve mutants (`R4-1` to `R4-12`) run one at a time in a scratch copy against `MetaprojectView.dom.test.tsx`
  after T26: `t26-mutants-1.txt`. Each mutant's anchor and replacement is written out in the tracked file
  `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/verification/fix-round-4.md`. In short: nine killed,
  R4-7, R4-8, R4-10 and R4-11 each by one of the new tests; R4-1 and R4-12 survive as equivalent and R4-6 as a guard older
  than the branch's fixes, as judged in round 4.
- Not verified by anyone: the native Tauri window (no Rust toolchain on this machine); WebKit of macOS versions older than
  26; live checks of a failed rebuild followed by Retry or a second rebuild, and of a superseded read (each rests on its
  DOM test; the app's own onRebuild reports a failure as a toast, round 4's info F-009).
- Round 4's report and findings: `.metaproject/reviews/2026-11-23-review-flow-branch-r04/report.md` and `findings.json`.

## Rules for findings

- Severity and the finding fields: `## Severity (canonical)` in
  `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md` and
  `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`. The boundary test is asked of
  the finding: does it name a trigger and the observable outcome that trigger produces? A finding whose outcome costs a
  user, a caller or persisted state nothing is `minor` however precisely its trigger is named; a preference or a risk with
  no demonstrated path is `info`.
- Cross-repo rule, as written: **A claim about another service's behaviour, with no `file:line` at a pinned SHA behind
  it, is `info`.** Not `major`, however confident. This round consumes no cross-repo contract (`cross_repo: []`).
- A finding id is your own, unique in your reply (`F-001`, `F-002` …).
- This is round 5 of at most 5: no fix round follows inside the loop. A finding should be worth carrying into the
  completion report: say what a user, a caller or the next editor loses if it stays. A surviving mutant that no input can
  tell from the original is redundant code, not a test gap; say so and do not file it as one.
- A quote must be one line of the file, copied verbatim, that occurs once in it; if the line you mean occurs twice, quote
  a neighbouring line that occurs once and name the line you mean in `problem`.

## Tools

- `allowed_tools` and `exec_budget_s` come from your payload. `read-only` / `0` means: read files, and run only
  `git log`, `git blame`, `git show`, `keryx gdgraph affected|find`, `keryx test related`, `keryx wiki ask`,
  `keryx memory search` and `keryx ctx rg|read`. Never run tests, servers, health checks or anything that writes in the
  reviewed tree. The one reviewer with `run-tests` may run tests within its budget, and only in a scratch copy.
- A shell hook refuses raw `rg`, `grep`, `sed`, `head`, `tail`, `cat`, `find` and raw `git diff`; use
  `keryx ctx rg "<pattern>" <path>`, `keryx ctx read <file>` and the Read tool.
- Do not ask the user questions and do not spawn subagents. Edit nothing except your result file.
- Agent conduct (mandatory): (1) No AI attribution: no `Co-Authored-By:` trailer or "Generated by/with …" line naming an AI model, agent or tool in commit messages, PR or ticket descriptions, or comments. A human co-author, a code-generator note and a model name as technical provenance are allowed. (2) No commit, push, merge or release without an explicit ask. Invoking an orchestrator is the ask for its own task-boundary commits; merge and release always need their own ask. (3) Never destroy others' work: no `git stash` in a dirty tree, no blanket `git add -A` while parallel lanes share a checkout, no force-push to a shared branch. (4) No secrets or personal data in output, logs or commits. (5) Report honestly: name what failed, what was skipped and what was not verified.

## Your reply

1. Write your whole reply to the result path your dispatch prompt names, before you answer.
2. The reply starts with a `STATUS:` line and carries one `REVIEW_RESULT` object that conforms to
   `reviewer-finding.schema.json`. The schema requires `status`, `reviewer`, `summary`, `findings` and `stats`; the round
   tool counts an object without `status` as no result. `confidence` on a finding is `high`, `medium` or `low`. The shape:

   ```
   STATUS: DONE

   REVIEW_RESULT
   {
     "status": "DONE",
     "reviewer": "<your reviewer name>",
     "summary": "<two or three sentences>",
     "findings": [],
     "prior_dispositions": [ { "id": "F-001", "disposition": "closed" } ],
     "slices": ["slice-01"],
     "stats": { "blocker": 0, "major": 0, "minor": 0, "info": 0 }
   }
   ```
3. A finding names its file and quotes the text it is about, copied verbatim. If nothing is wrong, say so: an empty
   findings list with the slice you covered is a result.
