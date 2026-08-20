# Brainstorm: Keryx Skills Runtime Tools
Version: 0.1.0

Decision history for this package. Comparative research across six
skill/capability-loading designs and eleven `web_fetch` designs (the latter
for calibration only — see README.md non-goals), conducted via three
parallel research agents plus direct reading of this repository's own
`src/mcp/`, `src/gdskills/`, and `src/harness/tool/metaproject-*.ts`.

## What was studied

**Claude Code's own `Skill` tool** (documented behavior): two-tier
disclosure — name+description (≤1536 chars total) always in context, full
body loaded on demand via a model-chosen or user-explicit invocation;
`context: fork` to dispatch a skill to a subagent; `` !`command` `` for live
context injection; hierarchical scoping (enterprise > personal > project,
namespaced nesting).

**opencode, cline, kilocode** (kilocode is an opencode fork): converged
independently on a near-identical shape — `SKILL.md` + frontmatter,
filesystem-discovered across global/project scopes, a short catalog listed
in the system prompt, full body delivered as a **tool result** when the
model calls a dedicated `skill`/`use_skill` tool. All three *also* expose
every skill as an explicit `/name` slash command — two invocation paths for
the same content. Cline's own docs state this design explicitly mirrors
Claude Code's.

**continue**: has a `Skill` type (`core/config/markdown/loadMarkdownSkills.ts`)
but it is undocumented and less load-bearing than its separate, much richer
**Rules** system — markdown files concatenated unconditionally into the
system prompt, applicability computed per-turn via glob/regex match against
touched files. This is architecturally the closest external analog to
keryx's own `CLAUDE.md`/`AGENTS.md` mechanism, not to keryx's
`.metaproject/skills/`.

**oh-my-claudecode**: a Claude Code plugin, so it inherits the native
`Skill` tool — but layers a redundant parallel "learned skills" system on
top (`src/hooks/learner/`), reverse-engineering relevance-matching in
userland via a `UserPromptSubmit` hook, apparently because a hook-based
hint-injection pattern was easier to build than trusting native
description-matching for their specific use case. Cited here as a cautionary
example: reimplementing what the harness already does, rather than reusing
it, doubles the maintenance surface for the same outcome.

## Where keryx actually sits

Checked directly, not inferred: `src/mcp/tools.ts`, `dispatch.ts`,
`metaproject-tools.ts`, `resources.ts` — zero occurrences of "skill" outside
two code comments. `.metaproject/skills/` has real structured content
(`src/gdskills/catalog.ts`'s `BundledSkill[]`: name, category, description,
triggers, per-skill workflow bullets) but the *only* delivery mechanism is
`CLAUDE.md`'s prose "HARD GATE" plus `.metaproject/index.md`'s Intent Router
table, read and obeyed voluntarily, then a plain `Read` on a `SKILL.md` file.

This is closer to **continue's Rules** (unconditional prose, no tool) than to
any of the four CLIs that converged on a tool-mediated design — except
continue's Rules are honestly scoped as "always-on injected instructions,"
where keryx's Intent Router presents itself as *routing* (implying
selectivity/relevance-matching) while having none of the structural backing
that makes routing real elsewhere.

## Options considered for closing the gap

**Option A — new bespoke MCP server tool, hand-written.** Rejected as the
primary path: would duplicate work `src/harness/tool/metaproject-operations.ts`
already exists to avoid — a bespoke tool gets only the MCP projection, not
the interactive-agent-tool and `ToolRegistry` projections the unified
operation registry gives for free.

**Option B — extend `METAPROJECT_OPERATIONS`.** Adopted (R1/R2). Matches
every other Metaproject capability's own integration pattern; "one
definition → three projections" is this file's stated design goal already,
just never pointed at `gdskills`.

**Option C — reuse Claude Code's native `Skill` tool via file
materialization, and stop there.** Considered as sufficient on its own,
since it needs zero new keryx tool code for the one assistant most sessions
run under. Rejected as *sufficient* (kept as R4, a complement, not a
replacement) because keryx's own `SKILL.md` files declare
`compatibility: cursor,codex,zed,opencode,claude` — four of those five gain
nothing from a Claude-Code-only materialization step. This is the same
reasoning gap oh-my-claudecode's redundant learner avoided asking: "does the
native mechanism already solve this for the assistant we care about" —
worth asking here for Claude Code (yes, reuse it), and separately for the
other four (no equivalent exists to reuse, hence Option B is still needed
for them).

**Option D — slash-command exposure for every gdskill (opencode/cline/kilocode
dual-path convention).** Deferred, not rejected — see
[decisions.md](decisions.md) D-04. For Claude Code, R4 already grants this
for free (materialized skills become native `/name` commands automatically).
For other assistants, whether a slash-command layer is meaningful depends on
whether that assistant's own harness supports one at all — not established
by this research pass.

## Calibration note: `web_fetch` comparison

Separately researched (not part of this package's scope) whether keryx's
`SandboxedWebTransport` compares favorably to the same six repos' web-fetch
tools plus five more (`aider`, `codex`, `gemini-cli`, `qwen-code`, `crush`,
`grok-build`, `deepseek-harness`). Finding, recorded here only as context for
why this package's author trusts the comparative-research method used above:
keryx's DNS-resolve-and-pin-then-sandboxed-subprocess design is matched in
rigor only by `grok-build`'s Rust implementation; most researched CLIs
(`cline`, `crush`, `aider`, `opencode`) ship no SSRF protection at all, and
one (`deepseek-harness`) explicitly documents the gap rather than silently
shipping it. No action item — cited to show the comparative method already
produced one accurate, actionable finding this session, which is why the
same method was trusted for the skills-loading question this package
answers.
