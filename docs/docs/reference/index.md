# Reference overview

The reference pages list every command, flag, file and environment variable. This page shows how to find the one you need, fast, from the terminal or from the site.

## Find a command from the terminal

`keryx help` prints every command grouped by task instead of one alphabetical list. The groups are Start here, Connect a model provider, Look and feel, Working in keryx shell, Project knowledge, Managed work, Automation, External agents, ACP and MCP, and Maintenance and diagnostics. Each group lists the CLI verbs first and the matching `keryx shell` slash commands after them.

```bash
keryx help                    # every group
keryx help project-knowledge  # one group
keryx help flow               # one command's full usage
keryx help /theme             # one shell command's detail
```

```text
Project knowledge:
  gdgraph  Build and query the code dependency graph.
  ctx      Run compact context commands and save raw output.
  wiki     Manage the local project knowledge base.
  memory   Store and search long-term project memory.
…
```

A group, a CLI verb and a shell command all work as the argument. An unknown topic prints `Unknown help topic` and points back to `keryx help`.

Every command group also answers `--help`. The usage block lists each subcommand with its flags, and the verbs with subcommands print their own vocabulary:

```bash
keryx flow --help
keryx workspace --help
keryx trigger --help
```

`keryx --help`, `-h` and bare `keryx` print the flat usage block instead of the grouped one.

## Find a command by intent

`keryx commands` prints the command registry that agents read: every command with a summary, the phrases that should lead to it, its arguments and its output shape.

```bash
keryx commands --intent "export agent definition"
keryx commands --module health --json
keryx commands --intents
```

```text
keryx agents export — Compile and write (or preview with --dry-run) one agent definition for one export runtime.
```

`--intent "<phrase>"` resolves a phrase to the best matching command, `--module <name>` filters, `--json` gives the stable machine-readable form, and `--intents` prints the whole phrase table. Inside `keryx shell`, `/help` opens the same grouping as a tabbed modal. The `workspace` verb is deliberately absent from `keryx commands`; it is experimental (see [Shared Agent Context](../modules/shared-agent-context.md)).

## The reference pages

| Page | Use it for |
|---|---|
| [CLI reference](../cli-reference.md) | Every verb, subcommand and flag, with exit codes and behaviour. |
| [Commands by task](../commands-by-task.md) | The same grouping as `keryx help`, as a table of every CLI verb and shell command. |
| [Module reference](../modules.md) | What each module reads and writes, its key files and how it works. |
| [Configuration and environment](configuration.md) | Every config file and environment variable keryx reads. |
| [Workspace and lifecycle](../workspace-and-lifecycle.md) | The `.metaproject/` tree, what `init` and `update` own, and the managed git hooks. |
| [Integrations and adapters](../integrations.md) | Which agent harnesses keryx can wire into, and which surfaces each supports. |
| [Lifecycle hooks](../hooks.md) | The `keryx shell` hook runtime: events, outcomes, built-in hooks and config. |

## Reference or guide

Reach for a reference page when you know what you want and need the exact spelling. Reach for a [module page](../modules/project-knowledge.md) when you want to know what an area is for, and for a guide under Guides when you have a task to finish.
