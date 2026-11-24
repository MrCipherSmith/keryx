# Fix round 1 — findings to fix (review package `.metaproject/reviews/2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1304`)

Raw reviewer replies: `<package>/raw/<reviewer>-w<n>.txt`; verifier claims with red probes: `raw/review-verifier-w1.txt`, `raw/review-verifier-w2.txt`. Each `suggested_fix` is a hypothesis: reproduce (red), check against plan.md's state × event matrix, then fix. Fix exactly these; anything else is a question back to the orchestrator.

## Operator decisions that shape the fixes (journal.md)

- D-R1 (2026-11-24): round rule — an attempt joins the **current highest** round when it repeats that round's base..head or continues its predecessor; any other attempt, including a return to an earlier range (A,B,A), opens the next round. AC1 was re-frozen with this wording.
- D-R2: freshness has a third kind `unknown` (already implemented).

## Backend — worker FA (`src/review/*`, `src/commands/*`, docs)

| id | source | fix |
|---|---|---|
| FA-1 | logic-w5 F-001 (major, D-R1) | `roundFor`: same-range retry only within the current highest round; A,B,A opens round 3. Fixture for A,B,A (also closes testing-w2 F-003). Update plan.md T5 text and the implementation-plan «Состояние этапа 2» sentence about A,B,A. |
| FA-2 | logic-w1 F-002 (major, verified) + logic-w4 F-002 | `reviewNeedsViewer`: `ready` lights only when publication is `"pending"`. Store `publication()` reports `published`/`skipped` for any finished attempt with a reviewed range when the receipt/marker exists (partial/budget too); `existing` attempts never need the viewer. `reviewState`: a failed/cancelled/blocked newest attempt in a round that already has a finished reviewed attempt keeps that attempt's `ready`/`published` (spec: "stopped … and the round has no accepted findings"). Update `review-entity.test.ts:89` expectation. |
| FA-3 | logic-w2 F-001 (major, verified) | `ReviewSummary` gains `reviewed: { baseSha, headSha } \| null` = the domain's reference attempt (newest finished with a reviewed range); Desktop will use it (FB). |
| FA-4 | degradation-w1 F-001 (major, verified, backend half) | `reviewRows` keeps archived attempts, flagged (`archived: true`); state/findings/publication ignore archived attempts; a Review whose attempts are all archived is listed with `archived: true` (summary field) and state from its last attempt. Deleted attempts stay out. |
| FA-5 | arch-w2 F-001 | One domain helper decides "needs a commit-count comparison" (used by the command and by `freshness`). |
| FA-6 | arch-w2 F-002 | Move `writeJson` (bound to `withCurrentGithubBinding`) into `src/review/board-github.ts`; review-board's own stays private. |
| FA-7 | perf-w2 F-001, highload-w2 F-002, logic-w4 F-001 | Card reads: skip Reviews with local `closedAt`; keep cards from batches that succeeded when one batch fails (warning); batches may run with small parallelism (`mapPool`, ≤3). When a Review's card could not be read, it does not count for `reviewNeedsViewer` unless `needs_answer`. |
| FA-8 | highload-w2 F-001, degradation-w2 F-003 | 25-compare cap picks by newest activity (the list order), not PR number. |
| FA-9 | highload-w2 F-003 | Overall deadline for the compare phase (e.g. 60 s); unfinished compares → `commits: null` + one warning. |
| FA-10 | perf-w3 F-001, degradation-w3 F-002 | `assignReviews`/`roundFor` stop re-parsing every attempt's `details` per row: keep a per-Review in-memory map during the loop (or select only `json_extract` base/head once). |
| FA-11 | logic-w5 F-002 | A queued request superseded before it ever started does not keep a round of its own: when `requestAttempt` supersedes an unstarted queued row, the new attempt takes that row's round (or equivalent rule), `previous_run_id` skips it. Test. |
| FA-12 | testing-w2 F-001, F-002, F-004, F-005, F-006, F-007 | Add the missing fixtures: `referenceHead` fallback with requested head ≠ PR head; deleted attempts hidden + `recoverable` shown as `failed`; non-hex SHA skips compare; failed attempt carrying a reviewed range; the positional-arg rejection test must fail for the right reason; cap at exactly 25. |
| FA-13 | degradation-w2 F-001, PC-001, PC-002 | `docs/docs/cli-reference.md`: list `unknown` freshness; say the list read migrates an older store (opens it writable). |
| FA-14 | degradation-w2 F-002 | `specification.md`: protocol-version / schemas lines match the decision (`version: 1` kept, new payload). |
| FA-15 | degradation-w1 F-005, regression-w1 note | `docs/docs/desktop-app.md` (~156, 168, 426, 437-438) and `docs/docs/guides/desktop-metaproject.md:3`: tabs/shortcuts Sessions ⌘1 · Flows ⌘2 · Reviews ⌘3 · Pull requests ⌘4 · Issues ⌘5 · Metaproject ⌘6; review interface and Review rules live in the Reviews tab. |
| FA-16 | PC-006, logic-w1 F-004, PC-004 | implementation-plan «Состояние этапа 2»: the PR-card review link with state/round/behind (rest of R4) is not delivered here — it lands with stage 1's work row (`outdated.round` and `review reviews` provide the data); stage-3 hand-off line names «New review round» not «Review again». plan.md: mention `unknown` freshness and the measured toolbar result. |
| FA-17 | degradation-w3 F-001 | Late-imported package ordering: keep as documented limitation (plan T5 already says so); add one test pinning the behaviour so it is deliberate. |

