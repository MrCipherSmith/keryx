# Specification: Keryx Skills Runtime Tools
Version: 0.1.0

Status: implemented — shipped in the 0.2.50 release (PR #359). Every path and
signature below is either (a) an existing file/interface, cited as such, or
(b) an element this package added to it, marked **NEW** at the time of
writing.

## 1. Identity

Two new `MetaprojectOperation` descriptors, `skills_catalog` and
`skill_load`, registered in `src/harness/tool/metaproject-operations.ts`
beside the existing thirteen (`search_code`, `graph_affected`, `graph_query`,
`memory_search`, `read_wiki`, `graph_path`, `test_related`, `health_status`,
`graph_symbol`, `repomap`, `wiki_ask`, `wiki_backlinks`, `flow_status` — the
full current `METAPROJECT_OPERATIONS` set, confirmed at
`metaproject-operations.ts:415-690`). Module tag: `"gdskills"`, requiring
`MetaprojectOperation["module"]`
(`metaproject-operations.ts:50`, currently `"gdgraph" | "gdctx" | "wiki" |
"memory" | "health" | "testing" | "flow"`) to widen by one variant.

A third, independent element — R4's native materialization step — is not an
operation at all; it is a write performed by `keryx init`/`keryx update`
(existing install pipeline: `src/gdskills/install.ts`, `sync.ts`), not by any
runtime tool call.

## 2. Storage structure

No new persistent storage. Both operations read the consuming project's
already-installed tree:

```text
.metaproject/skills/catalog.md              # human index (existing)
.metaproject/skills/gdskills/**/SKILL.md     # skill bodies (existing)
.metaproject/skills/project-skills/**        # generated entity skills (existing, out of scope for R1/R2 v1)
```

R4 additionally writes (new, install-time only):

```text
.claude/skills/<name>/SKILL.md               # NEW — materialized per gdskill
```

`<name>` matches the gdskill's own name (e.g. `flow-orchestrator`), flattened
— nested category directories (`orchestration/flow-orchestrator/`) do not
carry into `.claude/skills/`, since Claude Code's own discovery namespaces by
directory nesting already (per the researched documentation: nested
`.claude/skills/` directories load on-demand per-subdirectory and are
namespaced `path:skill-name`) — a flat top-level materialization avoids
implying keryx's own category folders are meaningful to Claude Code's loader.

## 3. Data contracts

### 3.1 `skills_catalog` — input/output

Input: `{}` (no parameters — always returns the full catalog; filtering by
module/category is a v2 concern, not required for R1's success criteria).

Output: see [schemas/skills-catalog-result.schema.json](schemas/skills-catalog-result.schema.json).
Shape (one entry per discovered skill):

```ts
interface SkillsCatalogEntry {
  name: string;            // "flow-orchestrator"
  path: string;            // ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md"
  category: string;        // "orchestration" — derived from the containing directory, mirrors BundledSkill.category
  description: string;     // from SKILL.md frontmatter `description`, falls back to catalog.md's one-line summary
  triggers?: string[];     // from SKILL.md frontmatter `triggers`, when present
}
interface SkillsCatalogResult {
  skills: SkillsCatalogEntry[];
  generatedAt: string;     // ISO timestamp of the live read, never cached (PRD risk mitigation)
}
```

### 3.2 `skill_load` — input/output

Input: `{ name: string }` — matches a `SkillsCatalogEntry.name` (or an exact
`path`, for the nested/namespaced case a bare name is ambiguous — accept
either).

Output: see [schemas/skill-load-result.schema.json](schemas/skill-load-result.schema.json).

```ts
interface SkillLoadResult {
  name: string;
  path: string;
  content: string;         // the SKILL.md body verbatim, including frontmatter
  found: boolean;           // false + empty content when name/path does not resolve
}
```

`skill_load` never formats, summarizes, or truncates — it is a structured
`Read`, not an interpretation. Truncation/summarization, if ever needed for a
very large skill body, is out of scope for v1 (no bundled `SKILL.md` observed
in this repository approaches a size where this matters).

## 4. Integration points

### 4.1 `MetaprojectPort` (existing interface, `metaproject-port.ts`)

**NEW** methods, following the exact shape of existing ones
(`graphAffected(input): Promise<GraphAffectedResult>`,
`readWiki(input): Promise<WikiPageResult>`, `metaproject-port.ts:294,303`):

```ts
skillsCatalog(input: Record<string, never>): Promise<SkillsCatalogResult>;
loadSkill(input: { name: string }): Promise<SkillLoadResult>;
```

### 4.2 Reference adapter (existing `metaproject-adapter.ts`)

**NEW** implementations backing the two port methods above. `skillsCatalog`
walks `.metaproject/skills/gdskills/**/SKILL.md` (the same tree
`.metaproject/skills/catalog.md` already indexes), parsing YAML frontmatter
for `description`/`triggers`; `loadSkill` resolves `name` against that same
walk and reads the matched file. Both are pure filesystem reads scoped to
the project's own `.metaproject/`, matching every other adapter method's
trust boundary (no network, no shell).

### 4.3 Three projections (existing, unchanged code paths)

Once registered in `METAPROJECT_OPERATIONS`, both operations reach:

- **Interactive agent tool set** via `toInteractiveTools(ops, port)` — the
  operation's `invoke(port, input)` formats the structured result into
  readable text, same as every existing operation.
- **Harness `ToolRegistry`** via `toToolDefinitions(ops)`.
- **MCP `ToolEntry[]`** via `toMcpTools` (`src/mcp/metaproject-tools.ts:85`)
  — no bespoke `case` needed in `invokeStructured`
  (`metaproject-tools.ts:43-73`) unless a structured (non-text-formatted)
  MCP result is wanted; the existing `default: return op.invoke(port,
  params)` fallback (`metaproject-tools.ts:66-71`) already makes every
  registered operation MCP-callable without extra code, exactly as it does
  today for `graph_path`, `test_related`, `health_status`, `graph_symbol`,
  `repomap`, and `wiki_ask` per that file's own comment.

This is the "for free" claim in README.md/PRD: no new MCP transport code, no
new agent-tool wiring — one descriptor addition surfaces in all three
consumers through code that already exists and is already tested for the
other operations.

### 4.4 R4 — Claude Code native materialization (new install-time step)

`keryx init`/`keryx update` (`src/gdskills/install.ts`/`sync.ts`, existing)
gains a step that, for every gdskill it installs into
`.metaproject/skills/gdskills/`, also writes a copy to
`.claude/skills/<name>/SKILL.md` with a translated frontmatter:

| gdskill frontmatter field | Claude Code field | Mapping |
|---|---|---|
| `name` | `name` | verbatim |
| `description` | `description` | verbatim |
| `triggers` | — | folded into `description` text (Claude Code has no separate triggers field per researched documentation) |
| `metadata.category` | — | dropped (informational only in keryx) |
| `compatibility` | — | dropped (Claude-Code-specific file; the field's purpose — signaling other assistants — doesn't apply to a file only Claude Code reads) |

Body content is copied verbatim below the translated frontmatter. This step
is idempotent and re-run by `keryx update`, addressing PRD risk "staleness
between two sources."

## 5. CLI / skill surface

No new CLI subcommand is required for R1/R2 — they are tool-call-only,
mirroring `graph_affected`/`read_wiki`, neither of which has a bespoke `keryx
graph affected`/`keryx wiki read` CLI form distinct from the MCP tool itself
(both are reached via `keryx` subcommands used by the *skill* layer, not a
1:1 CLI mirror of every operation — confirm against actual `keryx --help`
output before implementation, since this specification does not assert a CLI
form that does not exist).

R4 needs no new command; it extends the existing `keryx init`/`keryx update`
pipeline.

R3 (verification signal) is deferred to a follow-up specification once R1/R2
exist — see [decisions.md](decisions.md) D-03 for why an exact mechanism is
not fixed here.

## 6. Acceptance criteria (for a future implementation flow, not met by this package)

- AC1: `skills_catalog` returns every skill currently discoverable in
  `.metaproject/skills/gdskills/` and `catalog.md`, matching the file count
  a human `ls -R .metaproject/skills/gdskills` would show.
- AC2: `skill_load` returns byte-identical content to a direct `Read` of the
  same `SKILL.md` file, for every skill in the catalog.
- AC3: `skill_load` on an unknown name returns `found: false` with empty
  content, not an error/throw.
- AC4: Both operations are read-only (`risk: "read"`) and appear in all
  three projections (agent tool list, `ToolRegistry`, MCP `ToolEntry[]`)
  without additional wiring beyond the descriptor registration.
- AC5: For a project with R4 applied, every `.claude/skills/<name>/SKILL.md`
  parses as valid Claude Code skill frontmatter (name + description present,
  no unknown-to-Claude-Code required fields).
- AC6: Existing `CLAUDE.md`/`index.md` prose-routing behavior is unchanged —
  no existing test in `src/mcp/`, `src/harness/tool/`, or `src/gdskills/`
  regresses.
