# Changelog

Keryx records every release in
[CHANGELOG.md](https://github.com/MrCipherSmith/keryx/blob/main/CHANGELOG.md),
one section per version, newest first. This page picks out the user-facing
highlights of the 0.3.x series, which started on 25 September 2026. Releases
are frequent and small, so most versions contain a single fix or feature.

## Highlights of 0.3.x

- **Keryx no longer edits files your team tracks** (0.3.45, 0.3.47). `keryx
  init` and `keryx update` write the routing block, the ignore rules and agent
  hooks into per-developer files (`CLAUDE.local.md`, `AGENTS.override.md`,
  `.claude/settings.local.json`, `.git/info/exclude`). One `keryx update`
  migrates an existing project. See
  [Workspace and lifecycle](../workspace-and-lifecycle.md#versioned-vs-gitignored).
- **Portability, stack packs and a self-learning loop** (0.3.0). `keryx bundle`
  exports and imports skills, rules, agents, memory and hooks; stack packs are
  promoted only through a strict evaluation; `keryx learn` proposes lessons from
  redacted session observations and applies nothing without your consent. See
  [Skills, rules and learning](../modules/skills-and-learning.md).
- **One registry for agent integrations** (0.3.0). `keryx integrations install,
  doctor and matrix` install, audit and list the hooks and instructions Keryx
  places in each supported coding agent. See
  [Connect your agents](../modules/integrations.md).
- **External agent CLIs as workers** (0.3.26 to 0.3.44). `keryx agents external
  run` drives an installed agent CLI. With `--write`, it works in a throwaway git
  worktree, and the result lands only after you read the diff with `keryx agents
  external review` and run `apply`. `keryx agents external enable` turns the
  capability on. See [Let an external agent write](../guides/external-agent-write.md).
- **Undo a turn** (0.3.37). `/rewind` in the shell restores the files and the
  conversation to the state before a turn. See [Undo a turn](../guides/rewind.md).
- **Review as a pull request bot** (0.3.38). `keryx review bot run` reviews a
  pull request diff with a verifier pass per finding, and `keryx review metrics`
  reports how findings were acted on. See
  [Review as a pull request bot](../guides/review-as-a-pr-bot.md).
- **Additional reviewers from a review service** (0.3.1 to 0.3.7). Optional,
  advisory checks for rules, risk, user scenarios, stale docs, open comments and
  whether a pull request does what it says. See
  [Review service in the delivery loop](../guides/jev-in-the-delivery-loop.md).
- **Keep private work in-house** (0.3.11). `keryx external on` and `/external on`
  stop code, diffs and prompts from being sent to the providers on a block list.
  See [Keep private work in-house](../guides/keep-private-work-in-house.md).
- **Remote approvals and remote control** (0.3.39, 0.3.48, 0.3.49). A call
  waiting in a remote turn becomes a pending approval you answer with `keryx
  approvals`, and a shell session can be mirrored into a chat topic. See
  [Answer a remote approval](../guides/answer-remote-approvals.md) and
  [Automation and remote control](../modules/automation.md).
- **Safer MCP tool trust** (0.3.27, 0.3.35). You can trust one MCP tool for the
  rest of a session; the grant is bound to the tool's definition, can be listed
  and revoked, and is never offered for a tool marked destructive. See
  [MCP servers in the shell](../modules/mcp-servers.md).
- **Verifiable acceptance criteria** (0.3.29 to 0.3.33). A criterion can declare
  how it is verified, `keryx flow ac kinds` reports the mix, and `keryx product
  open` lists finished work whose outcome nobody has checked yet. See
  [Managed work](../modules/managed-work.md).
- **Diagnostics and settings** (0.3.17, 0.3.46). `keryx doctor` checks version,
  Bun, ripgrep, sandbox, providers, MCP, integrations and freshness in one pass,
  and `/settings` gathers the shell's settings on one screen. Security fixes
  across 0.3.15 to 0.3.21 stop external agents inheriting your credentials and
  redact more secret shapes before anything leaves the machine.

## Reading the full changelog

Each version section is split into Added, Changed, Fixed, Security, Migration
and Notes. Notes state known limits of that release, for example which runtime
versions a feature was verified against. When you upgrade across several
versions, read the Migration entries in between; `keryx update --preview` shows
what an update would change in your project before it runs.
