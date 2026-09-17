# Implementation Plan

Status: formalized

## Approach

Treat the sweep as an inventory with a proof, not as a rewrite. Every criterion
names a FILE and a CLAIM, and the test for "done" is that the claim is gone or
corrected — something a grep can settle and a reader can check, rather than "the
page reads better now".

Three rules keep this phase honest:

1. **Correct what is false; keep what is true.** The page's flow-173 material on
   process-group ownership, sandbox reuse, the approval gate, bounded rails and
   session scoping survived all three phases unchanged. Rewriting it would be
   churn that hides the real edits in a large diff.
2. **The banner is not the fix.** A "superseded in part" note at the top, with a
   body that still says "poll, not push", is how this page got here. The body is
   what gets edited; the status line changes because the body did.
3. **A claim that cannot be made true by editing prose is a finding.** If the
   docs describe something better than the code does, that is reported, not
   quietly written into existence.

## Steps

1. Freeze the inventory as criteria (this file's companion), one per file and
   claim, so "done" is checkable.
2. Rewrite `.metaproject/wiki/architecture/background-jobs.md` around the
   supervised-task model: summary, the task lifecycle (yield → background →
   terminal status + killReason), completion delivery and the hold/wake rules,
   the task tools and their deprecated aliases, the side-worker rules, and the
   operator's levers (`/demote`, abort). Keep and re-anchor the still-true
   sections rather than re-deriving them.
3. Correct the Prior art and Out of scope sections specifically: "Poll, not push"
   and "push/event-driven wakeup" are now descriptions of what keryx DOES, and
   "changes to the synchronous path are out of scope" is simply false.
4. Refresh the wiki index entry so the first thing a reader meets matches the
   page.
5. Rewrite the affected rows of `docs/verification/keryx-shell-tui-test-catalog.md`
   (TOOL-11, BGJOB-01…03) against the tools that exist.
6. Mark P3 in the requirements package: README status, specification status,
   PRD gap row, and the metrics rows that name documentation.
7. Verify: `keryx wiki validate` (the wiki has its own gate), a grep proving the
   retired vocabulary is gone from the pages in scope, `keryx health run`, and the
   full suite — docs changes can still break tests that read documentation
   (`documentation links` runs in CI).
8. Review round ingested LAST, against the head that will merge.
9. Journal deviations; close the flow.

## Risks

- **The page is long and mostly right.** The temptation is a full rewrite, which
  would bury three or four real corrections in hundreds of changed lines and make
  the review worthless. The diff should be readable as a list of corrections.
- **"Documentation-only" is not automatically safe.** A wiki page is an input to
  agents in this repo: `keryx wiki` pages are read by the routing layer, and a
  page that contradicts the code sends the next agent down the wrong path. The
  same care applies as to code.
- **Retired vocabulary hides in prose.** `background: true`, `job_id`,
  "poll", "opt-in" appear in sentences that are otherwise fine; a grep for the
  tokens is the check, but each hit needs reading — a blanket replace would
  produce text that is technically current and says nothing.
- **Scope creep into other packages.** Several other requirement documents
  mention background jobs. They describe their own decisions at their own time
  and are explicitly not in scope; touching them would make this phase unbounded.
