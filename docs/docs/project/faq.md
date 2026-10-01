# FAQ

Short answers to the questions people ask first. Each answer links to the page
with the details.

## What is Keryx?

A command-line tool that gives AI coding agents, and the people working with
them, a shared project workspace. `keryx init` creates a `.metaproject/`
directory in your repository holding a code graph, a wiki, memory, rules,
skills and managed work records called flows. Keryx also includes its own
agent shell, `keryx shell`. Start with [Keryx in five minutes](../getting-started/concepts.md).

## Do I need a model or an API key?

No, not for the core. The default modules (code graph, compact command output,
wiki index, skills, health, testing, memory, flows and security scanning) are
deterministic and run without a model. You need a provider only for commands
that call one: `keryx shell`, wiki enrichment, model-suggested flow plans and
model-backed reviews. See [Connect a model provider](../guides/connect-a-provider.md).

## Does my code leave my machine?

Only when you use a feature that calls a model, and only to the provider you
chose. The shell sends your prompts and the tool results it needs to that
provider. If you run a local model, nothing goes to a remote provider; see
[Use a local model](../guides/use-a-local-model.md).

Two controls limit what goes out:

- `keryx external on` (or `/external on` in the shell) blocks sending code,
  diffs, CI logs and prompts to the providers and models on a block list. See
  [Keep private work in-house](../guides/keep-private-work-in-house.md).
- Outgoing web requests made by the agent refuse content that looks like a
  secret, and redaction runs on what is shown and stored. See
  [Security model](../concepts/security-model.md).

Features that send work to another service, such as external agent CLIs, the
MCP server and the remote HTTP entry, are off until you enable them.

## Does Keryx collect telemetry?

No. Keryx has no analytics or usage reporting. The one request it makes on its
own is a version check: `keryx doctor`, `keryx version check` and the start of
`keryx shell` send a `GET` to the npm registry for the latest
`@mrciphersmith/keryx` version. The request carries no credentials and no
project data, times out after two seconds, and its result is cached for
24 hours in your per-user Keryx directory.

## Which coding agents does it work with?

Keryx installs hooks and instructions into these agents with
`keryx integrations install --runtime <id>`. The confidence column comes from
`keryx integrations matrix`.

| Agent | Runtime id | Confidence |
|---|---|---|
| Claude Code | `claude` | verified |
| Codex | `codex` | verified |
| Cursor | `cursor` | verified |
| Windsurf | `windsurf` | verified |
| Antigravity | `antigravity` | experimental |
| opencode | `opencode` | experimental |
| Zed | `zed` | experimental |
| Any MCP client | `generic-mcp` | experimental |
| Gemini CLI | `gemini-cli` | experimental |
| Kiro | `kiro` | experimental |
| GitHub Copilot agent | `github-copilot-agent` | experimental |

Keryx can also act as an agent for editors that speak the Agent Client Protocol
(`keryx acp`), and it can run some agent CLIs as workers. See
[Connect your agents](../modules/integrations.md) and
[Delegation](../modules/delegation.md).

## Which model providers are supported?

The provider ids accepted by `keryx harness run --provider` are `anthropic`,
`openai`, `gemini`, `ollama`, `openrouter`, `deepseek`, `zai`, `zai-coding`,
`cerebras`, `groq`, `rapid-mlx`, `moonshot`, `grok` and `github-copilot`, plus
`fake` for tests. The shell also signs in to some subscriptions. See
[Models and providers](../modules/providers.md).

## What does it cost?

Keryx is free and MIT-licensed. If you use a hosted model, you pay that
provider for the tokens. `keryx routing stats` shows measured cost per provider,
model and kind of task, so you can route cheaper work to cheaper models.

## Does it run on Windows?

It is unverified. Keryx is developed and tested on macOS and Linux; the core
CLI is not run in CI on Windows, no standalone Windows binary is published, and
the OS sandbox is macOS and Linux only. Use WSL. See
[Project status](status.md#platforms).

## How is this different from using an agent on its own?

An agent session starts from what it can read in that session and forgets it
afterwards. Keryx keeps the project's knowledge in files the next session, the
next agent and the next person can read: a dependency graph to answer "what
breaks if I change this", a wiki tied to the code it describes, lessons from
past mistakes, and flows whose acceptance criteria were frozen before work
started and confirmed with evidence before it was called done. Keryx does not
replace your agent; it gives it, and you, that record. See
[The Metaproject](../concepts/metaproject.md).

## What gets committed to my repository?

The agent-facing context in `.metaproject/`: the routing index, wiki, memory,
rules, skills, flows and the `metaproject.json` manifest. Caches, raw logs,
runtime state and security artifacts are ignored. Keryx writes its ignore rules
to `.git/info/exclude`, which is never committed. Whether you commit
`.metaproject/` at all is your choice. See
[Versioned vs gitignored](../workspace-and-lifecycle.md#versioned-vs-gitignored).

## Will it change files my team shares?

Not by default. Since 0.3.45 the routing block and agent hooks go to
per-developer files (`CLAUDE.local.md`, `AGENTS.override.md`,
`.claude/settings.local.json`) that are excluded from git, and `AGENTS.md`,
`CLAUDE.md` and `.gitignore` are left alone. You can choose shared scope per
runtime. `keryx init --preview` lists what a run would change. See
[Agent entrypoints](../workspace-and-lifecycle.md#agent-entrypoints-and-the-managed-routing-block).

## How do I uninstall it?

There is no single uninstall command. In each project:

```bash
keryx integrations uninstall --runtime all
keryx ctx uninstall-hook --runtime all
```

Then remove the `# keryx:…:begin` to `:end` blocks from `.git/hooks/post-commit`
and `.git/hooks/pre-push`, the `# keryx:begin` to `# keryx:end` block from
`.git/info/exclude`, the per-developer files listed above, and `.metaproject/`
if you no longer want it. Finally remove the program:

```bash
npm uninstall -g @mrciphersmith/keryx
```

For the standalone binary, delete `~/.local/bin/keryx`. Per-user settings and
sessions live in `~/.local/share/keryx` on macOS and Linux, and in
`%APPDATA%\keryx` on Windows. See [Git hooks](../workspace-and-lifecycle.md#git-hooks).

## Is it ready for production use?

It is pre-1.0. The default modules, the shell, providers, flows and review
packages are treated as stable: tested, documented, and changed only with a
changelog entry. Some parts are experimental, and commands or file formats can
still change between minor versions. See [Project status](status.md).

## Where do I ask a question or report a bug?

Use the issue forms on GitHub. Report security problems privately, never in a
public issue. See [Contributing and support](contributing.md).
