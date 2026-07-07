# Metaproject Agent Protocol

Version: 0.1.1

## 1. Purpose

The agent protocol tells coding agents how to discover and use a Metaproject
without loading the full project context.

## 2. Discovery Sequence

An agent should:

1. Check whether `.metaproject/metaproject.json` exists.
2. Parse `standardVersion`, `profiles`, `paths` and `modules`.
3. Read `.metaproject/index.md`.
4. Select only relevant module manifests from `.metaproject/modules/`.
5. Load the smallest relevant skill or rule.
6. Use module commands/artifacts before broad raw file reads.

## 3. Routing Rules

For project navigation, file discovery, code understanding, implementation,
review, debugging or refactoring:

1. Prefer `gdgraph` artifacts/commands when enabled and fresh enough.
2. Use `gdctx` for large command output, raw logs, diffs and long files.
3. Use `gdwiki` and `memory` for conceptual, historical, domain or decision
   context before scanning source broadly.
4. Use `health` and `testing` latest reports before rerunning expensive checks.
5. Use `project-skills` for entity/component/domain-specific generation or
   refactoring patterns.
6. Use `security` before writing memory/wiki/report artifacts or publishing
   external-facing output that may contain secrets, PII or untrusted
   instructions.

## 4. Root Entrypoints

Root `AGENTS.md`, `CLAUDE.md` or equivalent files should be short and include a
strict pointer:

```markdown
Before planning, editing or reviewing this repository, read
`.metaproject/index.md` and use the enabled Metaproject modules for discovery.
```

Detailed project rules should move into `.metaproject/rules/`. Procedural
workflows should move into `.metaproject/skills/` or
`.metaproject/project-skills/`.

## 5. Failure Handling

If a declared module is missing or stale, the agent should:

- report the missing/stale module briefly;
- use the next available module or normal repository tools;
- avoid rebuilding expensive artifacts unless the user asked for it or the
  module skill explicitly allows it;
- record unavailable context in final output when it materially affects
  confidence.

## 6. Token Policy

Agents should prefer:

- manifests and indexes before raw files;
- summaries before raw logs;
- graph affected context before broad search;
- latest reports before historical directories;
- project-skills before copying patterns from many files.
