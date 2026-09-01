# The flow record carries no base branch

## Problem

`flow.json` holds `pr: { url }` and no branch of any kind. Verified: its
top-level keys are `acChecksum, acConfirmed, createdAt, gates, history, id, pr,
schemaVersion, slug, source, status, tasks, title, updatedAt`. Nothing under
`src/flow/` reads `baseRefName` or any base ref — a search for it returns zero
hits outside tests.

So `keryx flow complete` has no recorded answer to "where was this supposed to
land", and asks four questions about the merge, none of which is that one:

1. a managed review record with at least one ingested round;
2. no finding without a terminal disposition at or above the floor;
3. the latest round ran against the PR head commit;
4. no unanswered external comments;
5. the verifier ran and its stats are on the record.

## What condition 3 already catches — do not understate it

Condition 3 is stronger than "the round ran". It asks *is the content the
reviewers read the content that merged*, by commit containment, falling back to
TREE EQUALITY when containment fails — which it does by construction for squash,
the strategy this project uses. Its own comment: "equal trees are a STRONGER
claim than ancestry, not a weaker one".

That incidentally catches the canonical wrong-target merge. A fix branch cut from
`feature/x` and merged to `main` instead produces a squash whose tree is
`main + fix`, not `feature/x + fix`; the trees differ and the gate reports
`violated`. This flow is NOT "the merge target is unchecked".

## The residual, which is narrow and is exactly where it hurts

Condition 3 compares CONTENT. It cannot distinguish two targets whose content is
the same, and nothing records which target was intended. The case that survives
is a target that has converged with the intended one — for instance `feature/x`
already merged to `main`, so a squash onto either produces the same tree.

That is precisely the shape `review-pr-feedback --fix` creates. It cuts a branch
from pull request #A's own head branch and must merge back into it, because the
whole point is that the fix lands INSIDE the pull request the reviewer is
reading. Landing it anywhere else leaves #A's diff unchanged while the run posts
`acted-on, fixed in <sha>` to every reviewer — a change nobody reviewed,
reported as success, with a durable reply record saying otherwise.

The value is typed and refused at the dispatch boundary (`base_branch` is a
required-shaped property of `flow-orchestrator-input`, added in PR #424), and
then survives inside the flow package only as prose the agent writes into
`journal.md`. Detectable at dispatch, undetectable at completion.

## Expected outcome

The base branch a flow was told to target is recorded in the CLI-owned state, and
`flow complete` refuses a merge that landed somewhere else — or states, at the
registration, that it cannot and why.

## Out of scope

- Changing the merge strategy or the review-gate's condition 3.
- Contract enforcement in production — flow 213.
