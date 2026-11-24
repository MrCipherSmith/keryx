# Pull request context: MrCipherSmith/keryx#1302

Head 0c6ff2b7e6e4118287ef8abd531e7268980435e8, collection round 1, collected 2026-11-24T08:02:41.901Z.

## Intent (round 1)

**feat(review): Desktop Review v2 stage 4 — Head moved procedure (shared publish and update command pending stages 2–3)**

Flow 521 · Desktop Review v2 stage 4 (`docs/requirements/keryx-desktop-review-v2/implementation-plan.md` v0.1.3, row 4 "Единый реестр"). Draft: only the parts that do not depend on stages 2 and 3 are in.

## Done here

1. **"Head moved" procedure in `review-orchestrator`.** New section `## Head moved` in `SKILL.detail.md`:
   - The PR head is checked at every wave boundary (before each `keryx review next`), before `review complete`, and before publishing. N new commits are counted, and rewritten history is detected.
   - `on_head_move` defaults to `ask` (D2), with two operator choices. `follow`, `ignore` and the unattended behaviour are also covered.
   - The update round runs through `keryx review advance`. While that command does not exist, it falls back to `keryx review plan --head <new sha>`.
   - Before publishing a moved PR, the options are: update, publish as is, save locally, skip. Publishing the old commit as is is allowed only as `--event COMMENT`, with a first line that names the reviewed commit (D1).

   In `SKILL.md`, Round plan step 5 and the end of "PR Review Report Publication" point to the procedure, and "If head moved, re-check findings" is gone. Its line count stays at the 918-line ceiling. The bundled and installed copies are byte-identical. Tests: a new block in `src/gdskills/review-orchestrator-preflight.test.ts`.
2. **Divergence map.** `.metaproject/flows/521-…/divergence-map.md` maps the session `review publish` path against the Desktop `desk-publish` path: entry points, 18 points of divergence with file:line, what is already shared, and a 7-step extraction plan marked by the stage each step needs.

## Waiting on stages 2 and 3 (not in this PR yet)

- **Item 2, shared publish code (T7).** `review publish` would use the acceptance, receipt and duplicate marker from `desk-publication`. Two reasons to wait:
  - Extracting now would rewrite the same lines of `desk-publication.ts` that stage 3 changes (`blockedReason`, the `current` check, the return shape of `desk-publish`).
  - The cross-path duplicate test needs session packages registered as Attempts, which is stage 2.
- **Item 3, the session uses the same update command (T8).** `keryx review advance` comes with stage 3. The Desktop prompt line "New commits belong to a separate request" (`src/review/autonomous-profile.ts:199`) is replaced then.

When stage 3 is pushed (on top of stage 2), this branch is rebased onto it and T7/T8 are implemented. Nothing is merged into or pushed to those branches.

## Expected overlap

- Stage 3 may also edit `review-orchestrator` (publish variants). If it names the update command something other than `keryx review advance`, the procedure here gets a follow-up edit.
- Stage 2 and stage 3 own `desk-run-store.ts`, `desk-publication.ts`, `review-desk-publish.ts` and `ReviewPublishDialog.tsx`. This PR does not touch them.

## Not verified

- Lint and type-check did not run locally: the worktree has no `node_modules`. CI is the check.
- `bun test src/gdskills`: 8470 pass, 1 fail in `install.test.ts` (EACCES on a read-only `rules/core` in a temp dir). That test is outside the changed files and was not confirmed on the base commit.
- The real-PR scenario (review in a session, publish from Desktop) was not run. It needs items 2 and 3.
- The procedure describes the spec contract. The current `keryx review plan` fallback may not yet treat a partial package as the prior round (`round-record.ts:207`), which is stage 3's change.


## CI: pending

- standard-pr: passing
- opentui native (linux-x64): pending
- deploy to GitHub Pages: skipped
- Core tests (1/4, offline): pending
- Core tests (4/4, offline): pending
- client matrix (terminal): pending
- opentui native (darwin-arm64): pending
- opentui native (linux-arm64): pending
- opentui native (darwin-x64): pending
- Issues board, Projects and session-to-Flow acceptance: passing
- Core tests (3/4, offline): pending
- macOS real-host legs — OS sandbox + TUI pty launch: pending
- wiki validate (gate) + freshness (report): passing
- AC8 remaining tests: pending
- client matrix (streaming): passing
- standard-baseline: passing
- dependency-audit: passing
- metrics-contract: passing
- client matrix (cancel-resume): pending
- linux sandbox (bubblewrap) live smoke: pending
- client matrix (runtime): pending
- Lint and typecheck: pending
- Desktop Metaproject graph and wiki acceptance: passing
- Core tests (2/4, offline): pending
- vscode-extension: passing
- team-hub-distribution: pending
- mkdocs build --strict: passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

