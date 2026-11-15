# PRD: Keryx Desktop App
Version: 0.2.0

Status: draft; decisions D1–D5 taken. Quick start (R6–R8 and the quick-start half of R14) is implemented by flow 492, whose acceptance criteria are frozen in the flow; everything else here is still planned and its acceptance criteria are not frozen.

## 1. Problem

Keryx has strong engines (flows with frozen acceptance criteria, a review orchestrator, sandbox, policy) but a person who works alone meets them through a terminal or a Telegram bot. The Hub web covers a team: eleven tabs, token or Cloudflare SSO login, explicit choice of machine, working copy and agent profile, a Flow created from an imported spec. A live walk on 2026-11-14 showed what a solo user lacks:

- **No local entry.** A Hub must run somewhere and the user must hold a token or SSO. There is no "open the app and work" path.
- **Heavy task start.** A Flow needs a spec imported in Documents and acceptance criteria typed one per line. There is no light start for a bug or a small task, and no form that asks clarifying questions first.
- **No stage view.** Runs and sessions are lists. A person cannot see "plan, implement, checks, review, visual, accept" as one timeline with the agent log of each stage.
- **No diff and findings beside the code.** The Code tab lists revisions. The README of the web states that per-criterion evidence coverage is not available in the API, only counts. Reviewer findings are not shown next to the changed lines, and there is no visual QA screenshot view.
- **No desktop affordances.** No notification when a run needs a decision, no tray, no update channel.

PurpleFlow (Electron, over the claude and codex CLIs) shows the shape of that gap: planner, executor and reviewer stages, a worktree per run, a reviewed diff. Keryx already owns the deeper machinery. What is missing is the surface.

## 2. Goal

One installable desktop app where a single person starts a task in a few seconds, watches its stages, reads the diff with reviewer findings, and accepts or rejects, with no token, no SSO and no server to run. The same capabilities appear in the web for teams and in the TUI.

## 3. Users

- **Solo operator**: one person, one machine, a few working copies. Primary user.
- **Team member**: uses the same web views against a shared Hub. Gains quick start, timeline and diff without the desktop shell.
- **TUI user**: gets the same four capabilities through the shell, per the project rule that every function appears there.

## 4. Principles

- The desktop is a shell. Logic lives in the Hub backend (`src/hub`) and the web (`apps/hub-web`). Capabilities built for the desktop must work in a browser against a team Hub unchanged, except solo auth and the shell chrome.
- Solo auth never weakens team auth. The local Hub binds loopback only and its no-token login is unreachable from any non-loopback origin.
- No acceptance bypass. A Flow started by quick start still goes through frozen criteria, review and human acceptance. Quick start lowers the cost of writing them, it does not skip them.
- Claims need evidence. A timeline stage or a finding is shown only if a stored artifact backs it.

## 5. Requirements

Each requirement carries one verification field. Test paths marked "planned" do not exist yet and are listed in the specification.

### Direction 1: Solo mode and shell

- **R1. Local Hub as a child process.** The app starts `keryx serve` (Hub) as a supervised child on a loopback port, restarts it on crash with backoff, and stops it on quit with no orphan process. 
  Verification: exec `bun test src/desktop/hub-supervisor.test.ts` (planned)
- **R2. Login without token or SSO.** In solo mode the app obtains a session for the local Hub without the user entering a token. The mechanism is a one-time secret handed from the shell to the Hub child at spawn, exchanged for a session cookie. The Hub refuses this path for any request whose peer is not loopback, and when started without the solo flag. 
  Verification: exec `bun test src/hub/solo-auth.test.ts` (planned)
- **R3. Shell packaging.** A Tauri desktop shell (decision D1) opens the Hub web in a window, with the production assets already embedded in `src/hub/web-assets.generated.ts`. 
  Verification: exec `bun scripts/build-hub-web.ts --check` (exists) plus judged launch on Linux, macOS and Windows
- **R4. Notifications.** The app raises an OS notification when a run needs a decision (approval, clarifying question, review ready) and ignores events the user is already looking at. Clicking opens the exact run. 
  Verification: judged (live walk on each platform; unit test of the event filter planned)
- **R5. Tray and auto-update.** A tray item shows run state (idle, working, needs you). Updates are checked on a channel the operator controls, verified by signature, and never applied while a run is active without confirmation. 
  Verification: judged (signed update applied on a test build)

### Direction 2: Quick task start

- **R6. Modes.** A "New task" action offers quick, bug, task, epic and refactor. Each mode sets a default review depth and a default acceptance-criteria template. Modes are data, not code branches. 
  Verification: exec `bun test src/hub/work/quick-modes.test.ts` (planned)
- **R7. Start without a pre-imported spec.** Quick start creates a Flow with no spec document, carrying the typed description and the clarifying answers in the Flow's problem text, then freezes the user-confirmed criteria, all in one idempotent server action. The user never visits Documents first. 
  Verification: exec `bun apps/hub-web/tests/browser-journeys.e2e.mjs` extended with a quick-start journey (planned extension)
- **R8. Clarifying-question form.** Before starting, the app can show a short form of questions generated for the task (scope, constraints, done-when). Answers are stored in the Flow's problem text (as for R7), so they are shown wherever the Flow's problem is shown. Skipping is allowed and recorded: every skipped question is kept under its own name, and a wholly skipped form is marked with one skip line. 
  Verification: exec `bun test src/hub/work/clarify.test.ts` (planned; v1 questions come from the mode template, so the question set, the storage and the skip record are all testable)

