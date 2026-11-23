# Implementation Plan

Status: ready

## Approach

Fix the five board defects in place and add one optional field to the card badge. No table, protocol version or lane model changes: lanes stay as they are until stage 1.

Alternative rejected: jumping straight to GitHub-only lanes. It removes defects 1–3 by construction but needs the Keryx links row first, or the review state disappears from the board.

## Steps

1. Board behaviour in the Desktop UI (T5): remove the active-review filter bypass; remove the active-first sort; draw the Done lane only when the state filter can produce closed or merged pull requests; narrow the tab indicator.
2. Outdated result in the badge (T6, parallel with T5): the SQL also returns the newest finished run with a recorded result on another range; `localBadge` reports it as an optional `outdated` field. Active-run behaviour and `ready`/`publicationPending` for the current range do not change.
3. Outdated result on the card (T7, after T5 and T6): card and list show the outdated review with the reviewed short SHA; `badgesEqual` compares the new field.
4. Toolbar on one row (T8, after T7).
5. Verification (T9): Desktop and backend test suites, typecheck, lint, live check in the browser dev build.
6. Review (T10): review-orchestrator on the branch.

## Tab indicator rule

Lit when at least one open pull request satisfies one of: the viewer's login is in `reviewers`; the viewer is the author and the decision is `CHANGES_REQUESTED`; the card has unread replies addressed to the viewer; the local review awaits an answer or a publication decision. The last clause stays until the Reviews tab exists (stage 2).

## State × event matrix

| state \ event | review starts | review finishes | author pushes a commit | filter applied |
|---|---|---|---|---|
| card visible, no review | order unchanged; lane per existing rule | — | order unchanged | hidden if it does not match |
| card with active review | — | order unchanged | badge shows the active run as other-revision (unchanged) | hidden if it does not match (AC1) |
| card with finished review on current head | order unchanged | — | card shows "Outdated review · <sha>" (AC5, AC6) | hidden if it does not match |
| card with outdated review | new run takes precedence over the outdated label | outdated label replaced by the new result | still outdated, newest finished run wins | hidden if it does not match |
| Done lane, default filter | no change | no change | no change | drawn only when closed or merged can match (AC3) |

## Risks

- DOM tests encode the current bypass and sort; they must be rewritten to the new behaviour, not deleted.
- The SQL change must not return report text or more than one extra row per card.
- A typed card struct in Rust would drop the new field in the packaged app; T6 checks and reports.
