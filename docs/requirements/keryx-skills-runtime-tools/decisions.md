# Decisions: Keryx Skills Runtime Tools
Version: 0.1.0

## D-01: Extend `METAPROJECT_OPERATIONS`, do not hand-write a bespoke MCP tool

**Decision:** `skills_catalog`/`skill_load` are `MetaprojectOperation`
descriptors, registered exactly like `graph_affected`/`read_wiki`.

**Why:** `src/harness/tool/metaproject-operations.ts`'s own header comment
states its purpose is "one definition → three projections"; a bespoke MCP
tool would get only the MCP projection and require separate, duplicate
wiring for the interactive-agent tool set and `ToolRegistry` — work the
unified registry exists specifically to avoid. See
[brainstorm.md](brainstorm.md) Option A/B.

**Consequence:** `MetaprojectOperation["module"]`
(`metaproject-operations.ts:50`) must widen to include `"gdskills"` — a
small, typed, low-risk change, but one touching a shared union used by all
seven existing operations' own type-checking.

## D-02: `skills_catalog` always reads live from disk, never caches

**Decision:** No TTL, no in-memory cache, no snapshot written at `keryx
init` time that `skills_catalog` could read instead of the live tree.

**Why:** PRD risk "staleness between two sources of skill listing" — R4's
materialized `.claude/skills/` copy is already a snapshot that can go stale
between `keryx update` runs; a *second* stale snapshot (a cached
`skills_catalog` result) would compound the problem with no compensating
benefit, since a full-catalog filesystem walk over `.metaproject/skills/` is
cheap (dozens of small files, not thousands) — unlike, say, `gdgraph`'s
whole-codebase graph, which legitimately needs cached artifacts.

**Consequence:** `skills_catalog`'s `generatedAt` field
(specification.md §3.1) is the read timestamp, not a cache-write timestamp —
it will differ on every call.

## D-03: Verification mechanism (R3) is deferred to a follow-up specification

**Decision:** This package specifies R1/R2/R4/R5 in full; it does not fix
how `keryx flow`/`keryx health` would check that `skill_load` was actually
called for skills a flow's routing implied were needed.

**Why:** Candidate mechanisms — a session-scoped tool-call log the flow
journal cross-references, a `flow.json` field populated automatically by the
harness when `skill_load` fires during a flow's lifetime, or a health-gate
rule pattern-matching against session transcripts — each has different
implementation cost and different coupling to flow internals not yet
designed. Committing to one here, before R1/R2 exist to be verified, risks
specifying a mechanism around an API surface that hasn't been implemented
yet and may change shape during that implementation.

**Consequence:** PRD's "success criteria" for R3 is stated narrowly (a call
appears in tool logs "the same way ... calls already do") — an existing,
already-true property of any `MetaprojectOperation`, not a new claim — and
the stronger "flow completion can check this automatically" claim is
explicitly left for a follow-up package once R1/R2 ship.

## D-04: Slash-command exposure (Option D) is deferred, not adopted or rejected

**Decision:** Not specified in this package's acceptance criteria. R4 grants
it for Claude Code automatically (materialized skills become native `/name`
commands via Claude Code's own mechanism); no equivalent is specified for
Codex/Cursor/Zed/opencode.

**Why:** Whether "slash command" is even a meaningful concept for each of
the other four listed-compatible assistants was not established by this
package's research pass — `opencode`'s own `/name` convention is
opencode-specific harness behavior, not something keryx can produce for a
different assistant's command surface without knowing that assistant's own
extension mechanism. Speculating here would violate this project's own Iron
Law 6 (do not claim a mechanism exists unless the code/target platform
proves it).

**Consequence:** A future package, scoped per-assistant, would need its own
research pass before this could move from "deferred" to "adopted."

## D-05: Prose routing (`CLAUDE.md`/`index.md`) is not removed or deprecated

**Decision:** R1/R2/R4 are additive. No change to `CLAUDE.md`, `AGENTS.md`,
or `.metaproject/index.md`'s Intent Router content is in scope.

**Why:** Three reasons. First, honesty about coverage: even after R1/R2/R4
ship, an assistant that supports neither MCP tool calls nor Claude Code's
native Skill mechanism has no other path — prose stays the only option for
it. Second, migration risk: this package's PRD success criteria require
"nothing ... removes a currently-working path" — pulling prose routing out
before the new paths are proven in production would leave a gap for exactly
the sessions this package cannot yet verify are covered (see D-03). Third,
scope discipline: rewriting `CLAUDE.md`/`index.md`'s routing content is a
large, separate, high-blast-radius change (it is read by every session in
every project using this Metaproject) that does not need to happen in the
same change as adding two new operations.

**Consequence:** For an unspecified transition period, keryx will have two
parallel routing surfaces (prose + structured) with no automatic
reconciliation. This is accepted, not solved, by this decision — a future
package may propose retiring prose routing once R3's verification signal
shows the structured path is reliably used.

## D-06: R4's frontmatter mapping drops `triggers`/`category`/`compatibility` rather than inventing Claude-Code extensions

**Decision:** Materialized `.claude/skills/<name>/SKILL.md` files carry only
`name` and `description` in translated frontmatter (specification.md §4.4
table); `triggers` folds into the description text, `category` and
`compatibility` are dropped.

**Why:** Claude Code's documented frontmatter schema does not define a
`triggers` or `category` field; inventing non-standard frontmatter keys in a
file Claude Code's own harness parses risks silent rejection or undefined
behavior by a parser this package's author does not control the source of.
`compatibility` is meaningless in a file only Claude Code will ever read.
Folding `triggers` into `description` text is lossy but safe — the
information survives as prose a human/model can still read, even though it
is no longer a structured field.

**Consequence:** A `.claude/skills/`-sourced skill and a
`.metaproject/skills/gdskills/`-sourced skill (via R1/R2) present slightly
different structured data for the same underlying skill — R1/R2's
`SkillsCatalogEntry.triggers` array has no equivalent when the same skill is
discovered through Claude Code's own native listing instead. Accepted as an
unavoidable consequence of D-06, not treated as a defect to fix.
