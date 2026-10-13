# Delegation

Delegation hands a bounded piece of work to another agent: a named subagent from Keryx's own catalog, or an external agent CLI that Keryx launches under its policy. The result comes back as a structured document or a diff you review, so a second agent never changes your repository on its own authority.

## When to use it

- You want a narrow, repeatable role, such as a read-only code auditor or a build fixer, that the main agent can dispatch by name.
- You want another vendor's agent CLI to attempt a task in a throwaway worktree and give you a diff, not a changed checkout.
- You want Keryx to drive an external ACP agent and answer its permission questions with Keryx's own policy.
- Several agents work in worktrees of one clone, and you need them to see each other, exchange messages or pause one another.
- An external agent should open a scratchpad of its own and propose what it learned.

## Quick example

Read the catalog, turn on the external agent capability, and list what Keryx can launch. Run it in a scratch repository, because `enable` writes your user config. If `enable` reports that the project manifest has no `gdskills.external-agents` entry, run `keryx update` first.

```bash
keryx agents list --stack go
keryx agents external enable
keryx agents external list --no-probe
```

```text
go-build-fixer  [standard/workspace-write]  (bundled)
    Reproduces and fixes a Go build, lint, type-check, or test failure with the smallest root-cause change, isolated in a worktree. …
go-code-auditor  [deep/read-only]  (bundled)
    Reviews Go code, read-only, for the 6 stack-specific risk patterns …

user config: externalAgents.enabled already true
project manifest: gdskills.external-agents set to enabled: true
external agents: on

# agents external

capability: enabled

  ? codex-cli  …
      not probed — run `keryx agents external probe codex-cli`
      transport: line-stream  sandbox: read-only, worktree-write  streaming: false  resumable: true  reports cost: false
  ? gemini-acp  …
      transport: acp  sandbox: read-only, worktree-write  streaming: false  resumable: false  reports cost: false
…
```

A write run then goes through `run`, `review` and `apply`:

```bash
keryx agents external probe claude-cli
keryx agents external run claude-cli --task "Add a --json flag to the status command" --write
keryx agents external review <run-id>
keryx agents external apply <run-id>
```

## How it works

**Subagent catalog.** `keryx agents list`, `show`, `export` and `verify` work on a catalog of named definitions: description, model tier (`light`, `standard`, `deep`), policy profile (`read-only` or `workspace-write`), tools and an output contract. A project can add its own under `.metaproject/agents/<name>.md`, and a project definition overrides a bundled one with the same name. `export` writes a definition into a runtime's own agent format (`claude`, `codex`, `kiro`, `opencode` or `keryx-shell`). See [Name a subagent](../guides/agent-catalog.md).

**External agents.** `keryx agents external` launches a vendor agent CLI as a child. The capability is off until you run `enable` (`disable` turns it off), and it is hard-disabled in CI and under a remote transport. Four agents are registered: `codex-cli`, `claude-cli` and `antigravity-cli` over a one-way line stream, and `gemini-acp` over ACP. `probe` checks that the binary runs and reports its version; it does not read any vendor credential. Every run is a Keryx session, and the agent must end with a structured `subagent-result` document, or the run ends as an error.

**Reviewed writes.** Only `claude-cli` and `codex-cli` can write, and only with `--write`. The agent works in a throwaway git worktree and its diff is stored as a pending review. `review` shows the run, flagged paths first, then the redacted patch. `apply` needs a real terminal and asks you to type the first 12 hex digits of the patch hash, then publishes a new local branch `external/<run-id>`. It never touches your current branch, pushes or opens a pull request. `discard` deletes the stored patch. See [Let an external agent write](../guides/external-agent-write.md).

**ACP client.** With `gemini-acp`, Keryx is the ACP client. It advertises only the capabilities it serves, serves every file request itself, confined to the worktree, and answers each permission request through its own approval gate. An unattended run refuses anything that needs you. An agent's own internal tools never pass through ACP, so Keryx cannot gate them; the disposable worktree is what contains them. See [Drive a foreign ACP agent](../guides/acp-client.md).

**Bus and slate.** `keryx bus` is a shared channel for the worktrees of one clone: `list` shows live peers, `log` and `send` read and write messages (`@name` or `@all`), and `pause` and `resume` issue and end pause leases with a reason and a time limit. Slate lets an MCP-connected external agent open a scratchpad scoped to its own session id, write draft seeds and close it into the shared review pipeline. See [Slate for external agents](../guides/slate.md).

## Common tasks

| I want to… | Command or page |
|---|---|
| List the bundled and project subagents | `keryx agents list [--stack <id>]` |
| Export a subagent to another runtime | `keryx agents export --runtime <id> <name> --dry-run` |
| Check catalog definitions | `keryx agents verify [<name>]` |
| Turn external agents on or off | `keryx agents external enable` / `disable` |
| See which external agents are usable | `keryx agents external list`, `probe <id>` |
| Run an agent read-only | `keryx agents external run <id> --task "<text>"` |
| Let an agent write, then review the diff | [Let an external agent write](../guides/external-agent-write.md) |
| Drive an ACP agent | [Drive a foreign ACP agent](../guides/acp-client.md) |
| Run without a person present | add `--unattended` to `run` |
| Message or pause other worktrees' agents | `keryx bus send @name "<text>"`, `keryx bus pause @name --reason "<why>"` |
| Give an external agent a scratchpad | [Slate for external agents](../guides/slate.md) |
| Watch a subagent fleet | `keryx agents monitor <events-file>` |

## Status

External agents and reviewed writes are opt-in and off by default. They have a short record of live write runs, so read every diff, and `antigravity-cli` refuses `--write`. The subagent catalog, agent bus and slate are available in every project. Check [Limitations](../limitations.md) before relying on a platform-specific behaviour.

## Reference

- CLI reference: [agents](../cli-reference.md#agents), [bus](../cli-reference.md#bus), [sessions](../cli-reference.md#sessions)
- Guides: [Name a subagent](../guides/agent-catalog.md), [Let an external agent write](../guides/external-agent-write.md), [Drive a foreign ACP agent](../guides/acp-client.md), [Slate for external agents](../guides/slate.md), [Run an agent without your machine](../guides/contain-an-agent.md)
- [The agent harness](../harness.md#external-children-a-vendor-cli-as-a-child-agent)
