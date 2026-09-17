# Implementation Plan

Status: formalized, verified against current tree (2026-09-16) via
`keryx gdgraph affected` + `keryx ctx rg`. Line numbers below matched the
design doc's targets exactly except where noted.

## Approach

Exactly the shape decided in `docs/requirements/keryx-plan-mode-toggle/README.md`:
orthogonal flag, gate-level deny, no persistence, no read-only git tools. No
alternatives brainstormed — the design doc already resolved the trade-offs
(folding into `PermissionMode` vs. orthogonal; tool-list surgery vs.
gate-level deny; persisted vs. session-scoped) through a real planning
conversation with the user, and this flow must not relitigate them.

## Steps

1. **`src/commands/permission-mode.ts`**
   - `ApprovalGateDecision`: `"auto" | "ask"` → `"auto" | "ask" | "deny"`.
   - `ApprovalGateInput`: add required `readOnly: boolean` field (with a
     docstring analogous to the existing fields' — state it is an
     independent axis, not a mode value).
   - In `resolveApprovalDecision`, add the hard-floor check: after the
     `risk === "read"` early return (line ~90-92, unaffected by `readOnly` —
     reads are always safe), and BEFORE the `credentials`/
     `sacReviewConfirmation` check (line ~94-96): `if (readOnly && risk !== "read") return "deny";`
   - Update the function's docstring to describe the new floor.

2. **Every `resolveApprovalDecision` call site must pass `readOnly`** (the
   field is required, not optional — a caller that forgets it is a compile
   error, which is the point):
   - `src/commands/agent.ts` — 3 call sites inside `executeCall` (currently
     lines ~2155, ~2177, ~2197: the `shell`/`destructive` branch, the
     `delegate` branch, the `write` branch). `executeCall` needs a new
     parameter (mirror the existing `permissionMode: AgentIO["permissionMode"]`
     parameter at line ~2103) — a `readOnly: AgentIO["readOnly"]` parameter —
     resolved the same way `mode` is resolved (line ~2145:
     `const mode: PermissionMode = permissionMode?.() ?? DEFAULT_PERMISSION_MODE;`
     becomes an analogous `const isReadOnly = readOnly?.() ?? false;`).
   - Both call SITES of `executeCall` itself (line ~1619 in the main
     tool-call loop, and line ~1993 in `runConcurrentSpawnBatch`) must pass
     `io.readOnly` through, mirroring their existing `io.permissionMode` arg.
   - New `AgentIO.readOnly?: () => boolean;` field, docstring mirroring
     `permissionMode`'s (line ~154) — read fresh per call, absent means
     `false` (today's unchanged behavior).
   - On a `"deny"` decision, `executeCall` returns an immediate
     `InteractiveToolResult` refusal (`isError: true`, a message naming
     read-only mode) — never calls `requestApproval`. This applies to all
     three branches (shell/destructive, delegate, write).
   - `src/harness/external/supervise-mcp.ts`'s own `resolveApprovalDecision`
     call site(s) are OUT OF SCOPE per the module's own docstring (MCP
     dispatch path has its own posture) — pass `readOnly: false` there to
     satisfy the now-required field without changing that path's behavior,
     and say so in a one-line comment so a future reader does not mistake it
     for an oversight.

3. **New `/plan` command**, `src/commands/agent-commands.ts` (~line 189-194,
   right after the existing `/mode` entry):
   - `{ name: "/plan", description: "Toggle read-only mode — /plan [on|off]", modes: AGENT_ONLY }`

