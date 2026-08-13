// SAC (Shared Agent Context) module manifest + skill templates. Mirrors the
// shape of src/wiki/templates.ts (renderGdwikiManifest / renderGdwikiSkillReadme)
// so `sac` reads as a real Metaproject module for both humans (the manifest
// doc) and agents (the routing skill), even though it is opt-in/off-by-default
// like `mcp`.

export function renderSacManifest(): string {
  return `# sac

Version: 0.1.0

## Purpose

Shared Agent Context (SAC): durable, evidence-backed, reviewer-curated project
context — Facts, Work, and Know-how — shared across workspaces, sessions, and
agents. SAC content only becomes readable context after a human reviewer
accepts a proposal; it is not a free-write scratchpad.

This is distinct from the other two "project memory" surfaces:

- **Memory** (\`modules/memory.md\`) — any agent can write freely; pure recall.
- **Wiki** (\`modules/gdwiki.md\`) — architecture and domain knowledge, curated
  by whoever edits the page.
- **SAC** (this module) — a workspace-scoped propose/review pipeline. An agent
  proposes an outcome; nothing becomes durable context until a reviewer
  accepts it.

## Commands

All commands are under \`keryx workspace <subcommand>\` (the module key is
\`sac\`; the CLI namespace is \`workspace\`):

- \`keryx workspace create --title <title>\`
- \`keryx workspace list\`
- \`keryx workspace show <workspace-id>\`
- \`keryx workspace overview <workspace-id> [--max-items N] [--max-tokens N]\`
- \`keryx workspace read <workspace-id> <item-id> [--max-items N] [--max-tokens N]\`
- \`keryx workspace propose <workspace-id> --kind <kind> --session <session-id> [--note <note>]\`
- \`keryx workspace review <workspace-id> <proposal-id> --decision <accepted|rejected|dismissed>\`
- \`keryx workspace collaboration <workspace-id>\`
- \`keryx workspace policy-readiness\`

There is no session-to-workspace linkage: every call above needs an explicit
\`workspaceId\`. Discover ids with \`keryx workspace list\`.

## Data

- \`.metaproject/workspaces/\` — workspace state (created lazily by
  \`WorkspaceService\` on first \`workspace create\`).
- \`.metaproject/context-operations/\` — proposal/review evidence (created
  lazily by \`FwkReadService\`/the proposal lifecycle service).

## Entry

- \`keryx workspace list\`

## Skills

- \`skills/sac/\`
`;
}

export function renderSacSkillReadme(): string {
  return `---
name: sac
description: Use for durable, reviewer-accepted cross-session project context (Shared Agent Context) - read what the team already knows/decided (workspace overview/read), or propose this session's outcome for a reviewer to accept (workspace propose). Opt-in module; not installed unless enabled.
---

# sac Skill

Shared Agent Context (SAC) is a workspace-scoped propose/review pipeline for
durable project context: Facts, Work, and Know-how that should persist across
sessions and agents, but only after a human reviewer accepts it. Nothing an
agent proposes becomes readable context until it is accepted.

## Routing (which skill first)

- "What does the team already know / already decided about X that's been
  reviewed and accepted?" — **use sac**: \`keryx workspace overview <id>\` then
  \`keryx workspace read <id> <item-id>\`.
- "Record this session's outcome for a reviewer to accept into durable
  context." — **use sac**: \`keryx workspace propose <id> --kind <kind>
  --session <session-id>\`.
- The agent's own scratch notes, working assumptions, or free-write recall —
  that is **memory**, not sac (see \`skills/memory/SKILL.md\`).
- Architecture, domain models, or business-rule prose — that is **wiki**, not
  sac (see \`skills/gdwiki/SKILL.md\`).

## Trigger Examples

- "What has already been decided about the auth refactor?"
- "Is there reviewed context on why we chose this retry strategy?"
- "Propose this session's finding for review."
- "Show me the accepted facts for this workspace."

## Workflow

1. Discover the workspace id: \`keryx workspace list\` (there is no
   session-to-workspace linkage — every command below needs an explicit
   \`workspaceId\`).
2. To read: \`keryx workspace overview <workspace-id>\` for a budgeted index of
   accepted items, then \`keryx workspace read <workspace-id> <item-id>\` for
   one specific item (a fact, a know-how entry, or a piece of work).
3. To write: \`keryx workspace propose <workspace-id> --kind <kind> --session
   <session-id> [--note <note>]\`, where \`<kind>\` is one of \`decision\`,
   \`wiki-update\`, \`memory-entry\`, \`follow-up\`, \`contract-change\`, \`risk\`.
   The proposal is inert until a reviewer runs \`keryx workspace review
   <workspace-id> <proposal-id> --decision <accepted|rejected|dismissed>\`.
4. \`keryx workspace collaboration <workspace-id>\` shows cross-session
   collaboration state for the workspace; \`keryx workspace policy-readiness\`
   checks whether the local policy/authorization setup is ready for
   propose/review.

## Working inside \`keryx shell\`

When working live inside keryx's own agent shell, prefer the native
\`workspace_overview\` / \`workspace_read\` tools
(\`src/harness/tool/builtin/workspace-context-tool.ts\`) over the CLI — same
data, no subprocess. This skill file exists for agents working through the
Metaproject CLI/routing generally (Claude Code, Codex, or any agent reading
\`.metaproject/index.md\`), which includes \`keryx shell\` itself, since it also
reads this routing.

## Skip When

- The task is the agent's own scratch notes or working recall — use memory.
- The task is architecture/domain/business-rule prose — use wiki.
- \`keryx workspace\` is unavailable (module not enabled) — check
  \`.metaproject/modules/sac.md\` exists before assuming this module is on;
  it is opt-in and off by default.

## Reporting

When sac context is used, mention which workspace id and item(s) were read
or proposed. For non-trivial tasks, record \`sac_used: workspace+items /
not-relevant / unavailable\` alongside the routing audit (see the gdgraph
skill's Reporting section).
`;
}
