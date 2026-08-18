# Choose an approval mode: ask, trust, auto

`keryx shell` (both the OpenTUI surface and the `--no-tui` readline fallback)
has three permission modes that decide whether a mutating tool call
(`shell_exec`, `spawn_subagent`, or any tool declaring risk `destructive`)
stops to ask you first. This page is the full reference: what each mode does,
how to set it, and exactly where every piece of state lives on disk.

!!! note "Not the same thing as the policy engine"
    This is a session-level convenience layer for the interactive shell. It is
    a **different mechanism** from [the policy engine](../harness.md#the-policy-engine-three-answers-not-two)
    that governs `keryx harness run`/`keryx harness exec`/`keryx serve` —
    those keep their existing `allow`/`ask`/`deny` behavior untouched,
    including "headless never silently allows." Permission modes never
    weaken that. See [Scope](#scope) below.

## The three modes

| Mode | What happens |
|---|---|
| `ask` (default) | Every `shell_exec`, `spawn_subagent`, and destructive-risk tool call asks first — today's behavior, unchanged if you never touch this feature. |
| `trust` | Safe calls run without asking. A call still asks when it is destructive — either the tool's own static risk, or a command keryx's classifier recognizes as destructive (`rm -rf`, force-push, and similar). |
| `auto` | Nothing asks, **including destructive commands** — the same shape as Claude Code's `--dangerously-skip-permissions` or the informal "yolo mode" other CLIs offer. Entering it always requires an explicit one-time confirmation first. |

One thing no mode ever changes: a command that touches keryx's own
credential/permission files (`auth.json`, `permissions.json`,
`.local/share/keryx`, `.config/keryx` appearing anywhere in the command) is
**never** auto-approved, in any mode, including `auto`. That floor exists so
a compromised or confused turn cannot use `auto` mode to grant itself new
authority.

## Setting the mode

**One-shot, from the command line:**

```bash
keryx shell --trust                       # or --ask / --auto
keryx shell --permission-mode trust       # equivalent, explicit form
```

**Inside a running session**, the `/mode` command works the same way in both
the TUI and `--no-tui`:

```text
/mode                 # show the current mode (TUI: opens a picker)
/mode trust            # switch for this session only
/mode trust save       # switch AND remember it as this project's default
/mode clear             # forget the stored project default
```

Switching to `auto` always stops for an explicit confirmation first —
typing `yes` in the readline shell, or a Confirm/Cancel choice in the TUI.
There is no flag or setting that skips that confirmation; the mode can only
ever be changed by you, directly, in the running session. Nothing a tool or
the model outputs can set it — that is a deliberate boundary, not an
oversight.

## Where it's stored

| What | Where | Notes |
|---|---|---|
| The mode for the *current* session | In memory only | Set from the CLI flag, or the project default below, or `ask` if neither is set. `/mode` changes it live; nothing is written to disk unless you use `save`. |
| Your project's remembered default | `permission-mode.json`, in the shared keryx config directory (see below) | Written only by `/mode <mode> save` or `/mode clear` — never automatically. |
| The shared keryx config directory | macOS/Linux: `~/.local/share/keryx/` (or `$XDG_DATA_HOME/keryx` if set) · Windows: `%APPDATA%\keryx\` | The same directory that already holds `auth.json` (provider credentials) and `projects.json` (the project registry). One file per machine, keyed internally by each project's resolved path — not one file per project. |

`permission-mode.json` looks like this (path examples shortened):

```json
{
  "schemaVersion": 1,
  "projects": {
    "/Users/you/code/api-server": "trust",
    "/Users/you/code/scratch-experiments": "auto"
  }
}
```

The key is the project's *resolved* real path (symlinks followed), so the
same project reached through two different symlinked paths still shares one
entry. You will not normally edit this file by hand — use `/mode <mode> save`
and `/mode clear` — but it is plain JSON if you ever need to check or fix it
directly.

## What you'll see when something is auto-approved

Whenever `trust` or `auto` lets a call through without asking, the shell
prints a line for it anyway — never silently:

```text
◇ auto-approved (trust) git status
◇ auto-approved (auto) [destructive] rm -rf ./build
```

That line is intentionally **not** dimmed, unlike the ordinary "remembered
shell pattern" auto-approve line you may already know from answering
`[y/N/A=always]` — this one was never approved action-by-action, only the
mode itself was chosen once, so it stays visible enough that you would
actually notice it scroll by.

## Scope

Permission modes apply to the interactive `keryx shell` session only:

- **`keryx harness run` / `keryx harness exec` / `keryx serve`** keep using
  the formal policy-profile engine described in
  [the harness page](../harness.md#the-policy-engine-three-answers-not-two)
  — completely unaffected by this feature.
- **The MCP server** (`keryx mcp`) does not consult permission modes at all;
  an inbound MCP tool call from another agent is a separate code path.
- **No remote or headless caller can set `trust`/`auto` for you.** The mode
  is local, in-session, human-set state.

## See also

- [The agent harness](../harness.md) — the policy engine these modes sit above.
- [Run an agent without giving it your machine](contain-an-agent.md) — the OS
  sandbox, an independent containment layer: it bounds *what* a command can
  touch regardless of whether it was asked about.
