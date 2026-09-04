# Permission Modes

Version: 1.0.0
Type: architecture
Status: accepted
Describes:
  - src/commands/permission-mode.ts
  - src/lib/permission-mode-config.ts
  - src/lib/command-risk.ts
  - src/harness/child/quarantine.ts
  - src/harness/policy/**
  - src/harness/mutation/**

## Summary

The interactive agent session (`keryx shell`, both the OpenTUI surface and the
readline fallback) has three user-selectable permission modes — `ask`,
`trust`, `auto` — that decide whether a mutating tool call (`shell_exec`,
`spawn_subagent`, any tool declaring `risk: "destructive"`) prompts for
approval before it runs. They sit **above** the existing per-call approval
gate in `src/commands/agent.ts`'s `executeCall`, deciding whether
`AgentIO.requestApproval` is even invoked — never replacing it, and never
touching the separate `src/harness/policy`/`src/harness/mutation` evidence
engine that governs `harness run`/`harness exec`/`keryx serve` (see
"Explicitly out of scope" below).

## Details

### The three modes

| Mode | Behavior |
|---|---|
| `ask` (default) | Unchanged pre-existing behavior: every `shell`/`destructive`/`delegate` call prompts. Only `read` skips the prompt. |
| `trust` | Auto-approves a call unless it is `destructive` (the tool's own static risk, or a per-command escalation from `isDestructiveCommand`) — a destructive action still asks. |
| `auto` | Skips the prompt for everything except a credentials-touching command. Deliberately dangerous (mirrors Claude Code's `bypassPermissions` / the informal "yolo mode" other CLIs use); entering it requires an explicit one-time confirmation. |

The decision function is pure: `src/commands/permission-mode.ts`'s
`resolveApprovalDecision({mode, risk, destructive, credentials})`.

### The hard floor: `credentials`

A command that touches the agent's own permission/credential state
(`touchesAgentCredentials` in `src/lib/command-risk.ts` — matches
`permissions.json`, `auth.json`, `.local/share/keryx`, `.config/keryx`
anywhere in the command text) is **never** auto-approved, in any mode,
including `auto`. This mirrors the existing contract on `ApprovalMeta` for
the pre-existing shell "remember" allowlist ("never auto-approved and never
remembered, whatever the user picks") — a mode-driven bypass gets the same
floor, not a weaker one.

### Where the mode lives

- **Session-scoped**: `AgentIO.permissionMode: () => PermissionMode`, a
  getter read fresh on every gated call (never cached), so a live `/mode`
  switch takes effect on the very next tool call.
- **CLI flag**: `--permission-mode <ask|trust|auto>` or the `--ask`/`--trust`/
  `--auto` shorthands on `keryx shell` (agent mode only — chat mode has no
  tools to gate).
- **Persisted default**: per-project, in `src/lib/permission-mode-config.ts`
  — a small registry (`permission-mode.json`, next to `auth.json`/
  `projects.json` in the user-global keryx config dir), keyed by
  `projectIdentity()` (realpath-resolved project root, shared with
  `project-registry.ts`). A separate registry from `projects.json`
  deliberately: `ProjectEntry` is tied to the register/forget lifecycle of
  `keryx init`, and a permission-mode default must be settable for a project
  the user never explicitly registered.
- **Resolution order**: CLI flag → stored project default
  (`getProjectPermissionMode`) → `DEFAULT_PERMISSION_MODE` (`ask`). Resolved
  once per session; `/mode` only ever reassigns the session's `let`, never
  re-derives the chain.

### The `/mode` command

Available in both the readline agent REPL (`src/commands/shell.ts`) and the
OpenTUI agent shell (`src/tui/tui-shell.ts`):

- `/mode` — show the current mode (TUI: opens a picker, parity with `/theme`).
- `/mode <ask|trust|auto>` — switch for this session only.
- `/mode <mode> save` — also persist as this project's default.
- `/mode clear` — remove the stored project default (session mode unaffected).

Switching to `auto` always requires an explicit confirmation step first
(readline: type `yes`; TUI: a Confirm/Cancel composer choice, Cancel
pre-selected) — never a silent flip, and never settable any other way.

### Visibility: `onAutoApproved`

Because `trust`/`auto` skip `requestApproval` entirely, the pre-existing
"✓ auto-approved shell: …" message (which lives *inside* `requestApproval`,
for the shell "remember" allowlist) never fires for a mode-driven
auto-approval. `AgentIO.onAutoApproved(tool, input, {destructive,
credentials})` closes that gap: fired exactly when a `trust`/`auto` decision
skips the prompt, rendered **non-dimmed** in both surfaces. This follows a
principle already established elsewhere in this codebase for the read-only
subagent auto-approval line: *an auto-approval the user cannot notice is an
auto-approval they cannot object to.*

### Explicitly out of scope

- **MCP dispatch** (`src/mcp/`) — an inbound MCP tool call (keryx invoked as
  an MCP server by another agent) does not go through `executeCall`'s
  permission-mode gate at all. This is deliberate: extending `auto`/`trust`
  there would create a new auto-approve surface reachable by a remote or
  headless caller, which is exactly what the formal
  `src/harness/policy`/`src/harness/mutation` evidence engine (`checkApproval`
  hard-denying `interactive === false`, ADR-0003's frozen `override: false`)
  exists to prevent. If MCP-exposed tool calls need a mode concept, that is a
  separate follow-up scoped explicitly against that invariant, not an
  extension of this feature.
- **`harness run`/`harness exec`/`keryx serve`** — governed entirely by the
  policy-profile engine (`read-only-review` / `monitored-trusted-local` /
  `unattended-untrusted`), untouched by this feature.
- **Model/tool-settable mode** — `src/harness/child/quarantine.ts` already
  flags `permissionMode`/`bypassPermissions`/`allowedTools` appearing in
  child/subagent free text as a `"permission-config"` injection marker. The
  mode is host-only state: settable exclusively through the CLI flag, the
  `/mode` command, or the persisted per-project config — never through tool
  or model output.
- **Persistent header/footer indicator** (TUI) — not implemented. The
  header-right slot (`chrome.setHeaderMeta`) is already claimed by live token
  usage display; a mode chip needs its own slot. In the meantime, every mode
  switch shows a toast and every actual auto-approval prints a non-dimmed
  transcript line.

## Related

- `src/commands/permission-mode.ts` — the decision function and types.
- `src/commands/agent.ts` — `executeCall`'s gate, `AgentIO.permissionMode`/`onAutoApproved`.
- `src/lib/permission-mode-config.ts` — per-project persistence.
- `src/commands/shell.ts` / `src/tui/tui-shell.ts` — CLI flags, `/mode`, the two auto-approval renderers.
- [OS Sandbox](os-sandbox.md) — the orthogonal containment axis: bounds *what* a command can touch, independent of *whether the user is asked*.
