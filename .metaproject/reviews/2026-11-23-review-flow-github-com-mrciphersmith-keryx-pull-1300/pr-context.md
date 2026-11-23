# Pull request context: MrCipherSmith/keryx#1300

Head 6a2a3031f740833e60b82856a9a266b5ffab5e10, collection round 1, collected 2026-11-23T20:58:19.877Z.

## Intent (round 1)

**feat(desktop): Review v2 stage 1 — GitHub slice and Keryx links**

Desktop Review v2, stage 1 "GitHub slice and links" (Flow 517). Requirements: `docs/requirements/keryx-desktop-review-v2/` — PRD R1–R3, R5, R6, parts of R4 and R7; decisions D5 and D6. Stage 0 was #1294.

## What changes

- **Pull requests board, GitHub only (R1, R2, D6).** Lanes and order no longer read the local review. Two groupings:
  - "Status" (default): Draft · Waiting for review · Changes requested · Approved. Merged and Closed appear only when the state filter includes them.
  - "My role": Requested from me · Mine · Others.

  Quick filters "Requested from me", "Mine" and "CI failed" sit in the context row, not the toolbar. Lanes the filters rule out are not drawn. Cards are sorted by `updatedAt`, newest first. The attention lane and the "In review" lane are gone, and the card's reason line is built from GitHub data only.
- **Keryx work row on every PR card and list row (R4 part, R7 part).** A fixed 24px row with three slots:
  - Review: `Review · <state>`, from `localReview`, with no round number and no behind count. It opens the current review panel.
  - Flow: `Flow #id · stage`. A Flow counts if its `prUrl` matches or if it is linked to a session bound to the PR.
  - Session: the count of bound sessions. It opens the newest; a menu lists all of them plus "New session".

  An empty slot shows a labelled action instead: "Run review", "Create Flow" or "Open in session". Every card action now has visible text. "Fix review comments" is not included; it is stage 4.
- **Sessions bound to a Subject (R5).** A new `subject` field in the session's `flags.json`, written through `_keryx/session_flags`, records `{kind, repo, number, url}`. Issue sessions get it when `withIssueBinding` binds them.
  - "Open in session" on a PR reopens the newest bound session, or creates one, binds it and prefills the composer with the PR URL without sending.
  - On an older keryx that ignores `subject`, the session still opens, with a notice that the binding was not saved.
  - The session header links back to the PR or Issue and to its Flow.
- **Work from a bound session (R6).**
  - `/review` with no target in a PR-bound session preselects that PR. The started run shows on the card without a refresh.
  - "Create Flow" opens the bound session with a flow prompt. The single new flow package that appears while that request is pending gets linked to the session.
- **Issues (R3, D5).**
  - Default grouping is by GitHub state: Open, plus Closed when the filter includes closed issues.
  - The default source is the project repository: `keryx issues list` with `source: "repository"` reads `/repos/{owner}/{repo}/issues`. "Assigned to me" and the other sources stay selectable, and a stored choice wins.
  - The Flow stage filter is removed; the stage now shows in the card's work row.

No Rust changes.

## Verification

- `cd apps/desktop && bunx tsc --noEmit`: clean.
- `cd apps/desktop && bun test src`: 1016 pass, 0 fail.
- Root `bunx tsc --noEmit -p .`: clean.
- Root focused suites (`desk-run-store`, `board-badges`, `session/organize`, `shell-session-organize`, `session/issues`, `issues-board`): 67 pass, 0 fail.
- Scenario "PR without Flow and review → Open in session → `/review` → review link on the card" is one integrated App-level test in `ProjectNavigation.dom.test.tsx`. Four product mutations each break it: the preselect, the publish, session reuse and the binding.
- The stage 0 attention set (`carriedAttention`, `seeded`, `seedFor`, `attentionPrs`, `stale`) is unchanged. The one adjacent edited line, the `visible` memo, was mutation-checked.
- The toolbar is unchanged, so the stage 0 measurements still hold.

Not verified:
- No run in the real app with real GitHub data.
- Not checked: the work row in narrow lanes, the session menu placement, the list width (now 1000px).
- Not run: lint, and the Rust CI path.

## Known gaps and choices for the owner

- Deviation (a), team review requests for the tab indicator, stays open: this stage adds no team membership. Deviation (b) is unchanged.
- An Issue has no "another or new session" choice. The issue binding backend keeps one session per issue and account.
- A Flow created outside the pending "Create Flow" window is not linked to the PR until it has a `prUrl`.
- UI choices taken without an owner decision, listed in the flow journal:
  - review slot state words;
  - a disabled "Run review" on a merged or closed PR;
  - the session menu button reads "More";
  - an unsaved new session shows as "not saved yet";
  - "Create Flow" replaces the composer draft;
  - Issue card buttons became work-row links.

Flow package: `.metaproject/flows/517-2026-11-23-desktop-review-v2-stage-1-github-slice-a/`. Still to do: a review-orchestrator round on this PR, and the merge decision.


## CI: pending

- standard-pr: passing
- Core tests (4/4, offline): pending
- dependency-audit: passing
- linux sandbox (bubblewrap) live smoke: pending
- deploy to GitHub Pages: skipped
- Core tests (1/4, offline): pending
- opentui native (darwin-x64): pending
- opentui native (linux-arm64): pending
- client matrix (cancel-resume): pending
- client matrix (runtime): pending
- team-hub-distribution: pending
- Core tests (2/4, offline): pending
- Core tests (3/4, offline): pending
- AC8 remaining tests: pending
- client matrix (streaming): passing
- opentui native (linux-x64): pending
- standard-baseline: passing
- Desktop Metaproject graph and wiki acceptance: passing
- metrics-contract: passing
- Issues board, Projects and session-to-Flow acceptance: passing
- client matrix (terminal): pending
- vscode-extension: passing
- Lint and typecheck: pending
- wiki validate (gate) + freshness (report): passing
- mkdocs build --strict: passing
- opentui native (darwin-arm64): pending
- macOS real-host legs — OS sandbox + TUI pty launch: pending
- desktop check: pending

## Backend pins

_The pull request names none._

## Review comments (0, full text)

