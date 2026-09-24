# W2: agent definitions compiled into dispatch contracts, per-harness exporters, initial generic agent catalog

Status: formalized
Source: docs/requirements/keryx-agent-platform-expansion/workstreams/W2-agent-catalog.md (Wave 2 slice)
Base branch: feat/agent-platform-expansion (owner MrCipherSmith)

## Problem

Keryx has a tested multi-agent execution substrate (`spawn_subagent`, child
contract, tier resolution, budget ledger, quarantine) but no reusable, named
agent persona catalogue. Every "who is this agent" is inline prose written into
`spawn_subagent.task` by whichever skill dispatches it; nothing can be listed,
reviewed, reused across orchestrators, or exported to a host harness's own
subagent file.

## Expected Outcome

- A canonical `.metaproject/agents/<name>.md` format (YAML frontmatter + body)
  validated against `schemas/agent-definition.schema.json`.
- One deterministic compiler (`compileAgentDefinition`) that is the only
  producer of: keryx-shell `spawn_subagent` inputs (exact inputSchema key set,
  tier passed through, never a model name) and host-native export files, with
  one shared prompt-defense baseline constant injected by the compiler.
- Exporters for Claude Code, Codex, Kiro, OpenCode and keryx-shell whose support
  level is looked up from the W5 registry/matrix (`agents` surfaces added where
  first-party docs support them; matrix artifact regenerated); unverified
  runtimes get instruction-only output.
- `keryx agents list|show|export|verify` alongside the unchanged
  `bootstrap|external|monitor`.
- Ten bundled generic definitions (architect, planner, code-explorer,
  tdd-guide, refactor-cleaner, silent-failure-hunter, doc-updater,
  security-reviewer, performance-reviewer, e2e-runner), every one passing
  `keryx agents verify`, every exported output scanned clean by
  `keryx security audit-harness`.
- D-2 recorded: the multi-agent-engine non-goal is revised (not reversed).

## Out of Scope

- Per-stack generated reviewer/build-error-resolver pairs (Wave 4; needs W1
  gate-cleared packs). Only the `origin.sourceRef` verification path ships.
- Any change to `spawn_subagent`'s inputSchema, the child contract, policy
  engine or budget caps (D-2).
- W1 stack/skills-install code and `install-manifest.schema.json` (W1 owns).
- keryx-shell row of the capability matrix (W6 registers keryx-shell surfaces).
- Automatic routing of which agent to dispatch.
