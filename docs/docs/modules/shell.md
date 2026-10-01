# The keryx shell

`keryx shell` is an interactive terminal agent that runs on your own model provider and starts every turn already knowing your repository. It reads the same graph, wiki, memory and rules as your other agents, asks before it does anything risky, and keeps durable per-project sessions you can resume, fork and rewind.

## When to use it

- You want one agent that you can point at any model, hosted or local, without changing how you work.
- You want to see and approve each shell command or file change before it happens, or to loosen that deliberately for a session.
- You need to undo a turn: restore the files, the conversation, or both.
- You want to script one agent turn from CI or another tool with `--print` and an event log.
- You want a long task to continue on its own for a bounded number of rounds with `/goal`.

## Quick example

The shell needs one configured provider; see [Connect a model provider](../guides/connect-a-provider.md). Then start it from the project root:

```bash
keryx shell
keryx shell --provider ollama --model llama3.1:latest
keryx shell --trust
keryx shell -c
keryx sessions list
```

The first command opens the terminal interface and, with no provider configured, a picker. The second skips the picker. `--trust` starts in the `trust` approval mode, `-c` continues the most recent session no other shell has open, and `sessions list` lists this project's sessions without starting a shell. The shell prints its own usage:

```text
Usage: keryx shell [options]
  --help, -h                    Show this help without starting a session
  --provider <name>             Use this provider (otherwise choose interactively)
  --model <name>                Use this model
  --agent | --chat              Choose agent (default) or chat mode
  --tui | --no-tui              Prefer TUI (default) or readline; last flag wins
…
```

![keryx shell answering a blast-radius question with a graph tool call](../assets/shell.png)

When the agent needs a decision, it asks with structured options instead of guessing:

![keryx shell asking a structured question with selectable options](../assets/shell-ask.png)

## How it works

**Launch flags.** Run `keryx shell --help` for the full list. The ones you will use most:

| Flag | Effect |
|---|---|
| `--provider <name>`, `--model <name>`, `--base-url <url>` | Choose the model and endpoint instead of the picker. |
| `--agent`, `--chat` | Agent mode (default) has tools; chat mode is plain conversation. |
| `--tui`, `--no-tui` | Terminal interface (default) or the classic readline shell. |
| `-c`, `-r [id-or-title]`, `--fork`, `--take-over` | Continue, resume, branch, or take a session from a stale holder. |
| `--ask`, `--trust`, `--auto`, `--permission-mode <mode>` | Start in an [approval mode](../guides/permission-modes.md). |
| `--deny-tools <a,b>` | Withhold named tools from the session entirely. |
| `-p`, `--print <prompt>` | Run one agent turn and exit; `--events-file <path>` appends an NDJSON transcript. |
| `--name <name>` | Join the agent bus under this name (see [Delegation](delegation.md)). |

**Sessions.** Every conversation is a JSONL transcript stored per project in your keryx data directory. `/sessions` and `/resume` switch between them, `/new` starts a clean one, `/compact` shrinks the model context while keeping the full archive, and `keryx sessions list|fork <id>|export <id>|path` works from outside the shell. A session open in another shell is refused unless you fork it or take it over from a stale holder. `/status` shows the session identity, context window and limits.

**Rewind.** Before the first tool call of a turn that can change something, the shell snapshots your work tree into a shadow repository that never touches your own `.git`. `/rewind` restores files, the conversation or both to before any recent turn, with a confirmation. It covers the project work tree only; side effects of shell commands elsewhere are not undone. See [Undo a turn](../guides/rewind.md).

**Approval modes.** `ask` (default) asks before each shell command, subagent spawn or destructive call. `trust` runs safe calls without asking and still asks for destructive ones. `auto` asks for nothing except a command that touches keryx's own credential files, and entering it always needs a confirmation. `/mode` switches for the session or saves a project default. `/plan on` is a separate read-only switch that refuses every non-read tool outright. See [Choose an approval mode](../guides/permission-modes.md).

**Settings and themes.** `/settings` opens one modal with every setting-like command in four groups (Safety, Routing, Display, External), each row showing its value and whether it lasts for the session or is saved. `/theme` picks one of twelve built-in themes; `/reasoning` and `/think` control reasoning effort and how reasoning is shown.

**Goals.** `/goal <text>` opens the work deliberately instead of waiting for the shell to infer it. Add `--auto [N]` to let it continue for up to N rounds (default 8) against a flow with a recorded acceptance criterion. See [/goal](../guides/goal.md).

### Slash commands

Type `/help` for the grouped list inside the shell, or run `keryx help` outside it. These are the commands the shell registers:

| Group | Commands |
|---|---|
| Session | `/sessions` `/resume` `/new` `/clear` `/compact` `/rewind` `/copy` `/expand` `/status` `/queue` `/interrupt` `/exit` `/quit` |
| Models and providers | `/connect` `/provider` `/model` `/models` `/routing` `/search-provider` `/search-connect` `/external` |
| Look and feel | `/theme` `/settings` `/mode` `/plan` `/think` `/reasoning` |
| Project work | `/flows` `/ac` `/goal` `/review` `/guard` `/route` `/triggers` `/schedule` `/schedules` `/governance` `/product` `/reviews` `/approvals` |
| Review checks | `/ci` `/conform` `/risk` `/scenarios` `/jevrules` `/staledocs` `/opencomments` `/contract` `/triage` `/editguard` `/jevprofile` |
| Agents and tools | `/delegate` `/external-agents` `/external-diff` `/demote` `/mcp` `/integrate` `/bus` `/workspace` |
| Diagnostics | `/help` `/doctor` `/setup` `/game` |

While a turn runs, `/interrupt` stops it and `/queue` manages prompts you typed in the meantime.

## Common tasks

| I want to… | Command or page |
|---|---|
| Add or switch a provider | `/provider`, `/connect`; [Connect a model provider](../guides/connect-a-provider.md) |
| Run fully local | [Use a local model](../guides/use-a-local-model.md) |
| Continue yesterday's work | `keryx shell -c`, or `/resume` |
| Run one turn from a script | `keryx shell --print "<prompt>" --events-file run.ndjson` |
| Loosen or tighten approvals | `/mode`, [Choose an approval mode](../guides/permission-modes.md) |
| Undo the last turn | `/rewind`, [Undo a turn](../guides/rewind.md) |
| Keep an agent from editing | `/plan on` |
| Let the agent search the web | [Agent web search](../guides/web-search.md) |

## Status

Stable. The terminal interface depends on an optional package; if it is missing, or you pass `--no-tui`, the readline shell offers the same commands as text. Windows is not verified; see [Project status](../project/status.md) and [Limitations](../limitations.md).

## Reference

- CLI: [shell](../cli-reference.md#shell), [sessions](../cli-reference.md#sessions), [shell behavior](../cli-reference.md#shell-behavior)
- Module reference: [sessions and shell](../modules.md#sessions-shell)
- Guides: [Choose an approval mode](../guides/permission-modes.md), [Undo a turn](../guides/rewind.md), [/goal](../guides/goal.md), [Commands by task](../commands-by-task.md)
