# Module Reference

`gd-metapro` is a Bun/TypeScript CLI that scaffolds and maintains a per-project
`.metaproject/` workspace of agent-facing knowledge, quality signals, and managed
work. It is organized as a thin dispatcher (`cli.ts`) routing to a set of loosely
coupled feature modules, each with a `commands/<name>.ts` handler over a
`<feature>/*.ts` domain layer, all sitting on a shared `lib/` toolkit. Modules
never call each other's code paths directly; they integrate by reading and writing
files under the shared `.metaproject/` workspace.

This reference documents one module per section, covering the real CLI surface,
key source files, mechanics, the `.metaproject/` paths each module reads and writes,
and cross-module integrations. Behavior described here is what the source actually
implements.

**Cross-cutting opt-in substrate (roadmap-2026).** The optional, model/asset-backed
features described below (gdgraph's symbol layer, memory's embedding index, the
security model backends, etc.) all instantiate three shared, deterministic-safe
mechanisms rather than each rolling their own: the **Capability System**
(`src/capability/` — `resolveCapability(cwd, spec)` returns an adapter only when the
capability is enabled in the manifest, its optional dependency imports lazily, and
its asset resolves; otherwise it returns `null` and the caller runs its
deterministic fallback), the **Asset Resolver** (`src/assets/` — resolves + sha256-
verifies an opt-in asset from a config path / cache, never networking implicitly),
and the **fixture harness** (`src/harness/` — runs a block's detector over a committed
labeled corpus and computes a reproducible precision/recall report). The invariant
across every module is the same: **the deterministic path is the default and the
fallback; each model/asset feature is opt-in and degrades gracefully to that path.**

---

## cli-core

**Purpose.** The CLI core is the entrypoint and lifecycle layer. It owns the argv
dispatcher (`src/cli.ts`) and the cross-cutting lifecycle commands — `init`,
`update`, `dashboard`/`dash`, `status`, `modules`, and `standard` — plus
`MODULE_COMMANDS`, the single source
of truth for each module's canonical subcommand list. Its job is to parse the
top-level subcommand, scaffold the workspace and its nine optional modules, keep
managed "service" files in sync without ever touching user "data" artifacts, and
emit both an agent-facing `index.md` and a human-facing HTML dashboard.

**CLI surface (top-level commands).** `main()` is a flat if-chain mapping `args[0]`
to a handler:

| Command | Action |
|---|---|
| (none) / `--help` / `-h` | `printHelp()` |
| `--version` / `-v` | prints package version |
| `init` | scaffold `.metaproject/`, enable modules + hooks, write manifest |
| `status` | print manifest module enabled/disabled state |
| `update` | refresh service files, runtime, tasks backfill, dashboard |
| `dashboard` / `dash` | build/open the HTML dashboard (bare `dash` = `open`) |
| `modules` | view and toggle modules (`status` / `enable <name>` / `disable <name>` / interactive) |
| `standard` | validate the workspace against the Metaproject Standard: `validate` / `doctor` / `capabilities` |
| `gdgraph`, `ctx`, `wiki`, `skills`, `skill-verify-skill`, `health`, `test`, `memory`, `flow`, `rules` | routed to the feature module handler |
| unknown | error + help + exit 1 |

Key lifecycle flags: `init` accepts `--yes/-y`, `--no-<module>` for each of the 9
modules, `--gdskills-profile <v>`, and `--no-*-hook` variants; `update` accepts
`--hooks`, `--skip-runtime`, `--no-tasks`.

**Key files.**
- `src/cli.ts` — entrypoint `main()` argv dispatcher, `printHelp()`, version.
- `src/commands/init.ts` — scaffolds `.metaproject/`, resolves module + hook enablement, writes the manifest.
- `src/commands/update.ts` — refreshes service files, self-updates the runtime, backfills tasks, builds the dashboard (`buildDashboard` is exported from here).
- `src/commands/dashboard.ts` — `dashboard build|open` (delegates to `buildDashboard`).
- `src/commands/status.ts` — reads the manifest, prints module state (read-only).
- `src/commands/module-commands.ts` — `MODULE_COMMANDS`, the canonical per-module subcommand map.
- `scripts/install.sh` — project/global installer.

**How it works.** The defining pattern is **idempotent write helpers**:
`writeTextIfMissing` (seed once, never overwrite user edits),
`writeTextIfChanged`/`writeJsonIfChanged` (managed files reconciled to their
rendered template), and `copyFileIfChanged`. The core invariant is **data vs
service separation**: `init`/`update` regenerate templates, manifests, skills,
hooks, and dashboards but never write under `.metaproject/data/`. `init` resolves
enablement for 9 modules (`gdgraph, gdctx, gdwiki, gdskills, health, testing,
memory, tasks, security`), scaffolds base + per-module dirs, installs managed git hooks
(injecting `# gd-metapro:<id>:begin…:end` blocks), and writes a typed
`MetaprojectManifest`. `update` optionally git-fetches the runtime repo it was
launched from (`.metaproject/runtime/gd-metapro/.git` or `$HOME/.gd-metapro/...`),
re-renders all managed files, recovers/migrates a missing or legacy manifest
(`wiki`→`gdwiki`), and backfills the `tasks` module. The dashboard is a single
self-contained HTML file with size-capped Markdown/JSON embedded inline so it works
over `file://` without fetch.

**Data & artifacts.** Reads/writes `.metaproject/metaproject.json` (authoritative
config). Writes managed docs (`index.md`, READMEs, per-module manifests and
`skills/<m>/SKILL.md`), seed-once config files (`gdctx.config.json`,
`health.config.json`, `testing.config.json`, `memory.config.json`), git hooks under
`.git/hooks/`, and `.metaproject/gd-metapro-dashboard.html`. `collectDashboardData`
reads (read-only) `data/health/artifacts/latest.json`,
`data/gdgraph/storage/{nodes,edges}.jsonl`, `data/testing/artifacts/latest.json`,
and wiki/memory Markdown trees.

**Dependencies / integrations.** Node/Bun builtins (`fs`, `path`, `url`,
`child_process`) + git. Imports render/config/type helpers from every feature module
for scaffolding. `MODULE_COMMANDS` is the one place the manifest `commands` arrays
come from; `module-commands.test.ts` enforces it stays in sync with the actual
dispatchers. Note the naming skew: manifest module id `tasks` vs CLI verb `flow`,
and module id `gdwiki` vs CLI verb `wiki`.

---

## gdgraph

**Purpose.** `gdgraph` builds a lightweight intra-project import/dependency graph by
scanning the filesystem and parsing import specifiers with regexes. It persists the
graph as JSONL plus human-readable artifacts, then answers structural queries over
the persisted graph — dependency cycles, orphan modules, and the
dependencies/dependents of a given file.

