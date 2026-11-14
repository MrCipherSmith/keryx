# Round 2 reviewer brief (PR 1166) — shared by every dispatch

Project root: /Users/tsaitler.aleksandr/goodea/keryx/.claude/worktrees/review-process-audit (call it R).
Package: R/.metaproject/reviews/2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166 (call it P).

1. Read R/.metaproject/index.md first, then your reviewer skill (path in your task) and follow it.
2. Read-only. Edit nothing. The only commands you may run are `git log`, `git blame`, `git show` (read-only history), and code search through `keryx ctx rg` (never bare rg/grep). The one file you write is your result file.
3. Your input is the slice named in your task: P/slices/<slice>.diff. Delta range of this round: e9ac9253fde7..b076a85a6354 (round 1 reviewed up to e9ac9253). Round metadata: P/round.json. Prior findings: P/prior_findings.json.
4. Severity follows your skill's rubric. A claim about behaviour you cannot point to with file:line at head b076a85a6354 is `info`. Every finding carries `file`, `line`, a verbatim `quote` from that file at head, `severity`, `evidence`, `impact`, `suggested_fix`, `confidence`.
5. Before you reply, write your WHOLE reply to the result file named in your task (under P/raw/). It must start with one line `STATUS: DONE` (or INCOMPLETE / BLOCKED / NEEDS_CONTEXT), followed by one fenced block whose info string is `json REVIEW_RESULT`, holding one object that conforms to R/.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json, with `"reviewer": "<your reviewer name>"` and `"slices": ["<slice id>"]` (list the slice only if you read it in full).
6. Your final message to the orchestrator is only the STATUS line and the number of findings — the file is the result.

FIX slice (kind fix) only: this is a fix round (`is_fix_round: true`). The findings attached to slice-01 are, by id, from P/prior_findings.json:
review-architecture-w1:F-001, review-logic-w2:F-001, review-degradation-w2:F-001, review-logic-w3:F-002, review-degradation-w2:F-003, review-architecture-w2:F-004, review-degradation-w2:F-002, review-architecture-w3:ARCH-1, review-testing-practices-w1:F-001, review-testing-practices-w2:TP-2, review-logic-w4:F-001, review-security-code-w3:SEC-1.
Judge each against the code at head (not the commit message) and put `"prior_dispositions": [{"id": "<id>", "disposition": "closed|open|partial|regressed|withdrawn"}]` in your REVIEW_RESULT, one entry per id. A fix is new code: review the fix lines on their own merits too, and file any defect a fix introduced as a new finding.

SECOND-LOOK slice (kind second-look) only: this is code already reviewed in round 1 and unchanged since. One cheap second look: report only real defects round 1 missed (check P/prior_findings.json so you do not repeat one).
