---
name: claude-md-management
description: "Use when saving session learnings, coding patterns, conventions, or commands discovered during work into CLAUDE.md files. NOT for: breaking an oversized entrypoint apart into Metaproject rules and skills (use agent-entrypoint-distiller)."
triggers:
  - "CLAUDE.md management"
  - "agent entrypoint"
  - "Update claude md"
  - "Save learnings"
  - "Update project instructions"
  - "Add to CLAUDE.md"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "platform"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# CLAUDE.md Management

Capture session insights and persist them into the appropriate CLAUDE.md file.

## Arguments

- `/revise-claude-md` — analyze session and propose updates
- `/revise-claude-md "specific thing"` — add a specific entry
- `/revise-claude-md --auto` — apply without asking (for pipelines)

## Workflow

### Step 1: Collect Session Insights
Analyze the current conversation for:
- Coding patterns discovered or established
- Project conventions learned (naming, structure, testing)
- Build/deploy commands that work
- Gotchas and pitfalls encountered
- Architecture decisions made
- Tool configurations set up

### Step 2: Read Current CLAUDE.md Files
1. Project-level: `<project-root>/CLAUDE.md`
2. User-level: `~/.claude/CLAUDE.md`
3. Project-specific user-level: `~/.claude/projects/<project-path>/CLAUDE.md`

### Step 3: Classify Each Insight

| Type | Target |
|------|--------|
| Project conventions, build commands | `<project>/CLAUDE.md` |
| Global preferences, workflow rules | `~/.claude/CLAUDE.md` |
| Project-specific personal notes | `~/.claude/projects/<path>/CLAUDE.md` |

### Step 4: Propose Changes
Present diff preview:
```
📝 Proposed CLAUDE.md updates:

[project] CLAUDE.md:
+ ## Build Commands
+ - `npm run dev` — start dev server on port 3000

[global] ~/.claude/CLAUDE.md:
+ ## Preferences
+ - Always use conventional commits
```

### Step 5: Apply (after user approval)
1. Edit existing sections or append new sections
2. Keep organized with clear `##` headers
3. Avoid duplication — merge with existing
4. Remove outdated entries if contradicted

## Formatting Rules for CLAUDE.md

- Use `##` headers for sections
- Use `-` bullet lists for items
- Keep entries concise (1 line each)
- Group by: Commands, Conventions, Architecture, Gotchas
- No frontmatter in CLAUDE.md files
- CLAUDE.md should be practical — commands you run, not documentation

## Rules

- ALWAYS show proposed changes before applying
- NEVER remove existing entries without explanation
- NEVER add entries that duplicate what's already there
- Keep CLAUDE.md files under 100 lines
- Prefer project-level for project-specific things

## Red Flags

Stop and re-read this skill if you are thinking:

| Rationalization | Rebuttal |
|---|---|
| "I established this pattern earlier in the session, so it is a project convention." | One occurrence in one session is an anecdote. Write it only if you saw it hold more than once, or the user stated it as a rule. Everything else is noise that a future session will obey as if it were law. |
| "`--auto` was passed, so I can skip reading the current files." | `--auto` removes the approval step in Step 5, not Steps 2-3. Skipping the read is how the same bullet lands three times and the file stops being read by anyone. |
| "This entry is genuinely useful, so the project CLAUDE.md is the safe place for it." | A personal preference written into the project file is committed and imposed on every contributor. Classify against the Step 3 table first: global preferences go to `~/.claude/CLAUDE.md`, project-specific personal notes to the per-project user file. |
| "The file is already at the 100-line cap, so one more line is harmless." | The cap is a limit, not a starting point. Going over means condensing or removing something outdated — and the removal has to be shown and explained, never done quietly. |
| "The new entry contradicts an existing one, so the newer one obviously wins." | Maybe the old entry is still right and what you observed was a one-off. Surface the contradiction in the proposal and let the user decide which survives. |

## Verification

Before reporting, all of these must hold:

- Every target file was re-read after editing, not assumed from the diff.
- No bullet you added duplicates or contradicts an existing line, in that file or in a sibling CLAUDE.md.
- Each edited file is still under 100 lines, uses `##` section headers, and has no YAML frontmatter.
- Every insight landed in the file the Step 3 table names for its type — no project file carrying a personal preference.
- Unless `--auto` was passed, the user saw the proposed diff and approved it before any write.
- The report names each file changed, each entry added, and each entry removed with the reason it was removed.