**CLI surface.** Entry point `gdgraphCommand(args)`:
- `build` — builds the graph for `process.cwd()`, writes artifacts, prints node/edge counts.
- `query cycles` — prints each cycle as `a -> b -> a`, or "No cycles found."
- `query orphans` — prints orphan module paths, or "No orphan modules found."
- `affected <file> [--depth N] [--ranked] [--json]` — prints a Markdown block with `## Dependencies` and `## Dependents`; `--depth N` walks the transitive N-hop dependent closure (default `1` = today's direct set), `--ranked` appends a blast-radius ranking, `--json` emits the structured result.
- `repomap [--budget N] [--seed <path>...] [--changed]` — writes a PageRank-ranked, token-budgeted `artifacts/repomap.md`.
- `assets list | verify [<id>] | pull <id>` — manage the optional tree-sitter grammar assets.
- `--help`/`-h`/no args — usage.

Only `cycles` and `orphans` are valid `query` targets (anything else errors, exit
1). Unless `GD_METAPRO_GDGRAPH_LOCAL=1`, the command first tries to delegate `build`,
`query`, and flag-less `affected` to a project-local
`.metaproject/core/gdgraph/cli.ts`, letting a project pin its own gdgraph version;
if that file is absent (or the newer `repomap`/`assets`/flagged-`affected` surfaces
are used) the built-in implementation runs.

**Key files.**
- `src/commands/gdgraph.ts` — dispatcher, local-runner delegation, help, output.
- `src/gdgraph/build.ts` — filesystem walk, import-specifier extraction, resolution, artifact writing.
- `src/gdgraph/query.ts` — graph loading (incl. the symbol layer) + the three query algorithms.
- `src/gdgraph/types.ts` — `GraphNode`, `GraphEdge`, `GraphData`, plus the additive `SymbolNode`/`CallEdge`/`SymbolLayer`.
- `src/gdgraph/service.ts` — `createGdgraphService()` facade (`build`/`loadGraph`/`affected`/`repomap`/`query`): the transport-independent service contract for in-process callers.
- `src/gdgraph/affected.ts` — pure N-hop transitive `affected` (BFS over reverse-dependents).
- `src/gdgraph/pagerank.ts` + `repomap.ts` — deterministic personalized PageRank + the token-budgeted repo map.
- `src/gdgraph/config.ts` — optional `.metaproject/gdgraph.config.json` loader (deep-merged over defaults; missing/malformed ⇒ defaults).
- `src/gdgraph/treesitter/` — the opt-in `web-tree-sitter` symbol-layer adapter (`adapter.ts`, `extract.ts`, `grammars.ts`) + `enrich.ts`.

**How it works.** `collectSourceFiles` walks the tree from the project root,
skipping `IGNORE_DIRS` (`.git`, `.metaproject`, `node_modules`, build/output dirs,
etc.) and collecting `.ts/.tsx/.js/.jsx` files as file nodes.
`extractImportSpecifiers` strips comments then applies four regexes (static import,
re-export, dynamic `import()`, `require()`) — regex-based, not AST, so unusual syntax
can be missed. Each relative specifier is resolved by probing candidate extensions
and `index.*` (`imports` edge) or matched against known asset extensions on disk
(`asset` edge); unresolved relative specifiers become `unresolved` edges, and bare
(package) specifiers are skipped entirely — the graph is intra-project only.
Queries: `getOrphans` returns nodes with no inbound/outbound resolved edges;
`getAffected` matches the target by exact path or suffix; `getCycles` runs a
recursive DFS over `imports` edges only, deduping cycles by canonical rotation
(reports one representative per rotation, not all elementary circuits).

**Block B additions (symbol layer + ranked map).** An optional **symbol layer** —
`src/gdgraph/treesitter/`, an adapter over `web-tree-sitter`, opt-in via
`init --treesitter` — parses sources into function/class/method `SymbolNode`s and
`calls`/`defines` `CallEdge`s, written **additively** to `storage/symbols.jsonl` +
`storage/calls.jsonl`. It is the only code in `src/` that loads `web-tree-sitter`
(lazily via `await import()` behind the shared Capability Seam) and it never throws
out: when the dependency or a grammar asset is unavailable it degrades to `null` and
the regex/file-level graph stays the **byte-identical default**. `affected` is now
transitive (`affected.ts`, a BFS over reverse-dependents to `--depth N`, with a
`--ranked` blast radius and `--json`); at depth 1 the rendered `Dependencies`/
`Dependents` output is byte-for-byte identical to the pre-block renderer. `repomap`
(`pagerank.ts` + `repomap.ts`) ranks files (and symbols, when the layer is present)
by deterministic personalized PageRank and renders a hard-token-budgeted
`artifacts/repomap.md`. `createGdgraphService()` (`service.ts`) is the new
transport-independent facade over these surfaces; `config.ts` supplies the optional,
deep-merged config.

**Data & artifacts.** Storage `.metaproject/data/gdgraph/storage/`: `nodes.jsonl`,
`edges.jsonl` (and, only when the tree-sitter capability is active, `symbols.jsonl`
+ `calls.jsonl`). Artifacts `.metaproject/data/gdgraph/artifacts/`: `module-map.json`
(module → file paths), `summary.md` (stats, top modules, unresolved imports, skipped
dirs, next-command hints), and — from `repomap` — `repomap.md`. Optional config
`.metaproject/gdgraph.config.json`.

**Dependencies / integrations.** Node builtins only (`fs`, `path`,
`child_process`); self-contained, no shared-lib or cross-module imports. Its
persisted JSONL/artifacts are consumed read-only by gdwiki `collect`, gdskills
evidence, and the cli-core dashboard.

---

## gdctx

**Purpose.** `gdctx` is a token-aware wrapper that runs common developer commands
(git diff, ripgrep, arbitrary shell commands) and reads files, then emits compact,
summarized Markdown instead of raw verbose output. Full raw output is persisted to
disk while only a distilled summary is printed, minimizing tokens consumed by an
agent. Each run records bytes-in vs bytes-out and whether output was truncated.

**CLI surface.** Dispatched by `ctxCommand`:

| Subcommand | Invocation |
|---|---|
| `status` | `gd-metapro ctx status` — metaproject/manifest/config/data presence + gdctx-enabled flag |
| `diff` | `gd-metapro ctx diff [args...]` — runs `git diff <args>`, summarizes |
| `rg` | `gd-metapro ctx rg "<pattern>" [path]` — runs `rg --line-number --column --no-heading`, summarizes |
| `read` | `gd-metapro ctx read <file> [--mode outline\|compact\|full]` (default `compact`) |
| `run` | `gd-metapro ctx run -- <command...>` — runs an arbitrary command after `--` |
| `show` | `gd-metapro ctx show [latest\|<name>] [--raw]` — prints a saved artifact |
| `--help`/`-h`/(none) | help |

**Key files.** Single-file module `src/commands/ctx.ts` (~637 lines): `ctxCommand`
router, `loadConfig`, per-mode orchestrators (`diffAndSummarize`, `rgAndSummarize`,
`readAndSummarize`, `runAndSummarize`), `runCommand` (`Bun.spawn`), `writeArtifact`,
`showArtifact`, and the summarizer/parser helpers.

**How it works.** Summarization is per-kind: **diff** parses per-file add/remove
churn, flags risky files (lockfiles, `tsconfig`, `.github/`, `scripts/`,
`src/cli.ts`, `src/commands/`), and lists hunk headers + error/warning lines;
**rg** groups `file:line:col:text` matches by file with example snippets;
**run** emits command/exit-code/byte-counts plus compacted output (head + omitted
marker + tail with important lines injected); **read** dispatches on mode — `full`
(whole file), `compact` (head + omitted + tail), or `outline` (a regex/line-scan
structural extract of imports, exports, declarations, TODOs — no AST). Config
(`CtxConfig`) tunes line/group caps and head/tail sizes. `truncated` is set whenever
the summary is smaller than the raw input (the normal case). Despite older spec
claims, **there is no gdgraph integration**; the only cross-module awareness is
reading `manifest.modules.gdctx.enabled` for `status`.

**Data & artifacts.** Root `.metaproject/data/gdctx/`. Writes timestamped
`raw/<id>.log` + `artifacts/<id>.md` (with an appended `## Metadata` JSON block),
plus overwritten `raw/latest.log` and `artifacts/latest.md`. `show latest` reads
`artifacts/latest.md` (or `raw/latest.log` with `--raw`). `status` also references
`.metaproject/metaproject.json` and `.metaproject/gdctx.config.json`.

**Dependencies / integrations.** Node/Bun builtins + `Bun.spawn`; internal
`lib/args` (`optionValue`), `lib/fs` (`pathExists`), `lib/json` (`readJsonFileOr`).
Spawns external tools at runtime: `git`, `rg`/ripgrep, and any binary passed to
`run`. No dependency on gdgraph or other metapro modules.

---

## gdwiki

**Purpose.** gdwiki is the **local project knowledge base** — a curated, file-based
wiki of knowledge meant to outlive a single task (architecture, domain models,
business rules, user scenarios, component/service responsibilities, integrations,
decisions). It is Markdown-on-disk under `.metaproject/wiki/`, human-editable and
indexed/validated by CLI commands. Beyond hand-authored pages it can **auto-collect**
deterministic draft pages from sibling modules' generated data.

**CLI surface.** Dispatched by `wikiCommand`:

| Subcommand | Behavior | Exit |
|---|---|---|
| `wiki status` | enabled?, root, page counts per type, last index/link-check state | 0 |
| `wiki new <type> <slug> --title "<t>" [--force]` | scaffold a page from template; validates type+slug | 1 on missing args |
| `wiki collect [--force] [--limit <n>]` | auto-generate draft pages from gdgraph/health/testing data, then reindex | 0 |
| `wiki index` | rebuild the managed index block in `index.md` | 0 |
| `wiki check-links` | resolve internal Markdown links, write report | **1 if broken** |
| `wiki validate` | metadata + link + index-staleness checks (superset of check-links) | **1 if issues** |
| `wiki ask "<q>" [--k <n>] [--rerank]` | deterministic Q&A over wiki pages + current memory, returns cited answer | 0 |

Eight fixed page types (`WIKI_PAGE_TYPES`), each mapping to a folder: `architecture`,
`domain-model`, `business-rule`, `user-scenario`, `component`, `service`,
`integration`, `decision`. `--limit` defaults to 12.

**Key files.**
- `src/commands/wiki.ts` — thin CLI handler.
- `src/wiki/service.ts` — all domain logic (status/create/index/collect/check-links/validate + collectors) + the `createGdWikiService()` facade.
- `src/wiki/ask.ts` — `wikiAsk`: deterministic lexical Q&A over collected wiki pages + current memory, returning citations + an assembled Markdown answer.
- `src/wiki/templates.ts` — Markdown renderers + managed-block sentinels.
- `src/wiki/types.ts` — `WikiPageType`, `WIKI_PAGE_TYPES`, DTOs, `GdWikiService` interface (incl. `ask`), `WikiAsk*` types.

**How it works.** Pages carry plain-text metadata lines (`Version:`, `Type:`,
`Status:` — regex-parsed, not YAML frontmatter). `wikiCollect` reads three
read-only sources — gdgraph `nodes.jsonl`/`edges.jsonl` (emits a `project-map` page
plus per-module `component` pages), health `latest.json` (a `quality-map` page), and
testing `context.md` (a `testing-map` page) — and rebuilds the index; missing
sources are skipped silently. A **draft-ownership guard** (`writeCollectedPage`)
means `collect` only overwrites a page still marked `Status: draft` with the literal
"Generated by `gd-metapro wiki collect`" marker; once a human edits it, it is left
untouched. `wikiGenerateIndex` maintains a managed block between
`WIKI_INDEX_BEGIN`/`END` sentinels, preserving surrounding human prose.
`wikiCheckLinks` walks all `.md` (except `templates/`), resolves internal links, and
reports broken ones. `wikiValidate` folds link checks + metadata checks +
index-staleness into one pass.

**Block C addition (`ask`).** `GdWikiService.ask` (`src/wiki/ask.ts`) answers a
question **deterministically** by lexical (Jaccard) retrieval scoped strictly to the
project's own collected wiki pages + current (non-superseded, in-validity) memory
entries — never an arbitrary corpus — returning the top-k **citations** and an
assembled Markdown answer. An optional embedding rerank reorders the citation set
when the memory embedding capability resolves; it never changes the set's provenance
and degrades back to the deterministic lexical order. It is exposed as an MCP **Tool**
(`wiki.ask`), alongside the wiki/memory trees served as read-only MCP **Resources**.

**Data & artifacts.** Wiki root `.metaproject/wiki/` (existence = "enabled"), pages
under `wiki/<folder>/<slug>.md`, `wiki/index.md`, `wiki/templates/page.md`, and the
link-check report `.metaproject/data/gdwiki/link-check/latest.md`. Reads (for
collect) `data/gdgraph/storage/{nodes,edges}.jsonl`,
`data/health/artifacts/latest.json`, `data/testing/context.md`. `init`/`update`
scaffold `modules/gdwiki.md` and `skills/gdwiki/SKILL.md`.

**Dependencies / integrations.** Node builtins + `lib/fs`, `lib/args`. Consumed by
`commands/init.ts`/`update.ts` (scaffolding) and `gdskills/verify.ts` (calls
`wikiValidate`). `collect` is deterministic and offline — it only reads other
modules' materialized artifacts, so it must run after those modules produce data.

---

## gdskills

**Purpose.** `gdskills` is the working-skills subsystem. It manages **bundled
skills** (a fixed code-defined catalog of ~90 skills installed into
`.metaproject/skills/gdskills/**`) and **project skills** (per-entity/per-module
skill packages generated under `.metaproject/project-skills/`). Around these it
provides routing, verification against repo evidence, auditable learning proposals,
export/sync to runtimes, and five JSON contract schemas with a built-in validator.
Everything is local-first: no network or global-runtime writes happen implicitly.

**CLI surface.** Dispatched by `skillsCommand`:

| Subcommand | Notes |
|---|---|
| `status [--json]` | local install status summary |
| `list [--json]` | registered project skills as a table |
| `inspect <project-skill> [--json]` | metadata + file presence |
| `route <query-or-target> [--json]` | ranked matches with reasons/follow-ups |
| `catalog [--profile minimal\|recommended\|full\|custom]` | bundled catalog Markdown |
| `install [--profile ...]` | installs bundled skills/catalog/manifest/contracts (needs `.metaproject/`) |
| `create <target>` / `generate <target>` | create a project-skill package (`--module`, `--name`, `--format`, `--dry-run`) |
| `verify <skill-or-target>` / `verify --all` | verify against evidence, write report (`--dry-run`, `--json`) |
| `learn <--from-*> --skill <m>/<s>` | create an auditable learning proposal (does NOT mutate SKILL.md) |
| `learn apply <proposal.json>` | apply a proposal to SKILL.md + changelog, bump patch version |
| `export <project-skill> --runtime codex\|claude` | export to a runtime artifact |
| `sync --runtime ... --target <dir>` | sync exported skills to an explicit dir only |
| `contracts list` / `contracts validate <file> --schema <name>` | list/validate JSON contracts |

`skill-verify-skill <skill-or-target>` is a top-level alias for `verify`. Profiles:
`minimal | recommended | full | custom` (unknown → `recommended`; `custom` resolves
to `recommended`).

**Key files.**
- `src/commands/skills.ts` — CLI router, arg parsing, route scoring, status aggregation, help.
- `src/gdskills/catalog.ts` — `BUNDLED_GDSKILLS`, profile filtering, SKILL.md/catalog/manifest renderers.
- `src/gdskills/install.ts` — installs bundled skills/rules/contracts.
- `src/gdskills/project-skills.ts` — creates project-skill packages, owns `ProjectSkillRegistryEntry`.
- `src/gdskills/resolve.ts` — resolves an input to a package root + registry entry.
- `src/gdskills/verify.ts` — collects evidence signals, classifies freshness, writes reports.
- `src/gdskills/learn.ts` — extracts lessons into proposals; applies reviewed proposals.
- `src/gdskills/export.ts` / `sync.ts` — runtime artifact export + safety-checked sync.
- `src/gdskills/contracts.ts` + `contracts/*.schema.json` — five schemas + hand-rolled validator.

**How it works.** **Bundled skills** are hardcoded via a `skill(...)` helper (name,
category, purpose, workflow, triggers, profiles) and installed by rendering a
`SKILL.md` (or copying a bundled source dir). **Project skills** are generated by
`createProjectSkill`, which slugifies module/name, collects `Evidence` (target
existence + gdgraph/gdctx/gdwiki artifacts), writes the package (`package` vs
`single` format), and registers it in the manifest. `route` is a keyword/heuristic
scorer (exact key/name +100, target substring +80, path +70, etc.). `verify`
collects signals (required files, metadata, registry membership, target existence,
gdgraph/gdctx/gdwiki/health/memory evidence) and classifies **fresh /
needs-review / stale / blocked**. `learn` splits into an auditable **proposal**
(never mutates SKILL.md) and **apply** (path-guarded, bumps patch version, appends
lessons only into allowed sections, writes an idempotency guard). `export` copies
safe dirs into `.metaproject/runtime/skills/<runtime>/...`; `sync` copies to an
explicit target validated to be inside the project or `$HOME` (never a root).
`contracts validate` runs a hand-written subset validator (`$ref`, `type`, `enum`,
`minimum`, `minLength`, `pattern`, `required`, `properties`, `additionalProperties`,
array `items`).

**Data & artifacts.** Under `.metaproject/`: `metaproject.json`
(`modules.gdskills.projectSkillRegistry`), `skills/gdskills/<category>/<name>/SKILL.md`,
`skills/catalog.md`, `modules/gdskills.md`, `core/gdskills/contracts/*.schema.json`,
`project-skills/<module>/<name>/`, `data/gdskills/reports/*-verification.json`,
`data/gdskills/proposals/<id>.{json,md}` + `<id>.applied.json`, and
`runtime/skills/<runtime>/<module>-<name>/`. Reads (evidence, read-only)
gdgraph/gdctx/gdwiki/health/memory artifacts.

**Dependencies / integrations.** Node/Bun builtins + `lib/args`, `lib/fs`,
`lib/json`, `lib/ui`. **Cross-module (verify only):** `memory/relevant`
(`relevantAcceptedMemory`) and `wiki/service` (`wikiValidate`). Bundled asset
resolution supports both dev and packaged layouts.

---

## health

**Purpose.** The `health` module is gd-metapro's **code-quality signal aggregator
and quality gate**. It runs (or imports the output of) a set of external and
built-in quality tools, normalizes their output into a uniform `Finding` model,
aggregates findings into per-scope **health scores** (project/module/component/
file/skill), compares each against a stored **baseline** to compute regressions and
trends, and evaluates a **pass/warn/fail gate** that can block a merge (non-zero
exit). Everything is file-based; per-skill attribution lets gdskills "learn from
health."

**CLI surface.** `gd-metapro health <subcommand>`:

| Subcommand | Behavior |
|---|---|
| `run [--strict] [--scope ...] [--changed [--since <ref>]] [--source ...]` | full pipeline; writes latest.json/md + history; **exit 1 if gate = fail** |
| `status` | reads latest.json: enabled?, last run, gate, score, regressions, per-source status, trend |
| `gate [--strict-warn]` | re-reads last gate (does not re-run); exit 1 if fail (or warn + `--strict-warn`) |
| `sources` | detect + list each source's mode/required/status without running tools |
| `explain <file-or-module>` | scope metrics + its findings (first 20) |
| `baseline update [--scope ...]` | write current scores into the baseline |
| `trend [--scope <key>] [--limit <n>]` | history-based trend line |

**Key files.** `commands/health.ts` (CLI), `health/service.ts` (facade),
`health/run.ts` (the run pipeline), `health/scoring.ts` (pure math), `health/scopes.ts`,
`health/gate.ts`, `health/config.ts`, `health/baseline.ts`, `health/history.ts`,
`health/report.ts`, `health/skills.ts` (file→skill ownership), plus `metrics/*`
(complexity/coverage/churn/**hotspot**) and `sources/*` (adapters).

**How it works.** Architecture is an **adapter (plugin) pattern + linear pipeline**.
Each quality tool is a `SourceAdapter` (`detect/run/import/parse`) registered in
`FINDING_ADAPTERS`: **ESLint** (error→P1/warning→P2), **TypeScript** (error→**P0**),
**Tests** (each failure→**P0**, reusing the testing module's report loader),
**dependency audit** (critical/high→P0), **SonarQube** (import-only, disabled by
default). Metric sources are handled separately: **coverage** (Istanbul summary,
import-only, feeds a penalty), **complexity** (built-in token-based cyclomatic,
emits P2 findings over threshold), **churn** (git numstat, informational).
Per-scope scoring: `risk_score` = Σ priority-weighted counts (P0=100, P1=20, P2=5,
P3=1); `health_score` = `clamp(100 - normalized)` with per-LOC normalization; trend
vs baseline; `regression_score` = baseline − current. The **gate** escalates
pass<warn<fail: any P0 → fail, regression ≥10 → fail (≥3 → warn), missing required
source → fail only under `--strict`, coverage below soft floor → warn. `strict` mode
makes auto-mode importers return `missing` instead of spawning tools.

**Block D addition (hotspots).** A churn×complexity **hotspot** signal
(`src/health/metrics/hotspot.ts`, `rankHotspots` — score = git churn × Σ per-function
cyclomatic complexity, ranked score-desc) is folded **additively** into `healthScore`
via `scoring.hotspotWeight`, which **defaults to `0`** — so default scores, the
baseline, and the gate are all unchanged out of the box — and is surfaced as
`report.hotspots`. `computeGate` is unchanged.

**Data & artifacts.** Under `.metaproject/data/health/`: `artifacts/latest.json`
(the full `HealthReport`, source for status/gate/explain), `artifacts/latest.md`
(human report), `history/<stamp>.json` (per-run snapshot), `raw/<source>/<stamp>.log`.
Baseline at `.metaproject/health/baselines/scores.json` (auto-seeded on first run).
Config `.metaproject/health.config.json`.

**Dependencies / integrations.** Bun runtime + git; external tools `eslint`, `tsc`,
`bun/npm`, `bun test` (resolved via local `node_modules/.bin` then `Bun.which`),
Istanbul coverage JSON, SonarQube issues export. Internal `lib/fs`, `lib/json`,
`lib/args`. **Cross-module:** the `tests` adapter reuses `testing/service` +
`testing/types`; `skills.ts` reads `modules.gdskills.projectSkillRegistry` to tag
`scope.skill`, feeding `gdskills learn --from-health`.

---

## testing

**Purpose.** The **testing** module gives gd-metapro a project-agnostic,
agent-facing view of a codebase's test setup and results. It (1) discovers and
persists reusable "testing context" (frameworks, scripts, test/config/CI files,
human-written conventions) and (2) runs the project's *existing* test runner
(optionally scoped to changed files), parsing raw output into a normalized JSON +
Markdown report. It is deliberately non-destructive — it never creates test files,
installs dependencies, or invents a stack.

**CLI surface.** `testCommand`:

| Subcommand | Flags | Behavior |
|---|---|---|
| `test init` / `test analyze` | — | scan tree, write context.{json,md} + recommendations (init is an alias of analyze) |
| `test run` | `--changed`, `--strict`/`--gate`, `--since <ref>`, `--scope <path>`, `--kind unit\|integration\|e2e\|smoke` | select → run runner → parse → write report; **exit 1 on fail/error** |
| `test status` | — | one-line summary (enabled, frameworks, test count, last run) |
| `test context` | — | print saved context + recommendations |
| `test report latest` | `--json` | print latest normalized report |
| `test related <file>` | — | tests related to a source file (naming/directory heuristics) |
| `test explain <file-or-scope>` | — | frameworks + related tests + failures filtered by target |

`--gate` is an alias for `--strict`.

**Key files.** `src/commands/test.ts` (thin dispatcher), `src/testing/service.ts`
(all domain logic — analyze, run, select, parse, persist, render), `coverage-map.ts`
(coverage-map Test Impact Analysis: parse/normalize/select), `types.ts` (data
contracts), `templates.ts` (config/manifest/hook generators).

**How it works.** `analyzeTestingProject` walks the tree, reads `package.json`
scripts/deps, classifies files by four regexes (test/config/CI/instruction),
detects frameworks (`bun/vitest/jest/playwright/cypress/testing-library`), and
harvests testing conventions. `runTesting` selects tests (changed-file selection via
git diff + related-by-naming, with a config-driven fallback when nothing matches),
resolves a command (prefer a package script, else direct `bun test`), runs it via
`Bun.spawn`, and parses failures/counts. Parsing is **bun-test-shaped** (`(fail)
<name>`, `N pass, N fail`); for other runners the exit code still drives pass/fail
but per-test extraction is approximate. The **strict gate** is the key rule:
`--strict --changed` with no matched tests is forced to fail (synthetic P0) when the
fallback isn't `"none"` — this makes the pre-push hook block. Note some declared
config (`changedSelection.strategies` incl. `gdgraph`, `runner` mode, `historyLimit`,
`keepRawLogs`) is **latent/aspirational** — not honored by current logic.

**Block D additions (coverage-map TIA + smoke tier).** An opt-in **Test Impact
Analysis** (`src/testing/coverage-map.ts`, the `coverageMap` capability) selects tests
**map-first** when a normalized `coverage-map.json` is present — intersecting changed
files/lines against a `testFile → coveredFiles` map parsed from **existing** lcov /
V8-bun coverage output (no bespoke instrumentation on the default path, no new
dependency) — and otherwise falls back to the **byte-identical** static changed-file
selection (`loadCoverageMap` returns `null` on an absent/malformed map, never throws).
An always-on **smoke tier** (`smoke.selectors`, **empty by default ⇒ no-op**) is
unioned into every selection mode, composing with rather than suppressing the
scoped/changed set. Any persisted raw coverage log is routed through the security
write seam.

**Data & artifacts.** Under `.metaproject/data/testing/`: `context.json`/`context.md`/
`recommendations.md` (from analyze), `artifacts/latest.json`/`latest.md` (newest
report), `history/<timestamp>.json`, `logs/latest.raw.log`. Config
`.metaproject/testing.config.json`. `loadCompatibleTestingReport` reuses a report
only if its gitRef + scope match the request (cache-validity check).

**Dependencies / integrations.** Bun runtime + optional `git` + the project's own
test runner; internal `lib/fs`, `lib/args`. Consumed by **Code Health** (the `tests`
adapter reads normalized reports via `loadCompatibleTestingReport`) and **gdskills**
(`learn --from-test` ingests `artifacts/latest.json`). Init-time file materialization
(config, hooks, SKILL.md, wiki page) is driven by `templates.ts` from the top-level
`gd-metapro init`, not `test init`.

---

## memory

**Purpose.** The `memory` module implements **long-term, typed project memory**: a
durable, agent-facing knowledge base of lessons, decisions, constraints, known
mistakes, patterns, and more. Markdown files under `.metaproject/memory/` are the
source of truth; the module reads, ranks, deduplicates, and consolidates them
**deterministically** by default — pure token/trigram similarity, with an optional
embedding rerank (Block C) that is opt-in and always degrades back to lexical. It is
a Mem0-style memory layer reimplemented deterministically, and it feeds a "learning
signal" (only `accepted` entries) into gdskills.

**CLI surface.** `memoryCommand`:

| Command | Usage |
|---|---|
| `memory new` | `new <type> [slug] --title "<t>" [--force]` — scaffold a draft entry; prints possible duplicates |
| `memory index` | build `data/memory/index/index.json` |
| `memory search` | `search "<q>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>] [--as-of <YYYY-MM-DD>] [--semantic]` — ranked retrieval (`current` by default; `--as-of` for a point-in-time view; `--semantic` opts into the embedding rerank) |
| `memory supersede` | `supersede <old-path> --by <new-path> [--date <YYYY-MM-DD>]` — non-destructively replace an entry (sets `Supersedes`/`Superseded-By`, closes the old validity interval) |
| `memory ingest` | `ingest --from-<review\|health\|job\|skill-verifier> <path>` — ADD/UPDATE entries |
| `memory check` | integrity lint; non-zero exit on issues |
| `memory reflect` | cluster entries by tag; create `pattern` drafts for clusters ≥ minClusterSize |

There are **11 entry types** (`MEMORY_TYPES`), of which `lesson`, `decision`,
`constraint`, `known-mistake` are first-class "new-able" MVP types.

**Key files.** `commands/memory.ts` (dispatcher), `memory/service.ts`
(`createMemoryService` facade: create/index/search/ingest/**supersede**/check),
`store.ts` (Markdown→`MemoryEntry` parser, incl. the bitemporal header), `search.ts`
(weighted ranking + optional semantic rerank), `dedup.ts`, `text.ts` (similarity
primitives), `ingest.ts` (ADD-or-UPDATE), `reflect.ts` (consolidation), `relevant.ts`
(cross-module lookup), `supersede.ts` (non-destructive replacement), `inject.ts`
(procedural-memory prompt injection), `embedding/` (opt-in embedding index over
`@xenova/transformers`), `check.ts`, `config.ts`, `templates.ts`.

**How it works.** **Markdown-as-database:** `parseEntry` extracts a structured
record from `# Title`, `Key: value` header fields, and `##` sections.
**Deterministic similarity** (`text.ts`): tokenize + jaccard + trigram
`titleSimilarity`. **Weighted linear ranking** (`search.ts`): score = Σ weight ×
{relevance, recency (exponential decay), confidence, status, scope}. **Mem0-style
lifecycle:** `ingest` = ADD new or reconcile (append provenance to) near-duplicates,
keyed on `(source, link, date)`; `reflect` = CONSOLIDATE tag-clusters into pattern
drafts (no LLM synthesis). Dedup marks a duplicate at title-similarity ≥ 0.8 or
summary-jaccard ≥ 0.6 with a shared scope/tag; conflict detection flags candidate
decisions/constraints against accepted ones (never auto-resolves). `check` lints
metadata, links, dedup, conflicts, and index presence. Note `reflect` and
`relevant` bypass the `MemoryService` interface (5 of the 6 subcommands).

**Block C additions (bitemporal + typing + embeddings).** Entries gained an optional
**bitemporal** header (`Class`, `Valid-From`, `Valid-To`, `Recorded-At`, `Supersedes`,
`Superseded-By`) parsed by `store.ts`; queries return `current` entries by default
and honor `--as-of <date>` for a point-in-time view, and `supersede.ts` records a
**non-destructive** replacement (sets both sides + closes the old validity interval,
idempotent — it never deletes). Entries authored before Block C omit these fields
and parse exactly as before. **Memory typing** maps every type to a knowledge class
via `MEMORY_CLASS_MAP` (`semantic`/`episodic`/`procedural`, total and defaulting to
`semantic`); `inject.ts` splices accepted, current, `procedural`-class memory into
task-implementer / flow prompts (`typing.injectClasses` defaults to `["procedural"]`).
An optional **embedding index** (`src/memory/embedding/` over `@xenova/transformers`,
resolved through the Capability Seam + Asset Resolver) is a **derived, disposable**
content-hash-keyed vector cache under `data/memory/embeddings/` that reranks the
lexical candidate pool; it never mutates the Markdown store, and lexical search stays
the default and the fallback on any unavailability or error.

**Data & artifacts.** Two roots: `memoryRoot` = `.metaproject/memory/` (Markdown
source of truth, one subfolder per type) and `dataRoot` =
`.metaproject/data/memory/` (generated: `index/index.json`, `artifacts/latest.md`,
`artifacts/latest.json`, and — only when the embedding capability is active — the
derived, disposable `embeddings/`). Config `.metaproject/memory.config.json`.

**Dependencies / integrations.** Node builtins + `lib/fs`, `lib/json`, `lib/args`;
the embedding runtime (`@xenova/transformers`) is an **optional** dependency imported
lazily only by the embedding adapter (default off). **Consumed by gdskills** via
`relevantAcceptedMemory` (the memory→skills
learning signal, `skills learn --from-memory`); `init`/`update` scaffold config/index/
skill files via `templates.ts`. `allowAutoAccept` is defined in config but never
read (latent flag).

---

## flow (tasks)

**Purpose.** The flow module implements an **agent-first, managed work lifecycle**:
each unit of work ("flow" / "story") is scaffolded into a self-contained package on
disk, driven through a strict status state machine, and finished only after passing
hard completion gates. The CLI is the **sole writer** of flow state — agents and
humans never edit `flow.json` or frozen acceptance criteria by hand. The CLI does
deterministic mechanics; cognitive work is layered on by gdskills subagents
(`flow-init`, `flow-manager`, `flow-complete`).

> **Naming note.** The **manifest module key is `tasks`** ("Task Manager") but the
> **command is `gd-metapro flow`**. Both names refer to the same module.

**CLI surface.** `flowCommand`:

| Subcommand | Behavior |
|---|---|
| `init (--issue <url> \| --title "<t>") [--slug <s>]` | scaffold a flow package |
| `list` | list all flows with status + task counts |
| `status <id>` | one flow: status, source, AC state, PR, tasks, last 5 history events |
| `freeze <id>` | record AC checksum, `initializing → ready` |
| `start <id>` | `ready → in-progress` |
| `task add <id> --title "<t>" [--kind context\|implement\|test\|review\|docs]` | append a task |
| `task done <id> <taskId>` | mark a task done |
| `ac confirm <id> <ACn> [--note "<evidence>"]` | confirm one acceptance criterion |
| `ac update <id> --reason "<why>"` | re-freeze AC checksum, void prior confirmations |
| `implemented <id> --pr <url>` | `in-progress → implemented`, record draft PR |
| `complete <id> [--comment]` | run completion gates; pass → `done`, fail → `in-progress` |
| `block <id> --reason "<why>"` | `* → blocked` (saves previous status) |
| `unblock <id>` | restore `previousStatus` |
| `check` | consistency audit across all flows |

`task`/`ac` are command groups; the atomic verbs are `task add`, `task done`,
`ac confirm`, `ac update`.

**Key files.** `commands/flow.ts` (dispatcher), `flow/service.ts` (lifecycle logic),
`flow/machine.ts` (transition table), `flow/store.ts` (persistence, id resolution, AC
checksums), `flow/context.ts` (deterministic context collection), `flow/types.ts`,
`flow/templates.ts` (package + manifest + subagent skill renderers),
`flow/tracker/github.ts` (GitHub adapter).

**How it works.** The state machine (`machine.ts`) runs
`initializing → ready → in-progress → implemented → completing → done`, with
`blocked` reachable from any non-terminal state and `unblock` restoring the saved
`previousStatus`. **AC freeze:** `acChecksum` normalizes the criteria file and
sha256s it; `freeze` refuses if there are zero real criteria; `assertAcIntact`
recomputes the checksum before most mutations and throws (directing to `ac update`)
if the file was edited outside the CLI. **Completion gates** (`complete`): (1)
acceptance-criteria (intact + every criterion confirmed), (2) pull-request (PR exists
+ checks green, or skipped if tracker unavailable), (3) health
(`deps.healthGate(cwd)`). `passed = gates.every(g => g.status !== "fail")` — **skipped
gates do not block**. Every mutation goes through `save()` which bumps `updatedAt`,
pushes history, writes `flow.json`, and appends to `journal.md`. The service is
constructed with `FlowServiceDeps` (`tracker`, `healthGate`, `now`) for testability.

**Data & artifacts.** Root `.metaproject/flows/`. Each flow is a directory
`<NNN>-<YYYY-MM-DD>-<slug>/` containing `flow.json` (CLI-owned state),
`description.md`, `context.md`, `plan.md`, `tasks.md`, `acceptance-criteria.md`,
`journal.md`. Context collection opportunistically reads (all optional)
`data/gdgraph/artifacts/*`, `data/health/artifacts/latest.json`, and
`metaproject.json`.

**Dependencies / integrations.** Node builtins (incl. `node:crypto`) + Bun runtime +
optional `gh` CLI. Internal `lib/fs`, `lib/args`, `lib/ui`. **Cross-module:**
`memory/{config,search,store}` enriches `context.md`; `health/service`
(`createCodeHealthService().gate`) is wired as the completion health gate. The GitHub
`TrackerAdapter` shells out to `gh` and degrades gracefully (gates become `skipped`)
when it is absent.

---

## security

**Purpose.** `security` is the newest module (bringing the total to **9**) — the
**agent input/output and artifact security layer**. It scans content for secrets,
PII, prompt-injection, and data-exfiltration (egress) signals, resolves those into
a policy decision (allow → warn → redact → require-approval → block), and evaluates
a pass/needs-approval/fail gate that can block a controlled write or CI run. It is
deliberately separate from `health` (which imports dependency findings as quality
signals) and from `security-audit` (dependency/committed-secret scanning): this
module protects prompts, external content, generated outputs, and `.metaproject/`
artifacts. It is **deterministic by default** (rule + entropy detectors; the model
backends are opt-in and default off) and **leak-safe** — findings never carry raw
sensitive values, only fixed-width masks and local-only HMAC hashes. The shipped
scope is spec §16 **Phase 1+2+3** (engine + CLI + write-seam integrations), extended
by roadmap-2026 **Block E** with modern exfil/PII detectors, a multi-runtime hook
registry, a red-team eval harness, and **opt-in** model backends (below); the
always-on gateway mode (Phase 4) remains **not** implemented.

**CLI surface.** Dispatched by `securityCommand`:

| Subcommand | Behavior | Exit |
|---|---|---|
| `security status` | print effective config: mode, raw retention, gate, config-checksum, per-policy action | 0 |
| `security scan <path> [--json] [--source <kind>]` | scan a file, resolve a decision, write `artifacts/latest.{md,json}` | mode-gated (see below) |
| `security check-input [--source <kind>] [--file <path>] [--json]` | evaluate incoming content (default source `untrusted-external`; stdin if no `--file`) | mode-gated |
| `security check-output [--target <kind>] [--file <path>] [--json]` | evaluate generated content (default source `generated`, target `unknown`) | mode-gated |
| `security redact <path> [--out <path>]` | mask detected spans; write `--out` or print to stdout | 0 |
| `security report [--since <ref>] [--json]` | aggregate the last scan artifact (no re-scan) into a category summary | **1 in `ci` mode when gate = fail** |
| `security policy validate` | schema-validate the config + verify config checksum | **1 on schema/checksum failure** |
| `security incidents [--limit <n>]` | list the append-only incident trail (newest first) | 0 |

The mode-gated commands honor `config.mode`: **advisory** (default) always exits
`0`; **ci** exits `1` on a gate **fail**; **enforced** exits `1` on **fail** or
**needs-approval**.

**Key files.**
- `src/commands/security.ts` — CLI dispatcher, arg/flag parsing, rendering, exit-code mapping, help.
- `src/security/service.ts` — `analyze`/`runScan`/`runReport`/`runGate` + the `createSecurityService` in-process contract (advisory-safe `check`, `redact`, `report`, `gate`).
- `src/security/detect/` — the deterministic detectors: `secrets.ts`, `entropy.ts`, `pii.ts` (checksum-validated structured PII), `injection.ts`, `egress.ts`, `exfil.ts` (markdown-image/EchoLeak), `mcp.ts` (MCP-manifest scan), plus `index.ts` (`runDetectors` + overlap dedup); opt-in model adapters live under `detect/injection/adapter.ts` (Prompt Guard 2) and `detect/pii/ner-adapter.ts` (NER).
- `src/security/agent-hooks/runtimes.ts` — multi-runtime agent-hook registry; `src/security/eval/harness.ts` — labeled-corpus red-team eval harness.
- `src/security/resolve.ts` — finding construction, action precedence, injection→egress escalation, confidence gate, `computeGate`.
- `src/security/redact.ts` — fixed-width masks, safe `redactedPreview`, local-only HMAC key management + `hmacHash`.
- `src/security/self-protect.ts` — config-checksum / mode-downgrade / disabled-policy self-protection.
- `src/security/report.ts` — report building + committable artifact writing.
- `src/security/config.ts` — `DEFAULT_SECURITY_CONFIG`, load/merge, `computeConfigChecksum`/`verifyConfigChecksum`, `validateSecurityConfig`.
- `src/security/incidents.ts` — append-only JSONL incident trail.
- `src/security/{schemas,templates,types}.ts` — JSON-schema subset, scaffold renderers, and the type surface.

**How it works.** The pipeline is **detectors → resolution/gate → report**.
`runDetectors` runs each *enabled* detector category (entropy additionally gated by
the entropy backend flag) and de-duplicates overlapping spans, keeping the strongest
signal per region. `resolveDecision` turns each match into a `SecurityFinding`,
applying a **confidence gate** (a match below the policy's `minConfidence` is
downgraded to `warn`) and the **injection→egress escalation** (a lone prompt-injection
signal stays `warn`; when an egress signal co-occurs it is escalated to the
prompt-injection policy action). The decision's action is the **strongest** across
findings by the precedence `block > require-approval > redact > warn > allow`;
`computeGate` maps findings to `pass` / `needs-approval` / `fail` (any `block` action
or any finding at/above `gate.failOn` severity fails). **Leak-safety** is structural:
`buildFinding` never stores the raw value — only an HMAC-SHA256 hash (per-project key,
local-only) and a fixed-width `[REDACTED:…]` mask, with the `redactedPreview` masking
*every* sensitive span in the surrounding window so a preview can't reveal a
neighbouring secret. **Self-protection** (`evaluateSelfProtection`) folds extra
findings into the decision when the config checksum mismatches (policies edited
outside the tool), the mode is downgraded, or a policy is disabled — each also
appends an incident. Reports are written to `data/security/artifacts/latest.{md,json}`;
`report`/`gate` read that artifact and never re-scan.

**Block E additions (roadmap-2026 hardening).** Modern data-exfiltration detectors
(`src/security/detect/exfil.ts`) flag markdown-image / auto-render **EchoLeak**-style
leaks (CVE-2025-32711) against a `policies.egress.allowlist` (deny-by-default), and
`egress.ts` adds always-on **SSRF / cloud-metadata** host detection (RFC-1918 /
loopback / link-local / `metadata.google.internal`). Structured-PII validators are now
**checksum-verified** (`detect/pii.ts`: IBAN mod-97, credit-card Luhn, US-SSN range,
IP) so invalid-checksum candidates are not flagged. Agent hooks became **multi-runtime**
(`agent-hooks/runtimes.ts`: claude / cursor / windsurf / generic-mcp), and a
labeled-corpus **red-team eval harness** (`eval/harness.ts`, `security eval [--corpus
<injection\|exfil\|structured-pii\|secret\|all>] [--with-model]`) proves detection
quality against committed fixtures. Two **opt-in** model backends sit on the
`backends` config seam — both **default off**, resolved through the Capability Seam +
Asset Resolver: a **Prompt Guard 2** injection adapter (`detect/injection/adapter.ts`,
`backends.injectionModel`) and an **NER PII** adapter (`detect/pii/ner-adapter.ts`,
`backends.piiModel`). All remain leak-safe and degrade to the deterministic rule
detectors when a dependency/asset is unavailable.

**Data & artifacts.** Config `.metaproject/security.config.json` (seed-once). Data
root `.metaproject/data/security/` with subtrees `artifacts/` (committable
`latest.{md,json}`), `incidents/` (append-only JSONL trail), `redactions/`,
`policies/`, and `raw/`. **`raw/` is gitignored and local-only** — it holds the
per-project HMAC key (`hmac.key`, generated on first use) and a `report.local.json`,
so hashes stay unlinkable across machines and no raw sensitive material is committed.
Default `mode` is `advisory` and default `rawRetention` is `off`.

**Dependencies / integrations.** Node builtins only (`node:crypto` for HMAC + config
checksum, `fs/promises`, `path`) + internal `lib/fs`, `lib/args`, `lib/json`,
`lib/ui`. `init`/`update` scaffold the config, `modules/security.md`, and
`core/security/README.md` via `security/templates.ts`.

**Write-seam integrations (Phase 3).** A shared in-process guard
(`src/security/guard.ts`, exporting `guardOutput` / `redactRaw` /
`securityFlowGate` / `formatGuardWarning`) wraps the frozen Phase 1+2 engine and is
now called at **five write seams** — the first real inbound calls into this module
from other modules:

- **memory ingest** (`src/memory/ingest.ts`, `target: memory`) — before writing each accepted entry;
- **wiki collect** (`src/wiki/service.ts`, `target: wiki`) — before writing a collected draft;
- **testing** (`src/testing/service.ts`, `target: report`) — before persisting the captured raw log;
- **gdctx** (`src/commands/ctx.ts`, `redactRaw`) — redacts secrets from raw output before persist/summarize;
- **flow complete** (`src/commands/flow.ts` → `flow/service.ts` gate 4, `securityFlowGate`) — a `security` completion gate.

Semantics are uniform: **advisory (default) reports and continues — it never
blocks or mutates** (the gdctx seam still redacts detected secrets, a pure safety
step); **enforced/ci blocks or suppresses the write with a masked category+count
reason**; **disabled is a zero-cost no-op**. The guard degrades to allow on any
engine error, imports only from the engine + shared libs (so the seam stays
acyclic), and never leaks raw content into reasons or logs.

**Hooks (Phase 4).** Two optional hooks extend enforcement to surfaces outside
`gd-metapro`'s own workflows. Both are offered by `init` **only when `security` is
enabled**, default on (confirm prompt; accepted under `--yes`), and no-op when the
module is disabled. Both honor `config.mode` — **advisory (the default) warns but
never blocks; enforced/ci block**.

- **git pre-push gate** — `installSecurityPrePushHook` (`src/commands/init.ts` →
  `renderSecurityPrePushHook` in `src/lib/templates.ts`) writes a managed
  `# gd-metapro:security-pre-push:begin…:end` block into `.git/hooks/pre-push`. It
  runs `gd-metapro security scan <file> --source trusted-project` over each changed
  file in the push range and delegates blocking to the CLI exit code (advisory
  exits 0/warns; enforced/ci exit non-zero and block the push). It coexists with
  the testing pre-push block and user content, degrades to a skip if `gd-metapro`
  is not on `PATH`, and is recorded in the manifest at `security.hooks.prePush`.
  Opt out with `--no-security-hook`.
- **agent `.claude/settings.json` hook** — `installSecurityAgentHooks`
  (`src/security/agent-hooks.ts`) merges, merge-safely (a `_gdMetaproManaged:
  "security-agent-hooks"` sentinel keeps re-install idempotent and preserves all
  existing settings/hooks), two Claude Code hooks: `UserPromptSubmit` →
  `gd-metapro security check-input --source untrusted-external` and
  `PreToolUse(Write|Edit)` → `gd-metapro security check-output`. Claude
  Code-specific, project-local, advisory by default; recorded at
  `security.hooks.agent`. Opt out with `--no-security-agent-hook`.

`update` refreshes each hook only when the manifest already records it.

---

## mcp

**Purpose.** `mcp` (Block A, roadmap-2026) is a **new, opt-in, cross-cutting module**
that exposes gd-metapro's existing module **service facades** over the **Model Context
Protocol** so an external agent can call them as MCP **Tools** and read generated
`.metaproject/` artifacts as read-only MCP **Resources**. It adds no new domain logic:
every Tool is a thin wrapper that shapes input, calls one facade method, and returns
the typed result. It is **stdio-first** (an isolated localhost HTTP/SSE transport is a
further opt-in), and `modules.mcp` **defaults off** — the module entry + config are
scaffolded only via `init --mcp`.

**CLI surface.** Dispatched by `mcpCommand`:

| Subcommand | Behavior |
|---|---|
| `mcp` / `mcp serve` | run the stdio JSON-RPC MCP server (default) |
| `mcp serve --http` | use the isolated localhost HTTP/SSE transport (requires `http.enabled`) |
| `mcp --help` / `-h` | usage |

**Key files.**
- `src/commands/mcp.ts` — thin handler; parses `serve`/`--http`, never imports the SDK.
- `src/mcp/server.ts` — stdio-first server loop; lazy-loads `@modelcontextprotocol/sdk` via `await import()` and hard-fails with an actionable message when it is absent (the sanctioned opt-in exception).
- `src/mcp/tools.ts` — the Tool registry over the gdgraph/security/memory/health/wiki/flow/standard facades.
- `src/mcp/resources.ts` — the read-only `metaproject://<class>/<relpath>` Resource registry (`artifacts`/`wiki`/`memory`), path-confined to each class root.
- `src/mcp/dispatch.ts`, `discovery.ts`, `config.ts`, `redact-seam.ts`, `transport/{stdio,http-sse}.ts`.

**How it works.** Tools wrap the module facades (`createSecurityService`,
`createMemoryService`, `createCodeHealthService`, `createGdWikiService`,
`createFlowService`, `runValidate`) plus gdgraph's pure query module
(`getAffected`/`getCycles`/`getOrphans`/`loadGraph`); there is no logic in `mcp/`
beyond input shaping. Resources
enumerate and read on-disk generated artifacts only — no computation, no mutation —
and every URI is resolved and **confined** to its class root (any path escaping the
root is rejected). The module is boundary-guarded: an import test enforces that
`src/mcp/` imports **only** service facades + `src/lib/*` + the security `guard` seam
(never a module's internals), and the golden-rule static guard forbids any top-level
import of the MCP SDK anywhere in `src/`.

**Data & artifacts.** Reads (read-only) the generated `.metaproject/` trees it serves
as Resources (`data/**/artifacts`, `wiki/`, `memory/`). Config
`.metaproject/core/mcp/mcp.config.json` (deep-merged over defaults: transport, HTTP
host/port default off, Tool include/exclude, Resource roots). `init --mcp` scaffolds
the `core/mcp/` structure + config and the `modules.mcp` manifest entry.

**Dependencies / integrations.** Node/Bun builtins + `lib/*` + each module's service
facade + the security `guard` seam; the MCP SDK (`@modelcontextprotocol/sdk`) is an
**optional** dependency loaded lazily only in `server.ts`. It is the outbound consumer
of every other module's facade — the first cross-module integration that reaches in
through the public service contracts rather than the shared file workspace.

---

## rules

**Purpose.** The `rules` module keeps a project's root agent entrypoints
(`AGENTS.md`, `CLAUDE.md`, and manifest-declared variants) in sync with the generated
`.metaproject/` workspace so agents reliably route through Metaproject tooling. It
(1) **syncs** — imports each root entrypoint verbatim into `.metaproject/rules/`
and injects/upgrades a managed "Metaproject" routing block into the root file — and
(2) **distills** — splits large monolithic entrypoints into typed artifacts
(project rules, procedural skills, or root-only instructions), rewriting the root to
keep only global/always-on instructions plus the managed block.

**CLI surface.** `rulesCommand`:

| Command | Description |
|---|---|
| `rules` / `rules --help` / `rules -h` | usage |
| `rules sync` | import root entrypoints into `.metaproject/rules/`, inject managed block, refresh index |
| `rules distill` | split large entrypoints into high-priority rules + project skills |
| any other | "Unknown rules command" + help + exit 1 |

Only `sync` and `distill` are accepted; the only recognized flag is `--help`/`-h`.

**Key files.**
- `src/rules/agent-entrypoints.ts` — sync engine: discover entrypoints, write import mirrors, inject/upgrade the managed `<!-- gd-metapro:index -->` block (`syncAgentRules`, `ensureMetaprojectReference`).
- `src/rules/distill.ts` — distillation engine: section split + classify + emit rules/skills/root, rewrite root, write index (`distillAgentEntrypoints`).
- `src/commands/rules.ts` — `rules sync`/`distill` handler + help.

**How it works.** Patterns: **idempotent writes** (`writeTextIfChanged`/`IfMissing`),
a **managed marker block** (`<!-- gd-metapro:index -->` sentinel — everything after
is regenerated, everything before preserved), **policy migration/self-healing**
(`ensureMetaprojectReference` migrates old policy strings, de-duplicates, removes the
flow policy when tasks are disabled, appends missing policies), **feature-flag
gating** (`enableTasks` from `modules.tasks.enabled`), and **symlink de-duplication**
(realpath-based, so an `AGENTS.md`→`CLAUDE.md` symlink isn't imported twice).
**Distill is a superset of sync:** it runs `syncAgentRules` first, then splits each
source into sections via `splitMarkdownSections`, classifies each heuristically
(`classifySection` — root vs skill vs rule by keyword signal sets), and emits typed
artifacts with frontmatter. The classifier is intentionally biased toward
rule/skill capture.

**Data & artifacts.** Reads `.metaproject/metaproject.json`
(`modules.<name>.enabled`, `agentEntrypoints.root`) and writes it back with the
synced sources. Outputs: `.metaproject/rules/<slug>.md` (import mirrors),
`.metaproject/rules/README.md`, `.metaproject/skills/project-rules/README.md`,
`.metaproject/rules/entrypoints/<slug>.md` (distilled rules),
`.metaproject/project-skills/entrypoints/<slug>/SKILL.md` (distilled skills),
`.metaproject/rules/entrypoints/index.md`, refreshed `.metaproject/index.md`, and the
root `AGENTS.md`/`CLAUDE.md` (created if missing, managed block injected; fully
rewritten on distill). Requires `.metaproject/` to exist, else throws.

**Dependencies / integrations.** Node builtins only + `lib/fs` (`pathExists`) and
`lib/templates` (entrypoint/rules/index renderers). **Cross-cutting:**
`syncAgentRules`/`ensureMetaprojectReference` are also invoked by `init`/`update`
during workspace bootstrap/refresh, so this module's sync engine runs beyond its own
command. No co-located tests exist — the heuristic classifier and policy-migration
logic are the highest-risk untested areas.

---

## shared-lib

**Purpose.** `src/lib/` is the cross-cutting utility toolkit every feature module and
command handler builds on. It provides six small, dependency-light modules: CLI
argument extraction, filesystem predicates, JSON file I/O, interactive terminal
prompts, terminal styling/UI output, and — by far the largest — a template library
that renders the entire `.metaproject/` workspace scaffold (Markdown manifests, an
HTML dashboard, shell git-hooks, config files, skill/rule docs) as strings. There is
no orchestration or domain logic here.

**CLI surface.** None — `lib/` is a library layer, not a command. It is consumed by
every other module (import counts: `fs` 32, `json` 10, `args` 8, `templates` 8,
`ui` 6, `prompt` 1).

**Key files / API.**
- `args.ts` — `optionValue(args, name)`: the token following a named flag (the project's only flag reader).
- `fs.ts` — `pathExists` (most-used helper), `toPosix`, `isPathInside` (workspace-boundary guard).
- `json.ts` — `readJsonFile<T>` (rethrows `Invalid JSON in <path>`), `readJsonFileOr<T>` (returns fallback on failure).
- `prompt.ts` — `confirm`, `choice<T>`: TTY prompts that return defaults when stdin isn't a TTY (CI-safe). Depends on `ui.ts`.
- `ui.ts` — `colorEnabled`, `style`, `symbols`, `banner`, `heading`, `statusLine`, `nextSteps`, `note`, and `help*` renderers.
- `templates.ts` — ~23 `render*(): string` builders (~1836 LOC) that materialize the generated agent workspace: `renderIndexMarkdown`, `renderMetaprojectDashboardHtml` (+ `MetaprojectDashboardData` type), agent-entrypoint/rules renderers, config/gitignore renderers, git-hook script renderers, and gdgraph/gdctx scaffold renderers.

**How it works.** Flat utility library — named functions, no classes/DI/barrel;
callers import files directly. Key patterns: **pure string templating** (the whole
`.metaproject/` scaffold is generated from TS template literals, no engine),
**feature-flag composition** (`renderIndexMarkdown`/dashboard take 8 boolean
`enable*` flags and conditionally include sections), **TTY-aware graceful
degradation** (`ui`/`prompt` detect `isTTY`/`NO_COLOR`/`FORCE_COLOR`), **fail-soft
I/O** (`readJsonFileOr`/`pathExists` swallow errors), and a **self-contained HTML
dashboard** (all CSS/JS + page Markdown inlined because `fetch` is blocked under
`file://`).

**Data & artifacts.** `lib/` reads no config itself but *produces* config content
(`renderGdctxConfig` emits `gdctx.config.json` defaults). `ui.ts`/`prompt.ts` read
env vars `NO_COLOR`/`FORCE_COLOR`. The strings it renders become nearly every file
`init`/`update`/`dashboard`/`rules` write to `.metaproject/`.

**Dependencies / integrations.** Node/Bun builtins only (`fs/promises`, `path`,
`process`, `readline/promises`); no third-party runtime libraries. The only intra-lib
edge is `prompt.ts → ui.ts`; `lib/` depends on nothing else (it is the bottom layer).
`templates.ts` is effectively the source of truth for the agent-facing
`.metaproject/` contract — the workspace format lives there.
