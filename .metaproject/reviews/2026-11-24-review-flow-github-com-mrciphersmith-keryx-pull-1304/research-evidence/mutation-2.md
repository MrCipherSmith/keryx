# Mutation pass

Command: `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` (baseline exit 0, 2603 ms). Run in a scratch copy; the worktree was not written.

Cost: provenance 700 ms, copy 24079 ms, mutants 62103 ms, load 8.8/8.7/11.3.

started 2026-11-24T10:53:22.660Z, head 20e4281a2ac0, treeHash e3b0c44298fc.

Killed 17, survived 12, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| M01 | apps/desktop/dev/reviewBoard.ts:4 | `  if (args.reviewsOnly === true) return reviewsArgs(args); ` → `` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M02 | apps/desktop/dev/reviewBoard.ts:54 | `args.cursor != null \|\| args.updatedSince != null)` → `args.cursor != null \|\| false)` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M03 | apps/desktop/src/review/model.ts:43 | `    unreadReplies > 0;` → `    unreadReplies > 0 \|\| !!c.localReview?.awaitingAnswer;` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M04 | apps/desktop/src/review/model.ts:43 | `    unreadReplies > 0;` → `    unreadReplies > 0 \|\| !!c.localReview?.publicationPending;` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M05 | apps/desktop/src/review/model.ts:43 | `    unreadReplies > 0;` → `    unreadReplies >= 0;` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M06 | apps/desktop/src/review/model.ts:103 | `  if (attention) return attention;   if (c.decision) return DECISION_LABEL[c.decision];` → `  if (attention) return attention;   { const note = reviewNote(c); if (note) return note; }   if (c.decision) return DECISION_LABEL[c.decision];` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M07 | apps/desktop/src/review/ReviewBoard.tsx:63 | ` && a?.outdated?.round === b?.outdated?.round` → `` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M08 | apps/desktop/src/review/ReviewBoard.tsx:456 | `if (kind !== "start" && onOpenInReviews) onOpenInReviews(card.number, reviewIntent);` → `if (onOpenInReviews) onOpenInReviews(card.number, reviewIntent);` | survived | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M09 | apps/desktop/src/review/ReviewDetail.tsx:175 | `reviewIntent?.kind === "start" ? reviewIntent : undefined` → `reviewIntent` | survived | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M10 | apps/desktop/src/review/ReviewDetail.tsx:181 | `const hasReview = local.runs.some(run => !reviewIsArchived(run));` → `const hasReview = local.runs.length > 0;` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M11 | apps/desktop/src/review/ReviewDetail.tsx:257 | `disabled={local.working \|\| !local.loaded \|\| action.open \|\| !!revisionChanged}` → `disabled={local.working \|\| !local.loaded \|\| !!revisionChanged}` | survived | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M12 | apps/desktop/src/review/ReviewDetail.tsx:196 | `if (local.error \|\| card.state !== "open" \|\| revisionChanged \|\|` → `if (local.error \|\| revisionChanged \|\|` | survived | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M13 | apps/desktop/src/review/ReviewResults.tsx:37 | `const outdated = label === "New review round" ? card.localReview?.outdated : undefined;` → `const outdated = card.localReview?.outdated;` | survived [presentation] | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M14 | apps/desktop/src/review/ReviewResults.tsx:38 | `${outdated.round ? 'Round ${outdated.round} reviewed' : "Reviewed"}` → `${"Reviewed"}` | killed [presentation] | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M15 | apps/desktop/src/reviews/model.ts:39 | `  if (state === "needs_answer") return "waiting"; ` → `` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M16 | apps/desktop/src/reviews/model.ts:40 | `  if (isBehind(review.freshness)) return "behind"; ` → `` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M17 | apps/desktop/src/reviews/model.ts:31 | `  return freshness.kind === "behind";` → `  return freshness.kind !== "current";` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M18 | apps/desktop/src/reviews/model.ts:49 | `return freshness.rewritten ? '${amount} · history rewritten' : amount;` → `return amount;` | survived [presentation] | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M19 | apps/desktop/src/reviews/model.ts:103 | `return String(review.number).startsWith(number);` → `return String(review.number) === number;` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M20 | apps/desktop/src/reviews/model.ts:109 | `    (showClosed \|\| review.state !== "closed") && ` → `` | survived | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M21 | apps/desktop/src/reviews/ReviewsView.tsx:122 | `    if (active && !wasActive.current) refresh(); ` → `` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M22 | apps/desktop/src/reviews/ReviewsView.tsx:129 | `    if (!active \|\| !running) return;` → `    if (!running) return;` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M23 | apps/desktop/src/reviews/ReviewsView.tsx:102 | `      if (identity.current && identity.current !== next) resetView(); ` → `` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M24 | apps/desktop/src/reviews/ReviewsView.tsx:165 | `      if (!filterReviewList([found], filters, q, true).length) {` → `      if (true) {` | survived | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M25 | apps/desktop/src/reviews/ReviewsView.tsx:175 | `      if (!read.error) setNotice(` → `      setNotice(` | survived | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M26 | apps/desktop/src/reviews/ReviewsView.tsx:185 | `    if (previous !== undefined && previous !== signature) refresh(); ` → `` | survived | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M27 | apps/desktop/src/reviews/ReviewsView.tsx:164 | `      if (found.state === "closed") setShowClosed(true); ` → `` | killed | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 1 |
| M28 | apps/desktop/src/App.tsx:217 | `    setView("reviews");   }, []);` → `  }, []);` | survived | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |
| M29 | apps/desktop/src/App.tsx:521 | `reviewsNotice?.binding === reviewViewer` → `true` | survived | `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` | 0 |

A survivor means no assertion pins that behaviour: the severity audit raises a finding to major only when no mutant in the same file was killed.
