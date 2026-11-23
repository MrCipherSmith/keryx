# Reviewer brief — round 2, package `.metaproject/reviews/2026-11-23-review-flow-branch-r02`

You are one reviewer of round 2 of a managed review. Worktree root (your only checkout):
`/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/metaproject-redesign`, branch
`feat/desktop-metaproject-redesign`. This is a delta round: round 1 reviewed the change at
`60cbe1c565f4e478833605b41c49c2827eed2bbf` and raised 29 findings; fix tasks T17 to T21 answered them;
this round reviews `60cbe1c565f4..b1538097e636` (head `b1538097e636d9ec4c08f013b196e716ba09b18d`).
There is no pull request; the target is the branch.

By the operator's choice the round reads two slices only: `slice-03` (a FIX slice: the code and tests
the fixes changed, and the guide) and `slice-04` (new hunks). The flow package's JSON files and a second
look at round 1's whole diff are not read in this round.

## What to read, in this order

1. Your reviewer skill: the `skill_path` of your payload. It overrides any same-named agent type.
2. The shared reviewer laws: `.metaproject/rules/activity/review.mdc`.
3. Your payload (a `reviewer-input`): `review_context` (request, git, scope with what names the things
   the fixes changed, the 21 acceptance criteria, rules, memory), `slices`, `round`, `is_fix_round`,
   `prior_findings`, `known_findings`, `allowed_tools`, `exec_budget_s`.
4. Your slice, in full: the path your dispatch prompt names. A slice you did not read in full is not
   covered and must not be listed.

## A fix is new code

On `slice-03` (`is_fix_round: true`) you do two things.

- Review the fix on its own merits, through your lens, as you would any change: a fix arrives framed as
  the answer to a finding, and the defect it introduces is the one that gets missed. A defect a fix
  introduced is a new finding; say which finding the fix was answering.
- For the prior findings in your payload: each carries `claimed_disposition` and `claimed_evidence`,
  which are the fix round's claims, not facts. Check the code, not the commit message. In your
  `REVIEW_RESULT` return `prior_dispositions: [{ "id": "F-0NN", "disposition": "closed" | "open" |
  "partial" | "regressed" | "withdrawn" }]`: one entry for every prior finding marked
  `"disposition_owner": true` in your payload (your reviewer raised it in round 1), and for any other
  you checked against the code. Leave out a finding you did not check; do not guess. `closed` means the
  defect is gone and the behaviour is pinned; `open` means the fix does not reach it, and you say what
  is still true; `partial` means one site was fixed and others remain; `regressed` means the fix removed
  it and introduced another, which you file as a new finding; `withdrawn` means the round-1 finding was
  wrong, with the evidence.

`slice-04` (new hunks) is reviewed as a first round. `known_findings` in your payload are round 1's
info findings and its two refuted ones: do not report those again.

## Evidence the orchestrator already holds

All under `.metaproject/reviews/2026-11-23-review-flow-branch-r02/research-evidence/` unless a path says
otherwise.

- On this head, run by the orchestrator: `cd apps/desktop && bunx tsc --noEmit` exit 0; `bun test src`
  904 pass, 0 fail across 89 files; `bunx vite build` exit 0; root `bun run typecheck` exit 0;
  `bun run docs:check` exit 0.
- Impacted tests of this round (`tests-to-run.json`): `verify-tests-to-run-1.txt`.
- The mutation pass of round 1 (82 mutants) re-run on this head: `mutation-1.md` and `mutation-1.json`.
  `invalid` there means the mutant's anchor no longer occurs once in the file because a fix changed
  that line. Round 1's table, for comparison:
  `.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1-compact.txt`.
- Measurements of the Filters popover after the fix, in the flow journal
  (`.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/journal.md`, the entries on T17):
  browser dev build at 720×480, Chromium 156 and the system WKWebView (macOS 26.7.3), with the
  freshness banner in one line and with its Details expanded. The same entries record the live checks
  of the popover closing on leaving the view, of the catalog re-read on return and of the fact row.
- Not verified by anyone: Back in OpenSpec restoring the scroll, live (the project has no OpenSpec
  entries; it rests on its DOM test); hover, cursor and zoom on a real canvas; the native Tauri window
  (no Rust toolchain on this machine); WebKit of macOS versions older than 26.
- Round 1's report and findings: `.metaproject/reviews/2026-11-23-review-flow-branch/report.md` and
  `findings.json`. What each fix task did and what its worker noticed and left:
  `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results/T17.result.json` to
  `T21.result.json`.

## Rules for findings

- Severity and the finding fields: `## Severity (canonical)` in
  `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md` and
  `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`.
- Cross-repo rule, as written: **A claim about another service's behaviour, with no `file:line` at a
  pinned SHA behind it, is `info`.** Not `major`, however confident. This round consumes no cross-repo
  contract (`cross_repo: []`).
- Round obligations and fix-round shapes:
  `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md`, § "Round obligations" and
  § "Fix rounds — dispositions, regressions, withdrawal".
- A finding id is your own, unique in your reply (`F-001`, `F-002` …); do not reuse a round-1 id for a
  new finding.

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
     "slices": ["slice-03"],
     "stats": { "blocker": 0, "major": 0, "minor": 0, "info": 0 }
   }
   ```

   `prior_dispositions` is for a FIX slice; leave it out on `slice-04`.
3. A finding names its file and quotes the code it is about, copied verbatim. If nothing is wrong, say
   so: an empty findings list with the slice you covered is a result.