## Desktop — worker FB (`apps/desktop/**`), after FA

| id | source | fix |
|---|---|---|
| FB-1 | logic-w1 F-001, UX-001, RR-001, degradation-w1 F-002 (major, verified) | Focus carries `{ repo, repositoryId?, number, intent?, nonce }`; Reviews tab selects that repository first, then matches repo + number. |
| FB-2 | frontend-w1 F-001 (major, verified) + verifier note | An intent (answer/view/start) is consumed once: clear it from `selected` after the workspace takes it; returning to the tab never replays it. Red probe in `raw/review-verifier-w1.txt`. |
| FB-3 | frontend-w1 F-002 (major, verified), logic-w2 F-003 | App clears `reviewsFocus` once handled (`onFocusHandled(nonce)`); a remount (repo/account switch) or access-lost retry never replays it; `accessLost` clears the pending request. |
| FB-4 | RR-002 (major, verified), highload-w1 F-001, perf-w1 F-001, frontend-w1 F-004 | Reviews indicator stays current while the tab is hidden: reload on `subscribeSessionReview` events and on the PR watcher's poll completion (shared signal from App), and on the 60 s timer while anything is queued/running — skip when `document.visibilityState === "hidden"`. Mount `ReviewsView` only after the account read settled (no double read). Fix the App.tsx comment. Red probe in `raw/review-verifier-w2.txt`. |
| FB-5 | degradation-w1 F-001 (major, verified, UI half) | Archived Reviews appear under "Show closed" (labelled Archived); the panel's History reaches Restore/Delete; PR panel `hasReview` counts archived runs so "Open in Reviews" is offered. |
| FB-6 | logic-w2 F-001 (major, verified) | Use the summary's `reviewed` (FA-3) for the reviewed commit on cards, list and panel; drop the Desktop-side `latestReviewed` guess. |
| FB-7 | arch-w1 F-001, F-002, F-003 | `ReviewsTabIndicator` declared in `reviews/`, imported by the shell; `onOpenInReviews` fallback routes only `start`; drop the unused `onOpenReviewSession` on `ReviewDetail` (and ReviewBoard's pass-through). |
| FB-8 | UX-002, UX-003, UX-004 / frontend-w1 F-003, UX-005, UX-007, UX-008 | Run-status error banner next to the header action; Rounds link accessible name contains its visible text; card button keeps its content in the accessible name (no overriding aria-label) — update the four tests that select by it (frontend-w2 F-002); outdated action label "New review round" everywhere including `launchAction`; missing-card banner gets a Refresh button and Reviews-tab wording. |
| FB-9 | LY-001, LY-002 | `.review-workspace-block` keeps the panel's 12 px column gap; selects show their full selected text (title attribute or wider min) at ≤760 px. |
| FB-10 | degradation-w1 F-004 | Review rules reachable when the list read fails: use the identity from the last successful read or from the PR board (App passes it). |
| FB-11 | logic-w2 F-002 | Digit-only search matches title too, and number anywhere (same as the PR board). |
| FB-12 | testing-w1 F-001..F-005, frontend-w2 F-001, logic-w3 F-001, testing-w1 F-006 | Round cell assertion that can fail; both sides of intent routing; App handoff test; list re-read after a panel action; focus returns to search after an account change in Reviews; `reviewDot` selector `:not(.reviews-tab-dot)`; fix the stale `not.toContain("start")` assertion; indentation. |

Every fix ships with a test that fails before it (red probe) and passes after. Mutation-check the attention-set rule is unchanged: `ReviewBoard.tsx` attention-set code must not be edited.
