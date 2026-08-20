# PRD: Keryx Skills Runtime Tools
Version: 0.1.0

## Problem

`.metaproject/skills/` — the Intent Router, `gdgraph`/`gdctx`/`gdwiki`/`flow`
skills, and every bundled `gdskills` orchestrator — has real, structured
content (frontmatter, triggers, categories: confirmed directly in
`src/gdskills/catalog.ts`'s `BUNDLED_GDSKILLS: BundledSkill[]`), but no
runtime mechanism delivers it. The only path is: an agent reads
`CLAUDE.md`'s "HARD GATE" instruction, reads `.metaproject/index.md`, matches
its own understanding of the user's intent against a markdown table, and
`Read`s a `SKILL.md` file — an action indistinguishable, at the tool-call
level, from reading any other file in the repository.

Three concrete consequences observed directly in this session's own routing:

1. **No structural signal.** Every non-trivial task in this session ended
   with a self-written "routing audit" line (`graph_used: yes`, `ctx_used:
   yes`, ...) — a claim the model makes about its own compliance, not a fact
   the harness can check. Nothing distinguishes "the skill was actually read
   this turn" from "the model asserts it was."
2. **No portability guarantee.** The mechanism depends entirely on the
   connected assistant loading and choosing to obey `CLAUDE.md`/`AGENTS.md`
   prose. Every `SKILL.md` in this repository already declares
   `compatibility: cursor,codex,zed,opencode,claude` — but only Claude Code
   (and only if its own native `Skill` tool or CLAUDE.md convention is
   engaged) has any chance of a harness-level guarantee; the other four
   listed assistants get the prose path or nothing.
3. **No progressive disclosure.** Five of six researched CLIs (Claude Code
   itself, opencode, cline, kilocode) gate skill-body loading behind a
   description-matched tool call, keeping only short catalog entries
   in-context until invoked. keryx's only way to learn what's routable is to
   read `.metaproject/index.md` in full — there is no cheaper structured
   query.

## Goal

Give every keryx-compatible assistant a structured way to (a) discover what
skills exist and when to use them, and (b) load one skill's content — as a
real tool call, not a `Read` on a file whose relevance was decided entirely
in the model's own prose reasoning. For Claude Code specifically, prefer
reusing its own native Skill mechanism over reimplementing it.

## Users

- **The connected agent** (Claude Code, Codex, Cursor, Zed, opencode, or any
  future MCP client) — the direct consumer of the new operations.
- **The keryx maintainer/reviewer** — gains a structural fact ("`skill_load`
  was called with `flow-orchestrator`") to check instead of trusting a
  self-reported audit line, closing exactly the class of gap this project's
  own memory records as a repeat mistake: *"A shell allowlist matched
  against the raw command string is not a security boundary"* / *"A source
  guard loses one spelling per round"* — a prose-compliance convention has
  the same shape of weakness.
- **A project not running Claude Code** — currently gets zero benefit from
  `.metaproject/skills/`'s structured content unless its own harness happens
  to read and obey `CLAUDE.md`/`AGENTS.md` the same way.

## Requirements

1. **R1 — `skills_catalog` operation.** A read-only `MetaprojectOperation`
   returning every discovered skill's name, module/category, one-line
   description, and triggers as structured data (`BundledSkill`,
   `src/gdskills/catalog.ts:3-11`, has 7 fields — `name`, `category`,
   `description`, `purpose`, `workflow`, `triggers`, `profiles`; the catalog
   entry drops the install-only `profiles`, `purpose`, and `workflow` fields
   and adds a `path` field with no `BundledSkill` equivalent), sourced from the
   *installed* project's `.metaproject/skills/` tree — not from keryx's own
   `src/gdskills/bundled/skills/`, which is the install-time source for a
   different project's `.metaproject/`, not this one's runtime state.
2. **R2 — `skill_load` operation.** A read-only operation taking a skill
   name/path and returning that skill's full `SKILL.md` body as the
   operation result (the same bytes a `Read` would return, but as a
   structured, named, loggable tool call).
3. **R3 — verification signal.** A way for `keryx flow`/`keryx health` to
   check, after the fact, whether `skill_load` was actually invoked for
   skills a flow's own routing implied were needed — replacing reliance on
   the free-text routing-audit convention. Exact mechanism (session log,
   flow journal field, health-gate check) is a design decision, not fixed by
   this PRD; see [decisions.md](decisions.md) D-03.
4. **R4 — Claude Code native materialization.** `keryx init`/`keryx update`
   additionally writes every installed gdskill as a real
   `.claude/skills/<name>/SKILL.md` with Claude-Code-native frontmatter
   (`name`, `description`, optionally `allowed-tools`/`context`), so Claude
   Code's own harness — not keryx — performs discovery, progressive
   disclosure, and relevance matching for that assistant specifically.
5. **R5 — non-regression.** `CLAUDE.md`/`AGENTS.md`/`index.md` prose routing
   keeps working unchanged for any assistant or context where neither R1/R2
   nor R4 apply (see [decisions.md](decisions.md) D-05).

## Success Criteria

- A connected MCP client can enumerate every `.metaproject/skills/` entry
  without reading `index.md` or any `SKILL.md` file directly.
- A connected MCP client can load one skill's full content via a single
  structured tool call, with the call itself (name + arguments) appearing in
  session/tool logs the same way `mcp__keryx__wiki_query` or
  `mcp__keryx__graph_affected` calls already do.
- For a Claude Code session with R4 materialization present, the skills
  appear in Claude Code's own native skill listing (verifiable: the skill
  shows up as an invocable `/name` slash command and a model-visible
  description at session start, the same way this session's own
  user-invocable skills list already includes `graphify`, `brainstorm`,
  `code-review`, etc.) without any keryx-side tool call at all.
- Existing behavior — reading `.metaproject/index.md` and `SKILL.md` files
  directly — continues to work exactly as today; nothing in this package
  removes a currently-working path.

## Risks

- **Staleness between two sources of skill listing.** If R4's materialized
  `.claude/skills/` copy and R1's live-read catalog diverge (e.g. a skill
  edited after `keryx init` last ran), an assistant using each path sees a
  different answer. Mitigate by making R4 a copy step re-run by `keryx
  update`, and by R1 always reading live from disk, never from a cached
  snapshot — see [decisions.md](decisions.md) D-02.
