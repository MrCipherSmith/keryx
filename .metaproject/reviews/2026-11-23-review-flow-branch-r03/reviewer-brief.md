# Reviewer brief — round 3, package `.metaproject/reviews/2026-11-23-review-flow-branch-r03`

You are one reviewer of round 3 of a managed review. Worktree root (your only checkout):
`/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/metaproject-redesign`, branch
`feat/desktop-metaproject-redesign`. Round 1 reviewed the whole change and raised 29 findings; fix round 1
answered them. Round 2 reviewed those fixes at `b1538097e636d9ec4c08f013b196e716ba09b18d` and raised 13
findings, most of them defects the fixes themselves brought; fix tasks T22 and T23 answered eight of them.
This round reviews `b1538097e636..8e0f656fb2aa` (head `8e0f656fb2aa3a2173487d4f6ca4ff1c89aa933a`): three
commits, `a37719ff2` (T22, behaviour), `8f5bf6d14` (T23, tests and one test seam in `App.tsx`) and
`8e0f656fb` (the flow's record). There is no pull request; the target is the branch.

The round has two slices: `slice-02` (the code and tests the two fix commits changed: `App.tsx`,
`MetaprojectView.tsx`, `RelationshipList.tsx` and their three test files) and `slice-01` (the flow package's
own files: dispatch, resolved-context and result JSON of T22 and T23, `flow.json`, `journal.md`, `tasks.md`).

The review tool does not take round 2 as a previous round, because round 2 ran on part of its plan and its
operator has not closed it. In the tool's terms this package is therefore a first round over the range above;
round 2's findings are attached to `slice-02` by the orchestrator, in your payload.

## What to read, in this order

1. Your reviewer skill: the `skill_path` of your payload. It overrides any same-named agent type.
2. The shared reviewer laws: `.metaproject/rules/activity/review.mdc`.
3. Your payload (a `reviewer-input`): `review_context` (request, git, scope with what names the things the
   fixes changed, the 21 acceptance criteria, rules, memory), `slices`, `round`, `is_fix_round`,
   `prior_findings`, `known_findings`, `allowed_tools`, `exec_budget_s`.
4. Your slice, in full: the path your dispatch prompt names. A slice you did not read in full is not covered
   and must not be listed.

## A fix is new code, and this is the second time

On `slice-02` (`is_fix_round: true`) you do two things.

- Review the change on its own merits, through your lens, as you would any change. Round 2 found that four
  correct-looking fixes of round 1 each changed something other code also read (a counter two callers used as
  a guard, an edge count two other places displayed, an error state a new path shared). The fixes in this slice
  change the same kind of thing again: a second counter beside the first, a flag that decides whether a read
  starts, a helper turned into a stable callback, a block of `App.tsx` turned into an exported component. For
  each, find who else reads what changed and what they now get. A defect a fix introduced is a new finding; say
  which finding the fix was answering.
- For the prior findings in your payload (round 2's, ids `F-001` to `F-009` without `F-005`): each carries
  `claimed_disposition` and `claimed_evidence`, which are the fix round's claims, not facts. Check the code, not
  the commit message. In your `REVIEW_RESULT` return `prior_dispositions: [{ "id": "F-0NN", "disposition":
  "closed" | "open" | "partial" | "regressed" | "withdrawn" }]`: one entry for every prior finding marked
  `"disposition_owner": true` in your payload (your reviewer raised it in round 2), and for any other you
  checked against the code. Leave out a finding you did not check; do not guess. `closed` means the defect is
  gone and the behaviour is pinned; `open` means the fix does not reach it, and you say what is still true;
  `partial` means one site was fixed and others remain; `regressed` means the fix removed it and introduced
  another, which you file as a new finding; `withdrawn` means the round-2 finding was wrong, with the evidence.

`slice-01` is the flow's record, reviewed for what your lens finds in it: whether what it says matches the code
and the commits, and whether the dispatch, resolved-context and result files name what exists. It carries no
prior findings; leave `prior_dispositions` out there.

`known_findings` in your payload are findings already in the record that are not in the fix loop: round 2's
`F-005` (finding ids in test titles, which the operator dismissed: the repository titles tests that way), its
info findings `F-010` to `F-013`, and round 1's info findings. Do not report those again.

## Two choices the fix made that nobody above the implementer decided

The T22 worker marked both as needing the operator; the orchestrator took the default each finding's finish
line implied and did not ask. Judge them as code through your lens. An operator answer does not exist for them.

1. A quiet re-read on return that finds a changed snapshot replaces the catalog and does not cancel a wiki-link
   lookup still in flight; if that lookup's answer comes from the new snapshot, the existing "Project knowledge
   changed while loading" banner with Refresh catalog shows.
2. A return while a catalog read is already in flight (a Retry, the reload after a rebuild) starts no quiet
   read; the read in flight finishes and shows its own result or failure.

## Evidence the orchestrator already holds

All under `.metaproject/reviews/2026-11-23-review-flow-branch-r03/research-evidence/` unless a path says
otherwise.

- On this head, run by the orchestrator: `cd apps/desktop && bunx tsc --noEmit` exit 0; `bun test src` 922 pass,
  0 fail across 89 files; `bunx vite build` exit 0; root `bun run typecheck` exit 0.
- The impacted test files, one process each: `verify-tests-to-run-1.txt`.
- Round 2's 34 mutants of the fix code re-run on this head by `keryx review mutate`: `mutation-1.md` and
  `mutation-1.json` (28 killed, 3 survived, 3 invalid). The three survivors, R2-12, R2-18 and R2-30, were judged
  redundant code or equivalent in round 2 and by T23. `invalid` means a fix moved the mutant's line: R2-14 and
  R2-23 were re-written on their new lines and are killed; so are five mutants of the branches T22 added
  (`moved-mutants-1.txt`; the script is named in the T23 journal entry). R2-24's moved line was not re-run.
- In a scratch copy with the two production files of T22 put back to round 2's head, seven of T22's new tests
  fail and nothing else does (flow journal, the entry on T22).
- Seen live in the browser dev build after both tasks (flow journal, the entries on T22 and T23): one `catalog`
  request on return to the view and no alert; the open Wiki page and its "Relationships 13" disclosure over 13
  rows kept; the Filters popover closing on leaving the view and staying closed on return.
- Not verified by anyone: a wiki page that links to itself, a failed quiet re-read and a lookup in flight across
  leaving and returning were not seen live (each rests on its DOM test); the native Tauri window (no Rust
  toolchain on this machine); WebKit of macOS versions older than 26.
- Round 2's report and findings: `.metaproject/reviews/2026-11-23-review-flow-branch-r02/report.md` and
  `findings.json`. What each fix task did and what its worker noticed and left:
  `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results/T22.result.json` and
  `T23.result.json`.

## Rules for findings

- Severity and the finding fields: `## Severity (canonical)` in
  `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md` and
  `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`. The boundary test is
  asked of the finding: does it name a trigger and the observable outcome that trigger produces? A break of
  behaviour that worked before, with both named, is `major`; a finding whose outcome costs a user, a caller or
  persisted state nothing is `minor` however precisely its trigger is named.
- Cross-repo rule, as written: **A claim about another service's behaviour, with no `file:line` at a
  pinned SHA behind it, is `info`.** Not `major`, however confident. This round consumes no cross-repo
  contract (`cross_repo: []`).
- A finding id is your own, unique in your reply (`F-001`, `F-002` …).
- The fix loop of this flow has run twice. A finding that would send it round again should be worth a third
  pass: say what a user, a caller or the next editor loses if it stays.

## Tools

- `allowed_tools` and `exec_budget_s` come from your payload. `read-only` / `0` means: read files, and
  run only `git log`, `git blame`, `git show`, `keryx gdgraph affected|find`, `keryx test related`,
  `keryx wiki ask`, `keryx memory search` and `keryx ctx rg|read`. Never run tests, servers, health
  checks or anything that writes in the reviewed tree. The one reviewer with `run-tests` may run tests
  within its budget, and only in a scratch copy.
- A shell hook refuses raw `rg`, `grep`, `sed`, `head`, `tail`, `cat`, `find` and raw `git diff`; use
  `keryx ctx rg "<pattern>" <path>`, `keryx ctx read <file>` and the Read tool.
- Do not ask the user questions and do not spawn subagents. Edit nothing except your result file.
- Agent conduct (mandatory): (1) No AI attribution: no `Co-Authored-By:` trailer or "Generated by/with …" line naming an AI model, agent or tool in commit messages, PR or ticket descriptions, or comments. A human co-author, a code-generator note and a model name as technical provenance are allowed. (2) No commit, push, merge or release without an explicit ask. Invoking an orchestrator is the ask for its own task-boundary commits; merge and release always need their own ask. (3) Never destroy others' work: no `git stash` in a dirty tree, no blanket `git add -A` while parallel lanes share a checkout, no force-push to a shared branch. (4) No secrets or personal data in output, logs or commits. (5) Report honestly: name what failed, what was skipped and what was not verified.

## Your reply

1. Write your whole reply to the result path your dispatch prompt names, before you answer.
2. The reply starts with a `STATUS:` line and carries one `REVIEW_RESULT` object that conforms to
   `reviewer-finding.schema.json`. The schema requires `status`, `reviewer`, `summary`, `findings` and
   `stats`; the round tool counts an object without `status` as no result. `confidence` on a finding is
   `high`, `medium` or `low`. The shape:

   ```
   STATUS: DONE

   REVIEW_RESULT
   {
     "status": "DONE",
     "reviewer": "<your reviewer name>",
     "summary": "<two or three sentences>",
     "findings": [],
     "prior_dispositions": [ { "id": "F-001", "disposition": "closed" } ],
     "slices": ["slice-02"],
     "stats": { "blocker": 0, "major": 0, "minor": 0, "info": 0 }
   }
   ```

   `prior_dispositions` is for `slice-02`; leave it out on `slice-01`.
3. A finding names its file and quotes the code it is about, copied verbatim. If nothing is wrong, say
   so: an empty findings list with the slice you covered is a result.
