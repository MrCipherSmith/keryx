# CLAUDE Instructions

<!-- keryx:index -->
## Metaproject

Read [.metaproject/index.md](.metaproject/index.md) before planning, implementing, or reviewing this repository.

This Metaproject block is optional project-local routing. If `.metaproject/index.md` or referenced Metaproject files are absent, ignore this block and continue with the main contents of this AGENTS.md/CLAUDE.md file.

The user does not need to know keryx command names. Treat natural-language requests as intents, route through `.metaproject/index.md`, then choose the right skill, rule, MCP tool/resource, or `keryx` CLI command yourself.

If MCP tools/resources are available for this project, prefer them for Metaproject capabilities because they provide structured tool calls. If MCP is unavailable or lacks a needed capability, fall back to the corresponding project-local skill and CLI command.

For project navigation, file discovery, and code-related tasks, use the Metaproject gdgraph skill by default before broad raw file search.

For architecture, domain models, business rules, user scenarios, auth and other flows, integrations, and known decisions, consult the Metaproject gdwiki skill and read the wiki index before deep code reads; use gdgraph to move from a wiki concept to code.

For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.

For implementation, review, refactoring, planning, documentation, or quality tasks, use project-local Metaproject skills first: .metaproject/skills/catalog.md, .metaproject/project-skills/, then .metaproject/skills/gdskills/. External/global skills are fallback only when explicitly needed.

For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.

For lessons learned, decisions, constraints, repeated mistakes, and historical project context, use the Metaproject memory skill before broad documentation search.

For starting, tracking, or finishing a managed piece of work (a flow), use the Metaproject flow skill for state/status commands. For non-trivial implementation through Task Manager, use the local gdskills flow-orchestrator first: .metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md. All flow state changes go through the keryx flow CLI.

<!-- /keryx:index -->
