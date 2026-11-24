# Pull request context: MrCipherSmith/keryx#1300

Head d7b0f7058e919a5880319588ad95395b7ff66153, collection round 1, collected 2026-11-24T06:45:45.106Z.

## Intent (round 1)

**feat(desktop): Review v2 stage 1 — GitHub slice and Keryx links**

Desktop Review v2, stage 1 "GitHub slice and links" (Flow 517): the Pull requests and Issues boards group by GitHub data only, every card gets a Keryx work row, and sessions can be bound to a PR or Issue. Two review rounds are done and their findings fixed; owner choices and known gaps are listed below. Requirements: `docs/requirements/keryx-desktop-review-v2/` (PRD R1–R3, R5, R6, parts of R4 and R7; decisions D5, D6). Stage 0 was #1294. Current state and deviations: section "Состояние этапа 1" of `implementation-plan.md`.

## What changes

- **Pull requests board, GitHub only (R1, R2, D6).** Groupings "Status" (default: Draft · Waiting for review · Changes requested · Approved; Merged and Closed only when the state filter includes them) and "My role" (Requested from me · Mine · Others). Quick filters "Requested from me", "Mine", "CI failed" sit in the context row, so the stage 0 toolbar measurements still hold. The attention and "In review" lanes are gone; the reason line uses GitHub data only.
- **Keryx work row (R4 part, R7 part).** A fixed 24px row on every PR card and list row with Review (`Review · <state>` from `localReview`, no round or behind count), Flow (by `prUrl` or a bound session's `flow` flag) and Session slots (count, newest, menu with all and "New session"). An empty slot shows its labelled action. "Fix review comments" is stage 4.
- **Sessions bound to a Subject (R5).** `subject` `{kind, repo, number, url, repositoryId?}` in the session's `flags.json`, written through `_keryx/session_flags` under a per-session `flags.json.lock`. "Open in session" reopens the newest bound session or creates and binds one, prefilling the PR URL without sending. The session header links to the PR or Issue and its Flow. Issue sessions get `subject` from `withIssueBinding`; sessions an older keryx bound without one are backfilled on the next open unless the person unlinked it.
- **Older keryx.** keryx stores a new session only after its first turn, so the notice "binding was not saved" appears after that turn at the latest; the session keeps working.
- **Work from a bound session (R6).** `/review` with no target preselects the bound PR. "Create Flow" opens the bound session with a prefilled flow prompt. When exactly one new flow package appears within 15 minutes while exactly one request with a filled prompt is pending, the PR work row asks "Link Flow #N?" with Link and Dismiss. Only Link writes the session's `flow` flag; Dismiss, several new packages or several pending requests link nothing (AC9 as re-frozen in round 2).
- **Issues (R3, D5).** Default source "Project repository" (`keryx issues list` with `source: "repository"`, `/repos/{owner}/{repo}/issues`, pull requests dropped, up to 3 pages per load); a stored choice wins. Lanes Open · Closed by GitHub state. The Flow stage filter is gone; the work row has Flow and Session slots ("Open in session"). If the default source is unavailable (no GitHub.com remote, Issues turned off → 410, or an older keryx), the board shows the reason and "Show issues assigned to me", plus an update hint for an older keryx.

No Rust changes. User docs: `docs/docs/guides/desktop-issues.md`, `docs/docs/cli-reference.md` (`issues`).

## Verification

At head (after fix round 2):

- `cd apps/desktop && bunx tsc --noEmit`: clean. `bun test src`: 1051 pass, 0 fail.
- Root `bunx tsc --noEmit -p .`: clean. Root focused suites: 44 pass, 0 fail.
- The scenario "PR without Flow and review → Open in session → `/review` → review link on the card" is an App-level test; named mutants from both review rounds are red.
- Stage 0 attention set: no lines edited in either fix round.

Not verified: no run in the real app with real GitHub data; work row in narrow lanes, session menu placement, list width (1000px) and the LY-002/LY-004 widths not measured; lint and the Rust CI path not run locally.

## Review

- Round 1 (head 6a2a3031f): 32 findings (2 blocker, 6 major); fixed in a34d8961b.
- Round 2 (head 88e3faba9): 44 findings (1 blocker, 3 major); HL-001 decided by the owner (confirmed link instead of a silent one); fixed in 80ef58bd5 and c4e8e3e24.
- Packages: `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1300` and `…-pull-1300-r02`. Decisions: the Flow 517 journal.

## Choices for the owner

Taken by the orchestrator during the fix rounds; each can be reverted:

- Create Flow waits 15 minutes from the press, not "until the next turn".
- A shown "Link Flow #N?" does not expire; Dismiss also stops offering that package.
- A session switch while "Open in session" runs leaves no prompt and no pending request; a repeat press during an open reuses it without a prompt.
- New PR sessions also count a Flow found through a bound session; the launch dialog preselects the newest of several Flows.
- Review progress shows only in the slot title; the "Transcript updated" stamp left the card.
- A header link to a PR of another repository shows a banner and stays armed until that repository is shown.
- Warn tone for "needs answer" and "publication pending"; a merged PR keeps the "publication pending" text without the warn tone.
- "Show issues assigned to me" appears only for the default (not yet chosen) source.
- Issues load up to 3 GitHub pages when a page holds only pull requests.
- A flags write waits up to 3 s for the lock, then fails with "retry".
- Subject backfill can re-link once a session unlinked before this version (no unlink marker then).
- Earlier UI choices: review slot state words; disabled "Run review" on merged or closed PRs; session menu button "More"; "not saved yet" for an unsaved session; "Create Flow" replaces the composer draft; Issue card buttons became work-row links.

## Known gaps

- Deviation (a), team review requests for the tab indicator, stays open; (b) is unchanged until stage 2.
- An Issue has no "another or new session" choice: the binding backend keeps one session per issue and account.
- A Flow created outside the Create Flow window, or with two or more requests pending, is not offered; it shows on the PR once it has a `prUrl`.
- `subject` names no GitHub account, so issue sessions bound under different accounts count together. GitHub Enterprise issues get no `subject`.
- Deferred info findings: PF-006/HW2-002, AR-002, AR-004..006, PF-002, LG-004, LY-002/LY-004, UX-003..006 (round 2 package).

Flow package: `.metaproject/flows/517-2026-11-23-desktop-review-v2-stage-1-github-slice-a/`. Still to do: the merge decision.


## CI: passing

- AC8 full suite (5000 ms, preload): passing
- typecheck-and-tests: passing
- standard-pr: passing
- AC8 remaining tests: passing
- opentui native (darwin-x64): passing
- deploy to GitHub Pages: skipped
- opentui native (linux-x64): passing
- Core tests (4/4, offline): passing
- Core tests (2/4, offline): passing
- client matrix (streaming): passing
- Core tests (1/4, offline): passing
- opentui native (linux-arm64): passing
- opentui native (darwin-arm64): passing
- mkdocs build --strict: passing
- team-hub-distribution: passing
- vscode-extension: passing
- Core tests (3/4, offline): passing
- client matrix (cancel-resume): passing
- client matrix (runtime): passing
- metrics-contract: passing
- macOS real-host legs — OS sandbox + TUI pty launch: passing
- client matrix (terminal): passing
- linux sandbox (bubblewrap) live smoke: passing
- dependency-audit: passing
- standard-baseline: passing
- Lint and typecheck: passing
- Issues board, Projects and session-to-Flow acceptance: passing
- wiki validate (gate) + freshness (report): passing
- Desktop Metaproject graph and wiki acceptance: passing
- desktop check: passing

## Backend pins

- pull `#1294` (pull request body): Desktop Review v2, stage 1 "GitHub slice and links" (Flow 517): the Pull requests and Issues boards group by GitHub data only, every card gets a Keryx work row, and sessions can be bound to a PR or Issue. Two review rounds are done and their findings fixed; owner choices and known gaps are listed be

## Review comments (0, full text)

