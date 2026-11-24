# Review publish: session path vs Desktop path (divergence map, 521-T6)

Read at HEAD 6638ea2b6 (base origin/main a5d1ab236). Line numbers are from that tree, not from 1b994df18.
Stages 2 and 3 are NOT in this tree: `runs` has no `review_id`/`round`, there is no `reviews` table, `DeskRun.source`
is `"manual" | "scheduled" | "existing"` (`src/review/desk-run-types.ts:122`), and `keryx review advance` does not exist.

## 1. Entry points

| surface | command | chain (file:line) |
|---|---|---|
| terminal | `keryx review publish <id> [--event] [--partial] [--yes]` | `src/commands/review.ts:858` → `runPublish` `:5026` → `publishReview` `src/review/publish.ts:147` → `githubPostReview` `src/flow/tracker/github.ts:140` (`gh pr review --body-file -`) |
| keryx shell card | tool `review_publish` | `src/commands/operator-confirm-review.ts:183` `publishSpec`: `buildCard` dry-runs `publishReview` with a declining `confirm` (`:210-219`); `apply` re-runs it and posts only if body+target equal what the card showed (`:245-259`) |
| keryx shell guard | raw `gh pr review` / `gh api .../reviews` | `src/commands/agent.ts:6010` → `reviewPublishRefusal` `src/review/publish-guard.ts:112` (refuses only when the bound package is NOT READY; text match, not a boundary) |
| unattended | — | `review_publish` is an operator-confirm tool (`src/trigger/unattended.ts:66`): recorded Not run |
| Desktop UI | dialog → Tauri `review_publish` | `apps/desktop/src/review/ReviewPublishDialog.tsx:11-12` → `apps/desktop/src-tauri/src/review.rs:462` → `publication_args` `:388-411` (`review desk-publish --json ...`) + request temp file `:413` + PTY that types `publish` `:425-454` |
| CLI (Desktop wire) | `keryx review desk-publish --json --repo --repository-id --viewer --number --request-file` | `src/commands/review.ts:802` → `runReviewDeskPublish` `src/commands/review-desk-publish.ts:121` → `requestDeskPublication` `src/review/desk-publication.ts:271` → `publication` `:283` → `prepare` `:87`; POST via `callGitHub` `:372` |
| Desktop auto-publish | rule run with `autoPublish` | `publishCompletedDeskReview` `desk-publication.ts:276` (kind `automatic`, verdict comment) |

## 2. Divergence by concern

