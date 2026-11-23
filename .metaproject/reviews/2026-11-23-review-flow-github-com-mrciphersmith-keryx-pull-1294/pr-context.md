# Pull request context: MrCipherSmith/keryx#1294

Head 53c96b8af161a9aa7550f6d8f7c2ed739baaf110, collection round 1, collected 2026-11-23T09:42:28.105Z.

## Intent (round 1)

**fix(desktop-review): PR board fixes without model change (Review v2 stage 0)**

## What

Stage 0 of [Desktop Review v2](docs/requirements/keryx-desktop-review-v2/README.md): fixes to the Pull requests board that need no data-model change. Flow 516.

- **Filters have no exceptions.** A pull request with an active Keryx review no longer bypasses every filter except search.
- **Stable order.** Active reviews are no longer sorted first, so cards do not reorder on review events.
- **Done lane on demand.** It is drawn only when the state filter can yield closed or merged pull requests.
- **Tab indicator means "addressed to me".** Lit by a review request to the viewer's login, changes requested on the viewer's own pull request, unread replies to the viewer, or a local review waiting on the viewer. Team review requests are not matched yet.
- **Outdated review stays on the card.** After the author pushes, the card shows `Outdated review · <sha>` and a "Review changes" action instead of looking unreviewed. When only the base moved it reads `Review predates base update · <sha>`. Backed by a new optional badge field `localReview.outdated`; the badge SQL returns at most one extra row per card.
- **Toolbar on one row.** Labels collapse to icons when the board is narrow; the Review rules and PR watcher dialogs are portaled to the document body.

Also adds the requirements package `docs/requirements/keryx-desktop-review-v2/` (PRD, specification, implementation plan for stages 0-4) and the flow and review-round packages.

## Verification

- `cd apps/desktop && bun test src` - 752 pass
- `bun test src/review/board*.test.ts src/review/desk-run*.test.ts` - pass
- `bunx tsc --noEmit` in `apps/desktop` and root `bun run typecheck` - clean
- Live in the browser dev build: toolbar on one row at 820, 1080 and 1380 px; PR watcher dialog scrim covers the whole window

## Not verified

- Rust (`apps/desktop/src-tauri`) was not compiled locally; no Rust files changed. `review_board` passes the card as untyped JSON, so the new field is not dropped.
- With real board data in a running app: a card with an outdated review, the Review rules dialog, the open detail panel.
- The review round in `.metaproject/reviews/2026-11-23-review-flow-feat-desktop-review-v2-stage0` is incomplete: five of eleven planned reviewers ran by operator decision; verifier, premise and mutation passes did not run. Its six findings are fixed in `985f8ecbc`; no second round ran on that commit.

## Behaviour change to note

A merged or closed pull request with a review still running is hidden under the default Open + Draft filter (operator decision, recorded in the flow journal).

## CI: pending

- standard-pr: passing
- vscode-extension: passing
- client matrix (terminal): passing
- deploy to GitHub Pages: skipped
- macOS real-host legs — OS sandbox + TUI pty launch: pending
- client matrix (streaming): passing
- AC8 remaining tests: pending
- Core tests (4/4, offline): passing
- opentui native (linux-arm64): passing
- opentui native (darwin-x64): passing
- client matrix (cancel-resume): passing
- Core tests (3/4, offline): passing
- Issues board, Projects and session-to-Flow acceptance: passing
- Desktop Metaproject graph and wiki acceptance: passing
- Core tests (1/4, offline): pending
- client matrix (runtime): passing
- standard-baseline: passing
- dependency-audit: passing
- metrics-contract: passing
- Lint and typecheck: passing
- linux sandbox (bubblewrap) live smoke: passing
- opentui native (linux-x64): passing
- Core tests (2/4, offline): pending
- opentui native (darwin-arm64): passing
- desktop check: passing
- mkdocs build --strict: passing
- team-hub-distribution: passing
- wiki validate (gate) + freshness (report): passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