4. **Handlers**:
   - `src/commands/shell.ts` (~line 1482, `else if (command === "/mode")`
     branch) — add a sibling `else if (command === "/plan")` branch. Own
     `let readOnly = false;` declared near `let permissionMode` (line ~1251),
     wired via `agentIo.readOnly = () => readOnly;` next to
     `agentIo.permissionMode = () => permissionMode;` (line ~1253). No-arg
     reports current state; `on`/`off` sets it and confirms; anything else is
     a usage error. No confirmation prompt needed (unlike `/mode auto` —
     going read-only is the SAFE direction, and turning it off just returns
     to whatever `permissionMode` already governs).
   - `src/tui/tui-shell.ts` (~line 4881, `if (command.name === "/mode")`
     branch calling `runModeCommand`) — add a sibling
     `if (command.name === "/plan") { runPlanCommand(line); return; }`. New
     `runPlanCommand` function mirroring `runModeCommand`'s shape (~line
     3819) but simpler — no confirmation dialog, no full picker overlay (TUI
     cosmetics are explicitly out of scope): no-arg → `chrome.showToast`
     with current state; `on`/`off` → toggle + toast; anything else → usage
     via `io.onSystem?.`. Own `let readOnly = false;` next to
     `let permissionMode` (line ~3358), wired via
     `io.readOnly = () => readOnly;` next to `io.permissionMode = () => permissionMode;`
     (line ~3360).
   - `src/tui/busy-dispatch.ts` (~line 64) — add `"plan"` to the
     `BusyDispatchTarget` union and
     `if (commandName === "/plan") return "plan";` right after the `/mode`
     line, same reasoning as `/mode` (a toggle command should work while the
     main agent is busy).
   - `src/tui/tui-shell.ts`'s busy-branch switch (~line 4531, `case "mode":`
     calling `runModeCommand(line)`) — add a sibling
     `case "plan": { runPlanCommand(line); return; }`.

5. **Persistence** — none (decision 4 in the design doc). No writes to
   `permission-mode-config.ts`, no new config file, no registry.

6. **Tests** (see `tasks.md` T2 — folded into the implement task, matching
   this repo's convention of task-implementer writing tests alongside code):
   - `src/commands/permission-mode.test.ts` — new `readOnly` × mode ×
     risk cases for `resolveApprovalDecision`: `readOnly: true` denies every
     non-read risk (`shell`, `destructive`, `delegate`, `write`) under EVERY
     mode (`ask`, `trust`, `auto`), including the previously-auto-approving
     `trust`/`auto` combos; `readOnly: true` + `risk: "read"` still resolves
     `"auto"`; `readOnly: false` is a no-op (existing behavior unchanged,
     regression-covered by the existing suite already there).
   - `src/commands/agent-commands.test.ts` — `/plan` appears in agent-mode
     command list, absent from chat-mode list (mirrors the existing `/mode`
     assertions).
   - `src/commands/agent-commands.confusable.test.ts` — confirm `/plan`
     introduces no confusable pair (the test presumably iterates the full
     command list already; a new addition should be automatically covered,
     verify it runs clean).
   - `src/tui/busy-dispatch.test.ts` — `/plan` classifies to `"plan"`.
   - `src/commands/shell.test.ts` — `/plan` no-arg / `on` / `off` /
     bad-arg behavior; a denied tool call under `readOnly` in the headless
     shell path.
   - `src/tui/tui-shell.test.ts` — same shape for the TUI handler.
   - `src/commands/agent-permission-mode.test.ts` (or a new
     `agent-readonly-gate.test.ts` if that file's existing structure doesn't
     fit cleanly) — an end-to-end `executeCall`/`runAgentTurn` exercise
     confirming a non-read tool call is denied under `readOnly` with NO
     `requestApproval` invocation, across at least one non-`ask` mode (e.g.
     `trust` + `readOnly` still denies — this is the case that proves the
     axes are truly independent, not a hidden 4th mode value).

## Risks

- **Required vs. optional `readOnly` on `ApprovalGateInput`**: making it
  required (matching the design doc's literal "add `readOnly: boolean`", no
  `?`) forces every call site to update, including the out-of-scope
  `supervise-mcp.ts` one. This is intentional — a silently-defaulted optional
  field is exactly the kind of "looks wired, isn't" bug this flow must not
  introduce — but it does mean `supervise-mcp.ts` needs a one-line touch even
  though its own behavior does not change. Documented as low-risk, scoped,
  and necessary.
- **Missed `resolveApprovalDecision` call site**: `keryx ctx rg` found calls
  only in `agent.ts` (3, the real gate) and `supervise-mcp.ts` (MCP path, out
  of scope) besides the test files. `task-implementer` must re-run
  `keryx ctx rg 'resolveApprovalDecision' src` after its edits to confirm the
  call-site count didn't change unexpectedly and every one now passes
  `readOnly`.
- **`executeCall`'s two call sites** (`runAgentTurnCore`'s main loop and
  `runConcurrentSpawnBatch`) both need `io.readOnly` threaded, or the
  concurrent-spawn path would silently keep the old (non-read-only-aware)
  behavior for parallel `spawn_subagent` batches. Explicit task-implementer
  instruction to touch both.
