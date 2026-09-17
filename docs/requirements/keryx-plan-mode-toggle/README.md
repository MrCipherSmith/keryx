# Read-only `/plan` toggle — implementation plan

Captured from a planning conversation on 2026-09-16, before implementation,
so the agreed shape survives a context reset. Implemented and merged; see
flow 265 (`.metaproject/flows/265-2026-09-16-read-only-plan-toggle-for-the-interactiv/`)
for the full record.

## Motivation

A competitive review of other terminal coding agents found a pattern keryx
had no equivalent for: a build/plan mode switch that swaps full tool access
for a read-only allowlisted mode. keryx's existing `/mode ask|trust|auto`
(`src/commands/permission-mode.ts`) controls whether actions are confirmed,
not whether mutating tools are reachable at all — a different axis.

## Decisions made (in order, superseding earlier drafts below where they conflict)

1. **`readOnly` is orthogonal to `PermissionMode`, not a 4th value of it.**
   First proposed this way, briefly reconsidered folding it into
   `PermissionMode` as `"plan"`, then reverted on user pushback: `ask/trust/auto`
   keeps meaning "how much to confirm"; `readOnly` means "what's reachable at
   all" — independent axes, both should be settable at once (e.g.
   `trust` + `readOnly`).
2. **Enforcement is gate-level (deny), not tool-list surgery.** Reuses the
   exact hard-floor pattern `credentials`/`sacReviewConfirmation` already use
   in `resolveApprovalDecision` — no rebuild of the interactive tool list,
   which is otherwise built once per session
   (`buildInteractiveAgentTools`, `src/commands/interactive-agent-tools.ts`)
   and would orphan `jobRegistry`/MCP runtimes if rebuilt mid-session.
3. **MVP ships without read-only git tools.** `shell_exec`'s risk is a single
   `"shell"` category (no per-command allowlist), and `builtinReadOnlyTools()`
   (`src/harness/tool/builtin/interactive-tools.ts:142`) only offers
   `get_cwd`/`list_dir`/`read_file`. Under `readOnly`, `shell_exec` is denied
   entirely — `git diff/log/status` become unavailable. Accepted as a known
   MVP gap; revisit only if it proves painful in practice (candidate
   follow-up: add `git_status`/`git_diff`/`git_log` tools with `risk: "read"`,
   or a per-command bash allowlist).
4. **No persistence.** `readOnly` lives only in the running session's
   in-memory closure, always starts `false`. Rejected extending
   `permission-mode.json`'s schema (touches pinned tests) and a sibling
   `plan-mode.json` registry (duplicates the whole file/lock/schema
   machinery) in favor of a deliberate, session-scoped posture, not a
   durable project setting.

## Concrete steps

1. **`src/commands/permission-mode.ts`**
   - `ApprovalGateDecision`: `"auto" | "ask" | "deny"` (add `"deny"`).
   - `ApprovalGateInput`: add `readOnly: boolean`.
   - In `resolveApprovalDecision`, before the `credentials`/`sacReviewConfirmation`
     check (or alongside it — both are hard floors): `if (readOnly && risk !== "read") return "deny";`

2. **New `/plan` command**, `src/commands/agent-commands.ts`
   - `{ name: "/plan", description: "Toggle read-only mode — /plan [on|off]", modes: AGENT_ONLY }`
   - No argument → report current state (mirrors `/mode`'s no-arg branch in `shell.ts`).

3. **Handlers** — new `else if (command === "/plan")` branch next to the
   existing `/mode` branch:
   - `src/commands/shell.ts` (~line 1482, alongside the `/mode` block) — own
     `let readOnly = false;` in the REPL closure, independent of `permissionMode`.
   - `src/tui/tui-shell.ts` (~line 4881) — mirrored handler + matching state.
   - `src/tui/busy-dispatch.ts` (~line 64) — classify `/plan` as busy-dispatchable,
     same as `/mode`.

4. **Persistence** — none (decision 4 above).

5. **Wire into the actual gate** — `resolveApprovalDecision` is consumed from
   `src/commands/agent.ts`'s `executeCall`; `readOnly` threads through via a
   new optional `AgentIO.readOnly?: () => boolean` hook (mirrors `permissionMode`
   exactly). A `"deny"` outcome returns an immediate tool refusal (clear
   message, no `requestApproval` round-trip).

6. **Tests to touch**: `permission-mode.test.ts` (new `readOnly` × mode
   cases), `agent-commands.test.ts` (`/plan` appears/filters correctly),
   `busy-dispatch.test.ts`, `shell.test.ts` / `tui-shell.test.ts` (new handler).

## Explicitly out of scope for this pass

- Read-only git tools (decision 3).
- Any persisted default for `readOnly` (decision 4).
- TUI cosmetics (a mode badge/picker) — not discussed yet; separate
  follow-up if wanted.
