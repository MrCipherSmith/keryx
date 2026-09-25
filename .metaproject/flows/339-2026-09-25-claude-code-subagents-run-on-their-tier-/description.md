# Claude Code subagents run on their tier: model opus|sonnet|haiku by model_tier instead of inherit

Status: frozen
Source: operator description

## Problem

`compile.ts`'s Claude Code renderer (`renderClaudeExport`) hardcodes
`model: inherit` in every exported `.claude/agents/<name>.md` file, regardless
of the source skill's declared `model_tier`. Claude Code subagent frontmatter
accepts `model: opus|sonnet|haiku|inherit` — version-free aliases that never
go stale. With `inherit`, every keryx-generated Claude Code subagent runs on
the session's own model (Opus for an operator on Opus), which is against the
operator's stated policy: Sonnet for subagents, Haiku only for trivial,
mechanical work. The `model_tier` a skill already declares (`light`/
`standard`/`deep`) is exactly the signal needed to pick the right alias; it is
just not being used for this one host target.

## Expected Outcome

- `src/agents/compile.ts`'s claude-target renderer maps `model_tier` to
  Claude's own frontmatter alias: `deep`→`opus`, `standard`→`sonnet`,
  `light`→`haiku` (an undeclared tier already defaults to `standard` upstream,
  so it lands on `sonnet`).
- Every other compile target (`keryx-shell`, `codex`, `kiro`, `opencode`)
  keeps its current behavior — `keryx-shell` still passes `model_tier`
  through unresolved (AC7 of flow 310), and codex/kiro/opencode still omit
  `model` or carry no tier field.
- A project can opt out via `.metaproject/tasks.config.json`'s
  `modelGuidance.claudeSubagentAliases: false`, which restores
  `model: inherit` for that project's claude exports.
- The flow-310 guard (`compile.model-tier.test.ts`) is narrowed, not
  weakened: it still fails a concrete/versioned model id anywhere in compiled
  output, and still fails a bare tier-size word (`opus`/`sonnet`/`haiku`)
  anywhere except the one claude frontmatter line this flow introduces.
- `model-selection.mdc` (both copies, byte-identical) and the docs site's
  `agent-catalog.md` describe the new claude-target behavior accurately.

## Out of Scope

- Any change to `keryx-shell`'s `spawn_subagent` model_tier resolution
  (`src/gdskills/model-tier.ts`) — untouched.
- Codex/kiro/opencode renderers — untouched (they have no tier-alias concept
  of their own).
- The `keryx review tier` / adaptive `inherit: true` block described
  elsewhere in `model-selection.mdc` — a different mechanism (dispatch-time,
  not export-time), untouched.