| concern | session (`review publish` / card) | Desktop (`desk-publish`) |
|---|---|---|
| package location / key | any package resolved by id or path, `.metaproject/reviews/<id>` (`review.ts:5035`); key = `manifest.target.ref` | Attempt dir `<keryxDataDir>/desktop-review/<uuid>/package` via `DeskRunStore.directory` (`desk-publication.ts:289-290`); key = `{repo, repositoryId, number, viewer}`; manifest must match run base/head (`:94-98`) |
| who may publish | any PR-bound manifest (`publish.ts:150`) | Attempt must be reviewed, `source !== "existing"`, state completed/partial, key and SHAs match (`desk-publication.ts:296-304`) — so session packages imported as `existing` cannot go this way (O14) |
| body source / rendering | `report.md` through `publicProjectReport` (`publish.ts:161`) + partial header `:46-53` + unattended header `:56-60` + minors section `:83-103` + run-mode footer `:106-109` | `renderDeskReviewReport` from verdict/premise records + `applyReviewOverlay` (`desk-publication.ts:219-228`); report.md used only for metadata/evidence/slots (`:137`, `:204`, `:223`); inline comments on diff hunks (`:170-195`); English-only check `:264-269` |
| round block | `buildRoundBlock` over `findings.json`, reviewedHead = `manifest.target.head` (`publish.ts:167-170`) | same `buildRoundBlock` over in-body findings, reviewedHead = `run.headSha` (`desk-publication.ts:230-232`) |
| body limit | minors cut to `PUBLISHED_BODY_LIMIT - head - foot - ROUND_BLOCK_LIMIT` (`publish.ts:165`); no final length check | refuses `body.length > PUBLISHED_BODY_LIMIT`, >100 inline comments (`desk-publication.ts:252-253`) |
| event / verdict | operator flag `--event`, default COMMENT (`publish.ts:38-43`, `:153`) | settings verdict approve/suggestions/changes/comment → event map (`desk-publication.ts:25-27`); auto-recommended by `deskReportRecommendation` (`:160`) unless overridden |
| readiness / acceptance | `computeReadiness`; any failing item → refuse unless `--partial` (`publish.ts:154-157`) | `computeReadiness` + `run.result.coverage === "complete"` (`desk-publication.ts:149-152`); failing → posted with "Partial review" coverage note, no flag needed (`:206-208`); premise questions must all be answered (`:244`) |
| partial + APPROVE | refused (`publish.ts:158-160`) | refused (`desk-publication.ts:250`) |
| head moved / PR closed | readiness item 7 `head` via `completeHeadGate` with `prLookup` (`src/review/readiness.ts:362-371`): passes with a warning when report's first line names the reviewed SHA; skipped when no tracker | `current = OPEN && base==run.base && head==run.head` (`desk-publication.ts:307`) → blocked (`:242`, O8); re-verified right before POST `verifyDeskSubject` (`:341`) |
| duplicate detection | none: re-running posts again (O15) | `publication-receipt.json` written `{}` before POST (`:353`), `{url}` after (`:391`); `<!-- keryx-desktop-review <attempt-uuid> -->` appended to body (`:233-234`); `findPreviousPublication` scans PR reviews by viewer for that marker when receipt has no url (`:67-76`, `:235`); unknown-result receipt blocks (`:241`) |
| stale preview / concurrency | card `apply` refuses if body/target changed since card (`operator-confirm-review.ts:255-261`) | `withFileLock(publication.lock)` (`:314`); submit digest must equal fresh digest (`:331`); discussion hash re-read (`:347-349`) |
| security screen | card refuses hidden/control chars (`operator-confirm-review.ts:220-221`) | `screenCommentBody` on body and every inline comment (`desk-publication.ts:335-339`) |
| GitHub identity | ambient `gh` (`github.ts:144`) | project GitHub binding / named viewer env (`desk-publication.ts:288`, `:343-346`), `gh api POST .../reviews` with `commit_id` (`:334`, `:357-372`) |
| operator confirmation | terminal: body printed + `[y/N]` or `--yes` (TTY-only) (`review.ts:5036-5055`); shell: card shows whole body (`operator-confirm-review.ts:225-236`), `confirmedVia` recorded | Tauri native dialog (`review.rs:486-495`) then PTY answers `publish`; CLI requires `stdin.isTTY` for submit (`review-desk-publish.ts:153`) and the typed word `publish` (`:102-119`) |
| errors / exit codes | throws plain `Error` (exit via CLI error path); declined → prints "review not published", `exitCode = 1` (`review.ts:5066-5069`); GitHub refusal → `GitHub refused the review: <detail>` (`publish.ts:173`) | prefixed `configuration:`/`permission:`/`access:`/`stale:`/`unavailable:` errors (`desk-publication.ts:286`, `:303`, `:331-333`, `:377-385`); receipt removed only when the POST certainly did not land (`:374-375`); JSON state on stdout (`review-desk-publish.ts:156-158`) |
| written to disk | `<pkg>/published.json` {pr, reviewId, head, round, event, partial, failing, time, confirmedVia, card press} (`publish.ts:174-177`); local round registry `recordFinishedRound` (`:179`) | Attempt dir (mode 0600): `publication-draft.json` (`:325`), `publication-receipt.json` (`:353`, `:391`), `publication-skipped.json` (`:318`), `publication-preview-cache.json` (`:199`); no `published.json`, no round registry entry |
| outcome read by | — | `DeskRunStore.publication` derives published/skipped/pending from receipt/skipped files (`src/review/desk-run-store.ts:325-334`) |
| draft / skip / preview | none | kinds preview/save/skip/submit (`desk-publication-types.ts:17-21`); skip refused under tool-call/unattended env (`review-desk-publish.ts:150-152`) |

## 3. Already shared

- `buildRoundBlock`, `PUBLISHED_BODY_LIMIT`, `ReviewEvent` from `publish.ts` (import `desk-publication.ts:17`); `renderRoundBlock` from `pr-comments`.
- `computeReadiness` / `failingItems` (`readiness.ts`), `computeVerdict` (`verdict.ts`), `readRoundNumber` (`round-record.ts`).
- Nothing else: receipt, marker, lock, subject verification, screening and the POST transport are Desktop-only.

