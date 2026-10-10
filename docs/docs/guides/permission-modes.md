# Choose an approval mode: ask, trust, auto

`keryx shell` (both the OpenTUI surface and the `--no-tui` readline fallback)
has three permission modes that decide whether a mutating tool call
(`shell_exec`, `spawn_subagent`, or any tool declaring risk `destructive`)
stops to ask you first. This page is the full reference: what each mode does,
how to set it, and exactly where every piece of state lives on disk. It also
covers the separate, orthogonal read-only `/plan` toggle, further down, for
when nothing should be reachable at all.

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

## Trusting one MCP tool for the session

An MCP tool called through `use_tool` always counts as destructive, so it asks
even under `trust`. In `trust` mode the prompt therefore also offers `T` (the
TUI dock: "Trust this tool (this session)") next to approve and deny. It skips
future prompts for that **exact** tool name, for this interactive session only —
never a wildcard, never a whole server, and never written to disk. The model
cannot add to it, and `/new`, `/clear` and resuming a session clear it.

Three rules keep the grant from becoming a way around the approval gate:

- **Bound to the tool's definition.** The grant remembers a fingerprint of the
  tool's name, description and input schema as the server reported them when you
  said yes. If a later call finds a different definition (or the tool is gone),
  the grant is dropped and the call asks again.
- **Not offered, and not honoured, next to untrusted content.** When the turn
  already holds external content (a web result or any MCP tool result, including
  one from the trusted tool itself), the call asks even for a trusted tool, and
  the prompt does not offer `T` — it says why instead. The grant applies again
  from the next turn.
- **Never offered for a tool its server marks destructive.** If the tool's
  catalog entry says `destructiveHint: true`, `T` is not offered (dock and
  prompt alike) and the prompt says why. The check reads the live catalog on
  every call, so a grant made while the tool looked harmless is dropped, and the
  call asks again, once the server starts reporting `destructiveHint: true`. A
  tool with **no** annotation, or `destructiveHint: false`, is treated as it
  always was and is still offered `T`. The hint is advisory and comes from the
  server, and the MCP default for a missing hint is "destructive", which would
  withhold trust from nearly every server; keryx only acts on an explicit `true`.

### Seeing and revoking grants

A tool that holds a grant carries a `[trusted]` marker: on its approval lines
(when it still has to ask, for example next to untrusted content), on the line
printed when it runs without asking, in the `/mcp` server view (a per-server
count), and in the list below.

```text
/mcp trust list                    # every trusted tool, by full name and server
/mcp trust revoke <server__tool>   # revoke one; it asks again on its next call
/mcp trust revoke all              # revoke everything
```

`list` shows `(will ask again: changed | destructive | gone)` instead of `[trusted]`
for a grant the next call would not honour: the definition changed, the tool now
reports `destructiveHint: true`, or it left the catalog.

Revoke takes the full `server__tool` name exactly as `list` prints it. An
unknown name is reported and changes nothing. These work while the agent is
busy, and in the readline shell as well as the TUI.

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

## Review system

The review system decides who answers the approval questions of a review run. By
default it **inherits** the permission mode: in `trust` it asks you only now and then,
for example when a reviewer is about to be spawned after the agent has read external
content (the page the agent read cannot approve that call; you do).

Switch it to `review-auto` and the shell answers those questions itself:

```bash
keryx shell --trust --review-system review-auto
```

or say it in the session: "сделай автоматическое ревью", "run an automatic review" or
mention `review-auto`. Only your own line counts; a subagent's task text and a message
from a peer or a tool result never switch it on. `KERYX_REVIEW_SYSTEM=review-auto` does
the same for an unattended shell, and `ask_user` menus take their recommended option.

What `review-auto` still asks you about: destructive commands, credential access,
publish leases, calls a hook tightened to "ask", and any call other than a reviewer
spawn that follows untrusted external content. Each automatic answer is recorded in the
transcript like any other auto-approval.

## Long runs in the shell

A review of a large pull request is hundreds of tool calls. The shell is built to
carry one to the end without you typing anything after the task.

- **Round limit.** A turn may use 40 tool rounds in `ask` and `auto`, and **200 in
  `trust`**. The limit follows the mode in force when the turn starts, so `/mode
  trust` takes effect on the next turn. `KERYX_AGENT_MAX_ROUNDS` still overrides
  both. When the limit is hit, the "reset" choice adds the limit of the current mode.
- **No prompt for routine commands.** In `trust`, a short `&&` chain of `cd`,
  `keryx review`, `keryx ctx rg|read|diff|run --`, read-only `keryx flow`, `gdgraph`
  and `git` subcommands, and `bun test` runs without asking, even after the turn has
  read untrusted content (web or MCP results). Destructive commands, credential
  access, SAC and publish gates, and every other command still ask.
- **Open plans do not end the turn.** In `trust`, a turn that would end with open
  plan items continues on its own, at most 8 times in a row, and stops earlier when
  the model makes no progress.
- **Answers are kept.** What you answer to a question the agent asks (counterpart,
  model plan, budget, scope) is stored in the session slate, so it is not asked again
  after compaction or in a later turn. Questions marked irreversible are always asked.
- **Waves of 10.** Up to 10 subagents run at once, each with a round budget of 40
  (at most 200 per subagent).
- **Slash commands are queued, not dropped.** A command typed while a turn runs is
  shown as `queued as qN` and runs when the turn ends; `/queue` lists, edits and
  removes. `/new`, `/clear` and `/resume` are refused while busy, because running
  them later would swap the session under the questions queued behind them.
- **Ctrl+C cancels the turn.** During a turn, one Ctrl+C cancels it and returns to the
  prompt. At an idle prompt, the first Ctrl+C shows a hint and a second one within 2
  seconds exits; `/exit` always exits. Exiting a shell started with
  `/remote-control` ends its Telegram topic.

For the review side (`keryx review slice`, `dispatch-check`, `retry-plan`,
`ledger`, `keryx ctx run --raw`) see the [CLI reference](../cli-reference.md).

## Read-only mode: `/plan`

`readOnly` is a separate, **orthogonal** toggle — not a fourth mode. Where
`ask`/`trust`/`auto` decide *how much confirmation* a mutating call needs,
`readOnly` decides *whether mutating tools are reachable at all*. The two
combine freely: `trust` + `readOnly` still confirms nothing extra, but every
non-read action is refused outright regardless.

```text
/plan                  # show the current state (TUI: opens a picker)
/plan on               # deny every non-read tool call for this session
/plan off              # back to whatever the current mode allows
```

When `readOnly` is on, a denied call gets an immediate refusal — never a
confirmation prompt, and never auto-approved, even under `auto`. It is a hard
floor: no mode lifts it.

**Scope of what "read" means today.** `shell_exec` is denied entirely under
`readOnly` — there is no per-command allowlist (`git diff`/`git log`/`git
status` are unavailable through the agent while it is on). The agent still
has `read_file`, `list_dir`, `get_cwd`, and `search_code`. This is a
deliberate v1 scope, not an oversight — a read-only git surface may follow if
it proves painful in practice.

**Not persisted.** Unlike the mode's `save` flag, `readOnly` is always
in-memory, always starts `false` on a new session. There is no
`/plan on save` and no config file for it.

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