### Direction 3: Stage timeline

- **R9. Stages from stored events.** A run page shows plan, implement, checks, review, visual and accept as ordered stages with state (waiting, running, passed, failed, skipped), start and end time, and the agent that ran it. Each state is derived from stored run events, never from client guesses. 
  Verification: exec `bun test src/hub/work/stage-timeline.test.ts` (planned)
- **R10. Agent log per stage.** Selecting a stage shows its agent log, streamed while running and paged after. Secrets masked by the existing sandbox masking appear masked. 
  Verification: exec `bun test src/hub/work/stage-log.test.ts` (planned) and judged redaction check against a seeded credential

### Direction 4: Diff, findings and visual QA

- **R11. Working-copy diff.** The app shows the diff of a run's working copy against its base, file by file, with the changed lines selectable. 
  Verification: exec `bun test src/hub/work/diff-view.test.ts` (planned)
- **R12. Findings beside the code.** Reviewer findings from the review orchestrator (file, line, severity, summary, verdict) render next to the lines they cite. A finding whose line is not in the diff appears in a separate "outside the diff" group, never dropped. 
  Verification: exec `bun test src/hub/work/finding-anchor.test.ts` (planned)
- **R13. Visual QA screenshots.** Screenshots captured at the visual stage are stored as run artifacts and shown in the timeline, before and after where both exist. A run with no visual stage shows none and says why. 
  Verification: judged (live run with a UI change) plus exec `bun test src/hub/work/visual-artifacts.test.ts` (planned)

### Cross-cutting: TUI parity

- **R14. TUI for quick start and solo status.** The shell gets a command and menu item for quick start with the same modes and clarifying form as a keyboard-accessible modal, and a status line for the local Hub. 
  Verification: exec `bun test src/tui/quick-start-modal.test.ts` (planned) plus judged TUI walk
- **R15. TUI for the timeline and findings.** A sidebar section lists the current run's stages with live state, a modal shows a stage log, and a modal lists findings with file and line. The diff opens in the existing review surface. Updates arrive in the background without a refresh key. 
  Verification: exec `bun test src/tui/stage-timeline-panel.test.ts` (planned) plus judged TUI walk
- **R16. No second implementation.** The desktop, web and TUI read the same Hub endpoints for stages, findings and artifacts. A parity test fails when a field exists in one surface and not the others. 
  Verification: exec `bun test src/hub/work/surface-parity.test.ts` (planned)

## 6. Success criteria

### Release criteria (checkable when the work ships)

1. R1–R3, R6, R7, R9–R12 and R14–R16 verification commands exit 0 in CI.
2. `bun scripts/build-hub-web.ts --check` passes with the new views embedded.
3. A signed build starts, opens the local Hub, logs in without a token, and quits leaving no child process, on Linux, macOS and Windows.
4. The local no-token login returns 403 for a non-loopback peer and for a Hub started without the solo flag (test, not a claim).
5. Quick start of a one-line bug produces a Flow with frozen criteria in at most three user actions after typing the description.
6. The global install path (npm only) is unchanged: `npm i -g keryx` still works and ships no desktop binary.

### Outcome criteria (true some time after release)

1. A solo user with no prior setup reaches a first accepted Flow in under ten minutes. Observation: a timed first-run walk with two people who have not used keryx, recorded in the verification report, within two weeks of the first build.
2. Share of Flows started through quick start versus the full form. Observation: Hub event counts per start path, read after four weeks of use.
3. Reviewer findings that the user opens from the diff view. Observation: count of finding-open events against findings produced, read after four weeks.
4. not measured — whether the desktop shell raises adoption beyond the operator's own use: there is no external user base to sample yet.

## 7. Risks

- **Third surface to maintain.** TUI, web and desktop can drift. Mitigation: R16 parity test, and the desktop adds no logic of its own.
- **Packaging and signing.** Code signing for macOS and Windows costs money and time, and keryx ships through npm only. Mitigation: D1 and D2 in the specification; the desktop is a separate artifact, not part of the global npm install.
- **CI on three platforms.** Cost and flakiness. Mitigation: build and smoke only on tag, unit tests stay on Linux.
- **Solo auth becomes an attack path.** A loopback-only no-token login is a local privilege boundary: any local process can hit the port. Mitigation: one-time secret at spawn, random port, Origin check, refusal outside solo mode. Residual risk stated in the specification.
- **Template questions may fit a task poorly.** Mitigation: skippable and recorded; model-generated questions are deferred to a later requirement, where quality can only be judged on samples.
- **Hub's Work API availability.** The live fixture reported the new work model unavailable on that server. Timeline and findings depend on stored events; the specification requires a check of what the current backend already stores before building new endpoints.
- **Scope.** Four directions in one package. Mitigation: the specification orders them so each is shippable alone (solo mode first, since the others also serve the team).

## 8. Recommendation

Build the web capabilities first (quick start, timeline, diff and findings), because they serve the team Hub and the desktop alike and need no shell. Then solo mode with the local Hub child, then the shell with notifications, tray and update. Do not start an Electron or Tauri app from scratch before solo auth (R2) is reviewed, since it is the security-relevant piece. Keep TUI items inside each direction's flow, not as a trailing flow.

Decisions D1–D5 were taken by the operator on 2026-11-14 (Telegram message 262443): Tauri; GitHub releases; separate app plus `keryx hub solo`; the order above; template-based clarifying form in v1. Details and consequences are in specification section 9. R3 now means Tauri; R8's question source is the mode template in v1.
