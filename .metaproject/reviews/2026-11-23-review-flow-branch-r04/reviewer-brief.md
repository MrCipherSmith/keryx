# Reviewer brief — round 4, package `.metaproject/reviews/2026-11-23-review-flow-branch-r04`

You are one reviewer of round 4 of a managed review. Worktree root (your only checkout):
`/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/metaproject-redesign`, branch
`feat/desktop-metaproject-redesign`. Round 3 reviewed the commits of fix round 2 at
`8e0f656fb2aa3a2173487d4f6ca4ff1c89aa933a` and raised 15 findings, 8 of them minor; fix tasks T24 and T25
answered the eight. This round reviews `8e0f656fb2aa..744d9ef7542f` (head
`744d9ef7542f94e3442b120fe265d97f11923ea1`): three commits, `b26498c28` (T25, the flow's record),
`46c472162` (T24: one production change in `MetaprojectView.tsx` and nine tests) and `744d9ef75` (the
flow's record of the round). There is no pull request; the target is the branch.

The round reads three slices: `slice-01` (a FIX slice: `MetaprojectView.tsx`, the three test files, and of
the flow's record `journal.md`, `tasks.md`, `verification/fix-round-2.md` and `results/T22.result.json`),
`slice-02` (new: the dispatch, request, resolved-context and result files of T24, `flow.json` and
`verification/fix-round-3.md`) and `slice-03` (new hunks, see below). By the operator's choice since round 2
the round does not take a second look at the earlier rounds' diff.

## What `slice-03` is

`slice-03` (about 5 KB) holds removed lines only, in `MetaprojectView.tsx`, `OpenSpecView.tsx` and
`metaproject.css`. The round tool cut it against the branch's merge-base: most of its lines (the
`GRAPH_PADDING` constant, the `nodes` prop of `RepositoryMarkdown`, the old catalog banners, the
`@media (max-width: 700px)` block and others) were removed before this round, and round 2 reviewed their
removal. Three of its lines belong to this round: the old `const [error, setError] = useState("");`, the old
`setError("");` in `rebuild()` and the old `setError(errMessage(cause))`, the removed half of T24's change.
If `slice-03` is your slice, read it, say which hunks are this round's, and then apply your lens to the
change those three lines are half of: `git show 46c472162 -- apps/desktop/src/metaproject/MetaprojectView.tsx`
(20 changed lines) and the file at head around it. That is the only production change of the round.

## What to read, in this order

1. Your reviewer skill: the `skill_path` of your payload. It overrides any same-named agent type.
2. The shared reviewer laws: `.metaproject/rules/activity/review.mdc`.
3. Your payload (a `reviewer-input`): `review_context` (request, git, scope with what names the things the
   fix changed, the 21 acceptance criteria, rules, memory), `slices`, `round`, `is_fix_round`,
   `prior_findings`, `known_findings`, `allowed_tools`, `exec_budget_s`.
4. Your slice or slices, in full: the paths your dispatch prompt names. A slice you did not read in full is
   not covered and must not be listed.

## A fix is new code, and this is the third time

The catalog effect of `MetaprojectView.tsx` and the state around it have now been fixed three times. Round
1's fix shared a counter with two other callers; round 2's fix told a quiet re-read to leave the error
banner alone in both directions while one state held two different failures; round 3 found that. The fix in
this round makes `error` an object, `{ source: "catalog" | "rebuild", message } | null`, and lets a quiet
re-read that succeeds clear it only when its source is a catalog read. On `slice-01`
(`is_fix_round: true`) you do two things.

- Review the fix on its own merits, through your lens. The worker wrote a table of the banner's states (each
  standing failure followed by each kind of read) in
  `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results/T24.result.json`; check the
  code against the cells that fall under your lens rather than trusting the table, and look for a cell it
  does not have. A defect the fix introduced is a new finding; say which finding the fix was answering.
- For the prior findings in your payload (round 3's `F-001` to `F-008`): each carries `claimed_disposition`
  and `claimed_evidence`, which are the fix round's claims, not facts. Check the code or the record, not the
  commit message. In your `REVIEW_RESULT` return `prior_dispositions: [{ "id": "F-0NN", "disposition":
  "closed" | "open" | "partial" | "regressed" | "withdrawn" }]`: one entry for every prior finding marked
  `"disposition_owner": true` in your payload (your reviewer raised it in round 3), and for any other you
  checked. Leave out a finding you did not check; do not guess.

`slice-02` and `slice-03` are reviewed as new; leave `prior_dispositions` out of a reply that covers only
those.

`known_findings` in your payload are findings already in the record that are not in the fix loop: round 3's
info findings `F-009` to `F-015`, round 2's info findings and its `F-005`, which the operator dismissed. Do
not report those again.

## Evidence the orchestrator already holds

All under `.metaproject/reviews/2026-11-23-review-flow-branch-r04/research-evidence/` unless a path says
otherwise.

- On this head, run by the orchestrator: `cd apps/desktop && bunx tsc --noEmit` exit 0; `bun test src` 931 pass,
  0 fail across 89 files; `bunx vite build` exit 0; root `bun run typecheck` exit 0.
- The impacted test files, one process each: `verify-tests-to-run-1.txt`.
- Mutants of T24's change and the two moves of `project.current`, run by the orchestrator in a scratch copy:
  `t24-mutants-1.txt`. Each run of fix round 3, with every mutant's anchor and replacement, is written out in
  the tracked file `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/verification/fix-round-3.md`.
  In short: the new F-001 test is red against the previous production file; of round 3's twelve named
  mutants nine are killed, R3-13 survives (the call site in `ProjectWindow`, which no test renders; it rests
  on the live check) and R3-19 and R3-20 survive one at a time and are killed together, because a read that
  is not quiet moves `project.current` twice, in the effect's cleanup and in its body, and either move
  retires pending work. The worker noted the double move and left it.
- Round 3's 20 mutants re-run on this head by `keryx review mutate`: `mutation-1.md` and `mutation-1.json`,
  when the run has finished (it was started with the round; if the file is not there, use
  `verification/fix-round-3.md`).
- Seen live in the browser dev build after T24 (flow journal, the entry on T24): three returns to the view,
  each with one `catalog` request and no alert; on one of them the snapshot had moved and the quiet read
  replaced the catalog, keeping the selected page.
- Not verified by anyone: a failed catalog read followed by a successful quiet re-read, a wiki page that
  links to itself, a failed quiet re-read and a lookup in flight across leaving and returning were not seen
  live (each rests on its DOM test); the native Tauri window (no Rust toolchain on this machine); WebKit of
  macOS versions older than 26.
- Round 3's report and findings: `.metaproject/reviews/2026-11-23-review-flow-branch-r03/report.md` and
  `findings.json`.

## Rules for findings

- Severity and the finding fields: `## Severity (canonical)` in
  `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md` and
  `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`. The boundary test is
  asked of the finding: does it name a trigger and the observable outcome that trigger produces? A finding
  whose outcome costs a user, a caller or persisted state nothing is `minor` however precisely its trigger
  is named; a preference or a risk with no demonstrated path is `info`.
- Cross-repo rule, as written: **A claim about another service's behaviour, with no `file:line` at a
  pinned SHA behind it, is `info`.** Not `major`, however confident. This round consumes no cross-repo
  contract (`cross_repo: []`).
- A finding id is your own, unique in your reply (`F-001`, `F-002` …).
- This is round 4 of at most 5. A finding that would send the loop round again should be worth it: say what
  a user, a caller or the next editor loses if it stays. A surviving mutant that no input can tell from the
  original is redundant code, not a test gap; say so and do not file it as one.

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
     "slices": ["slice-01"],
     "stats": { "blocker": 0, "major": 0, "minor": 0, "info": 0 }
   }
   ```

   `prior_dispositions` is for `slice-01`; leave it out otherwise.
3. A finding names its file and quotes the text it is about, copied verbatim. If nothing is wrong, say
   so: an empty findings list with the slices you covered is a result.