- **Frontmatter dialect mismatch.** keryx's bundled `SKILL.md` frontmatter
  (`name`, `category`, `metadata.author/version`, `compatibility`) is not
  identical to Claude Code's own documented frontmatter fields (`name`,
  `description`, `disable-model-invocation`, `context`, `allowed-tools`).
  R4's materialization step needs an explicit field mapping, not a blind
  copy — see [specification.md](specification.md).
- **Widening `MetaprojectOperation["module"]`.** This is a type-level,
  low-risk change (`metaproject-operations.ts:50`), but it is a public
  interface used by three existing projections (agent tool set, harness
  `ToolRegistry`, MCP); a broken projection would surface as a tool-listing
  regression across all three at once, not just one surface. Mitigate with
  the existing per-projection tests that already cover the other seven
  operations' module tags.
- **Scope creep toward a general cross-assistant skill protocol.** Explicitly
  out of scope (README non-goals); this PRD targets keryx's own five listed
  compatible assistants, not a new open standard.

## Recommendation

Ship R1 + R2 first (the MCP/agent-operation path) — it is the smaller,
projection-reusing change, benefits every connected assistant immediately
including Claude Code, and does not require solving R4's frontmatter-mapping
question. Ship R4 (native materialization) as a fast-follow once R1/R2 are
stable, since it is additive and Claude-Code-specific. Treat R3
(verification signal) as the last increment — it depends on R1/R2 existing
first, since there is nothing to verify the invocation of until then.
