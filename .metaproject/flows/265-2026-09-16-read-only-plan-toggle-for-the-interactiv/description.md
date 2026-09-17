# Read-only /plan toggle for the interactive agent session

Status: formalized
Source: `docs/requirements/keryx-plan-mode-toggle/README.md` (planning conversation, 2026-09-16), pre-answered by the user — see that doc for the full decision trail.

## Problem

keryx's interactive agent session (`keryx shell`, TUI) has `/mode ask|trust|auto`
(`src/commands/permission-mode.ts`), which controls how much confirmation a
mutating tool call needs, but nothing controls whether mutating tools are
reachable AT ALL. A competitive review of other terminal coding agents found a comparable
read-only posture with no keryx equivalent: there is no way to put a session
into a hard "nothing mutates, whatever the mode" state.

## Expected Outcome

- A new, orthogonal `readOnly: boolean` flag exists alongside `PermissionMode`
  (NOT a 4th mode value): both axes are independently settable (e.g.
  `trust` + `readOnly`).
- Enforcement happens at the `resolveApprovalDecision` gate: a new `"deny"`
  outcome, returned before/alongside the existing `credentials`/
  `sacReviewConfirmation` hard floors, when `readOnly && risk !== "read"`.
  This is a HARD floor — no mode lifts it.
- A new `/plan` slash command (`AGENT_ONLY`) toggles it: `/plan [on|off]`,
  no-arg reports current state — in both `keryx shell` (headless) and the TUI.
- `readOnly` is in-memory only, per-session, always starts `false`. No
  persistence, no config file, no registry.
- Denied calls under `readOnly` get an immediate, clear refusal — never a
  `requestApproval` round-trip.

## Out of Scope

- Read-only git tools (`git_status`/`git_diff`/`git_log`) — MVP explicitly
  denies `shell_exec` entirely under `readOnly`, so `git diff/log/status`
  become unavailable via the agent. Deliberate, accepted MVP gap; revisit only
  if painful in practice.
- Any persisted default for `readOnly` (deliberate: a session-scoped, not
  durable, posture).
- TUI cosmetics — a mode badge/picker. Not discussed; separate follow-up if
  wanted.
- Rebuilding/mutating `buildInteractiveAgentTools`/`interactive-agent-tools.ts`
  — enforcement is gate-level, never tool-list surgery.
- The MCP dispatch path (`src/mcp/`) and the `harness/policy`/`harness/mutation`
  evidence engine — both already have their own, stricter, unconditional
  posture untouched by `permission-mode.ts` (see that file's own docstring).
