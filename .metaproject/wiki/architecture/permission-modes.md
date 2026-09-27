---
Title: Permission Modes
Version: 1.0.0
Type: architecture
Status: accepted
Summary: ""
---
```markdown
---
Title: Permission Modes
Version: 1.0.0
Type: architecture
Status: accepted
Summary: "Describes the three permission modes (`ask`, `trust`, `auto`) that govern whether mutating tool calls prompt for user approval during interactive agent sessions in `keryx shell`."
---
# Permission Modes

Describes:
  - src/commands/permission-mode.ts
  - src/lib/permission-mode-config.ts
  - src/lib/command-risk.ts
  - src/harness/child/quarantine.ts
  - src/harness/policy/**
  - src/harness/mutation/**

## Summary

The interactive agent session (`keryx shell`, supporting both the OpenTUI surface and the readline fallback) exposes three user-selectable permission modes — `ask`, `trust`, and `auto` — that determine whether a mutating tool call prompts for approval before execution. Affected operations include `shell_exec`, `spawn_subagent`, and any tool declaring `risk: "destructive"`.

These modes operate **above** the existing per-call approval gate in `src/commands/agent.ts`'s `executeCall`. They decide whether `AgentIO.requestApproval` is invoked at all, rather than replacing it. Crucially, this system never touches the separate `src/harness/policy`/`src/harness/mutation` evidence engine that governs `harness run`, `harness exec`, and `keryx serve` (see "Explicitly out of scope" below).

## Details

### The Three Modes

| Mode | Behavior |
|------|----------|
| `ask` (default) | Preserves pre-existing behavior: every `shell`, `destructive`, or `delegate` call prompts for approval. Only `read` operations skip the prompt. |
| `trust` | Auto-approves calls unless they are `destructive` (either the tool's own static risk classification, or a per-command escalation from `isDestructiveCommand`). Destructive actions still require confirmation. |
| `auto` | Skips the prompt for all operations except those touching credentials. This mode is deliberately dangerous — it mirrors Claude Code's `bypassPermissions` or the informal "yolo mode" found in other CLIs. Entering `auto` requires an explicit one-time confirmation. |

The decision logic lives in a pure function: `src/commands/permission-mode.ts`'s `resolveApprovalDecision({mode, risk, destructive, credentials})`.

### The Hard Floor: `credentials`

Any command that touches the agent's own permission or credential state — detected via `touchesAgentCredentials` in `src/lib/command-risk.ts`, which matches `permissions.json`, `auth.json`, `.local/share/keryx`, and `.config/keryx` appearing anywhere in the command text — is **never** auto-approved, regardless of mode. This includes `auto` mode.

This behavior mirrors the existing contract on `ApprovalMeta` for the shell "remember" allowlist: credentials-touching commands are never auto-approved and never remembered, regardless of user preference. The mode-driven bypass receives the same floor, not a weaker one.

### Where the Mode Lives

**Session-scoped mode**

`AgentIO.permissionMode: () => PermissionMode` is a getter read fresh on every gated call. It is never cached, so a live `/mode` switch takes effect on the very next tool call without requiring session restart.

**CLI flags**

```
keryx shell --permission-mode <ask|trust|auto>
keryx shell --ask
keryx shell --trust
keryx shell --auto
```

These flags apply to agent mode only. Chat mode has no tools to gate, so it ignores these flags.

**Persisted default**

Per-project defaults live in `src/lib/permission-mode-config.ts`, stored in `permission-mode.json` within the user-global keryx config directory (alongside `auth.json` and `projects.json`). The registry is keyed by `projectIdentity()` — the realpath-resolved project root, shared with `project-registry.ts`.

This uses a separate registry from `projects.json` deliberately: `ProjectEntry` ties to the register/forget lifecycle of `keryx init`, but a permission-mode default must be settable for a project the user never explicitly registered.

**Resolution order**

```
CLI flag → stored project default (getProjectPermissionMode) → DEFAULT_PERMISSION_MODE (ask)
```

Resolution occurs once per session. The `/mode` command reassigns only the session's local value, never re-deriving from the chain.

### The `/mode` Command

Available in both the readline agent REPL (`src/commands/shell.ts`) and the OpenTUI agent shell (`src/tui/tui-shell.ts`):

| Command | Action |
|---------|--------|
| `/mode` | Show the current mode. In the TUI, opens a mode picker (parity with `/theme`). |
| `/mode <ask\|trust\|auto>` | Switch the mode for this session only. |
| `/mode <mode> save` | Switch and persist as the project's default. |
| `/mode clear` | Remove the stored project default. Session mode is unaffected. |

Switching to `auto` always requires an explicit confirmation step:

- **Readline**: Type `yes` to proceed.
- **TUI**: A Confirm/Cancel composer choice, with Cancel pre-selected.

This is never a silent flip and cannot be set any other way.

### Visibility: `onAutoApproved`

Because `trust` and `auto` skip `requestApproval` entirely, the pre-existing "✓ auto-approved shell: …" message — which lives inside `requestApproval` for the shell "remember" allowlist — never fires for mode-driven auto-approvals.

`AgentIO.onAutoApproved(tool, input, {destructive, credentials})` closes this gap. It fires exactly when a `trust` or `auto` decision skips the prompt, rendering a non-dimmed line in both the readline and TUI surfaces.

This follows a principle already established elsewhere in the codebase for read-only subagent auto-approval: **an auto-approval the user cannot notice is an auto-approval they cannot object to.**

### Explicitly Out of Scope

**MCP dispatch (`src/mcp/`)**

An inbound MCP tool call — where keryx operates as an MCP server invoked by another agent — does not traverse `executeCall`'s permission-mode gate at all. This is intentional: extending `auto` or `trust` to MCP dispatch would create a new auto-approve surface reachable by a remote or headless caller.

The formal `src/harness/policy`/`src/harness/mutation` evidence engine (`checkApproval` hard-denies `interactive === false`, ADR-0003's frozen `override: false`) exists precisely to prevent this. If MCP-exposed tool calls need a mode concept, that requires a separate follow-up scoped explicitly against this invariant — not an extension of this feature.

**`harness run` / `harness exec` / `keryx serve`**

These commands are governed entirely by the policy-profile engine (`read-only-review`, `monitored-trusted-local`, `unattended-untrusted`). This permission-mode system does not affect them.

**Model or tool-settable mode**

`src/harness/child/quarantine.ts` already flags `permissionMode`, `bypassPermissions`, or `allowedTools` appearing in child or subagent free text as a `"permission-config"` injection marker. The permission mode is host-only state: settable exclusively through the CLI flag, the `/mode` command, or the persisted per-project config — never through tool or model output.

**Persistent header/footer indicator (TUI)**

Not implemented. The header-right slot (`chrome.setHeaderMeta`) is already claimed by live token usage display, and a mode chip would need its own slot. In the meantime, every mode switch shows a toast, and every actual auto-approval prints a non-dimmed transcript line.

## Related

- `src/commands/permission-mode.ts` — The decision function and type definitions.
- `src/commands/agent.ts` — `executeCall`'s gate, `AgentIO.permissionMode`, and `onAutoApproved`.
- `src/lib/permission-mode-config.ts` — Per-project persistence logic.
- `src/commands/shell.ts` / `src/tui/tui-shell.ts` — CLI flags, `/mode` command, and the two auto-approval renderers.
- [OS Sandbox](os-sandbox.md) — The orthogonal containment axis: bounds *what* a command can touch, independent of *whether the user is asked*.
```
