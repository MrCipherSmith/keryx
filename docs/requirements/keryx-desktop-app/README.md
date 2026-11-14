# Keryx Desktop App: solo mode, quick task start, stage timeline, diff view
Version: 0.2.0

Status: **draft, nothing implemented.** Written 2026-11-14. Decisions D1–D5 taken by the operator the same day (Tauri, GitHub releases, separate app plus `keryx hub solo`, web first, template clarifying form). No Flow exists for this package and no acceptance criteria are frozen. Every capability named here is `planned` unless a file in `src/` or `apps/hub-web/` proves otherwise.

## Purpose

Give one person a desktop way to run keryx work without a team Hub, a token or SSO, and make the loop "state a task, watch its stages, read the diff and the review findings, accept" visible in one window. The desktop app is a thin shell over the existing Hub web (`apps/hub-web`) and a Hub started locally as a child process. It is not a new product surface with its own logic.

## Documents

- [PRD](prd.md): problem, goal, users, requirements R1–R16 with verification fields, release and outcome criteria, risks, recommendation
- [Specification](specification.md): identity, structure, config, CLI/UI surface, data contracts, integration points, acceptance criteria drafts, TUI parity table

## Scope

Four directions, each with a matching TUI requirement (project rule: every user-facing capability appears in the TUI too):

1. Solo mode: local Hub child process, login without token or SSO, packaging shell, notifications, tray, auto-update.
2. Quick task start: modes quick, bug, task, epic, refactor; a clarifying-question form; starting without a pre-imported spec.
3. Stage timeline: plan, implement, checks, review, visual, accept, with agent logs per stage.
4. Working-copy diff with reviewer findings beside the code, and visual QA screenshots.

## Non-goals

- A second orchestrator or a second agent runtime. Execution stays in keryx runs and sessions.
- Replacing the team Hub, its auth, or its remote-v2 contracts. Solo mode is an additional local entry, never a bypass of team auth.
- Rewriting the web in a native toolkit.
- Freezing acceptance criteria or creating a Flow. Both wait for operator confirmation.

## Related modules

- `apps/hub-web` (React frontend, [hub-react-frontend](../hub-react-frontend/README.md))
- [hub-work-management](../hub-work-management/README.md): Flow, Intent, Attempt, Evidence, Decision model
- [hub-remote-sessions](../hub-remote-sessions/README.md) and [hub-remote-agents](../hub-remote-agents/README.md): sessions, runs, commands
- [keryx-native-distribution](../keryx-native-distribution/README.md): how keryx is shipped (the desktop shell must not break the npm-only global install)
- [keryx-opentui-shell](../keryx-opentui-shell/README.md): the TUI that receives the parity items
- [keryx-review-orchestrator-log](../keryx-review-orchestrator-log/prd.md): source of reviewer findings
- [keryx-ticket-intake](../keryx-ticket-intake/prd.md): existing intake path that quick start must not duplicate

## Evidence behind this package

A live walk of the Hub web on 2026-11-14 against an isolated two-process fixture (`src/lib/hub-machine/trial.test-support.ts`): eleven tabs rendered, login by token worked, "new session" and "create Flow" forms exist and require an explicit machine, working copy, profile and imported spec. The Work tab reported the new work model unavailable on that fixture server and offered only a simulated demo. Real runs, real diffs, the Work section with real data and pairing code creation were **not** observed. Comparison basis: PurpleFlow v0.3.4, an Electron app over the claude and codex CLIs.