## 4. Extraction plan (smallest sequence)

| # | change | needs stage | tests |
|---|---|---|---|
| 1 | Extract a `publicationGuard` module from `desk-publication.ts`: `publicationMarker(id)`, `findPreviousPublication`, receipt write-intent/confirm/rollback (`:351-391`), lock. Pure move, Desktop behaviour unchanged. | none | existing `src/review/desk-publication.test.ts` (all), new unit tests for the module |
| 2 | Give a session package a stable publication id + directory: use `manifest.reviewId` (+ round) as the marker key and the package dir as the receipt dir (`<pkg>/publication-receipt.json`). Marker text must be one format both paths emit, e.g. `<!-- keryx-review <key> -->`; Desktop keeps also recognising the old `keryx-desktop-review <uuid>` marker. | none (current run model); final key choice depends on stage 2 Attempt ids | new: marker round-trip; old-marker recognition |
| 3 | In `publishReview` (`publish.ts:171-179`): take the lock, refuse when a receipt has a URL or an unknown result, else search PR reviews for the marker; append the marker; write `{}` before `options.post`, `{url}` after; on certain refusal remove it. `post` must return the review id/URL: `githubPostReview` (`gh pr review`) returns none, so switch the session POST to the `gh api .../reviews` port or look the review up by marker after posting. | none | extend `src/review/publish.test.ts`: second publish of same package refused; lost-response receipt blocks; refused POST leaves it retryable; `src/commands/operator-confirm-review-tools.test.ts`: card `buildCard` shows "already published" refusal |
| 4 | Shared acceptance: route session publish through the same head/closed check as Desktop (`verifyDeskSubject` equivalent keyed by `manifest.target`) and `screenCommentBody`. Keep `--partial` as the session's explicit opt-in (Desktop's coverage note stays). Keep D1 out: moved head refuses for now. | none for refusal; "publish as-is for `<sha>`" variant = stage 3 (D1) | `publish.test.ts`: moved head / closed PR refused; `src/commands/review-tty-refusal.test.ts` unchanged |
| 5 | Confirmation stays per surface: terminal `[y/N]`/`--yes` (TTY), shell card (`confirmedVia`), Desktop native dialog + PTY. No change to `review.rs`. | none | existing TTY/card tests |
| 6 | Cross-path duplicate: session package registered as Attempt with source `session` so `desk-publish` can address it (`desk-publication.ts:296` now rejects anything not in `DeskRunStore`, and `existing`). | **stage 2** | new: publish package via `review publish`, then `desk-publish` submit of the same Attempt → refused "already published" (receipt or marker); and the reverse order |
| 7 | Moved-head options (`desk-publish` returns variants, `on_head_move`, `review advance`) applied to the shared guard. | **stage 3** | stage 3's own tests; re-run 1–6 |

Without stage 2, the cross-path test in row 6 can only be approximated: same PR, Desktop-posted review carrying the shared
marker, then `review publish` of a package with the same key finds it via the marker scan (`findPreviousPublication`).

## 5. Risks and overlap with stage 3

- Stage 3 rewrites the same lines: `blockedReason` chain (`desk-publication.ts:240-254`), the `current` check (`:307`, `:341`) and the `desk-publish` return shape. Doing step 1 (pure extraction) before stage 3 merges guarantees a conflict; do it after, or agree the module boundary first.
- Plan order (implementation-plan.md: "Этап 4 требует этапов 2 и 3") is violated if stage 4 lands now; steps 1–5 are doable on the current model, 6–7 are not.
- Marker key: Desktop marker is the Attempt uuid; a session package has only `reviewId`. Choosing a key before stage 2 defines Attempt ids for session packages risks a second marker migration.
- Session path today posts as ambient `gh` user; Desktop matches marker by `viewer` login (`:73`). A session publish under another account would not be seen as a duplicate.
- Changing the session POST transport (`gh pr review` → `gh api`) changes failure text and the `PostResult` seam used by `src/review/publish.test.ts` and card tests.
- Head semantics differ: session allows a moved head when the report's first line names the reviewed SHA (readiness item 7); Desktop refuses. Unifying to refusal breaks a currently allowed session flow until stage 3's D1 variant exists.
- `published.json` + round registry (session) vs receipt (Desktop) are two records; `DeskRunStore.publication` reads only the receipt.
