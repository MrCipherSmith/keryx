---
name: agent-entrypoint-distiller
description: Use when the user asks to split, decompose, distill, or refactor a large AGENTS.md or CLAUDE.md into Metaproject rules and project-specific skills while keeping root entrypoints compact.
metadata:
  version: "1.0.0"
  category: platform
---

<!-- keryx:execution-metrics:begin -->
## Execution Metrics (user-direct opt-in)

When this skill is invoked directly by a user, before task work:

1. Read `.metaproject/rules/core/execution-metrics.md`.
2. Ask exactly: **Collect execution statistics for this run? (yes / no)**
3. Wait for the answer. If yes, follow the rule's reporting and persistence contract; if no, continue normally.

When dispatched as a subagent, do not ask and do not emit a separate report. The top-level caller owns metrics.
<!-- keryx:execution-metrics:end -->

# Agent Entrypoint Distiller

Use this skill when root agent files (`AGENTS.md`, `CLAUDE.md`) have grown into
large project manuals and should be converted into local Metaproject knowledge.

## Workflow

1. Read `.metaproject/index.md` and `.metaproject/metaproject.json` if they exist.
2. Run:

```bash
keryx rules distill
```

3. Verify the generated outputs:
   - `.metaproject/rules/entrypoints/index.md`
   - `.metaproject/rules/entrypoints/*.md`
   - `.metaproject/project-skills/entrypoints/*/SKILL.md`
   - compact `AGENTS.md` and `CLAUDE.md` still point to `.metaproject/index.md`
4. If the command changed root entrypoints, check that only global/personal or
   highest-priority always-on instructions remain there.
5. Run focused verification:

```bash
keryx rules sync
keryx flow check 001
```

Skip `flow check` when the project has no Task Manager flow.

## Output Contract

Report:

- rules extracted count;
- skills extracted count;
- root sections kept count;
- files changed;
- any sections that looked ambiguous and should be reviewed manually.
