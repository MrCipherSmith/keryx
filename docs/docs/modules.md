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

---

## cli-core

**Purpose.** The CLI core is the entrypoint and lifecycle layer. It owns the argv
dispatcher (`src/cli.ts`) and the four cross-cutting lifecycle commands — `init`,
`update`, `dashboard`/`dash`, `status` — plus `MODULE_COMMANDS`, the single source
of truth for each module's canonical subcommand list. Its job is to parse the
top-level subcommand, scaffold the workspace and its eight optional modules, keep
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
| `gdgraph`, `ctx`, `wiki`, `skills`, `skill-verify-skill`, `health`, `test`, `memory`, `flow`, `rules` | routed to the feature module handler |
| unknown | error + help + exit 1 |

Key lifecycle flags: `init` accepts `--yes/-y`, `--no-<module>` for each of the 8
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
enablement for 8 modules (`gdgraph, gdctx, gdwiki, gdskills, health, testing,
memory, tasks`), scaffolds base + per-module dirs, installs managed git hooks
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
- `affected <file>` — prints a Markdown block with `## Dependencies` and `## Dependents`.
- `--help`/`-h`/no args — usage.

Only `cycles` and `orphans` are valid queries (anything else errors, exit 1). No
other flags exist (`--json`, `--output`, depth limits are not implemented). Unless
`GD_METAPRO_GDGRAPH_LOCAL=1`, the command first tries to delegate to a project-local
`.metaproject/core/gdgraph/cli.ts`, letting a project pin its own gdgraph version;
if that file is absent the built-in implementation runs.

**Key files.**
- `src/commands/gdgraph.ts` — dispatcher, local-runner delegation, help, output.
- `src/gdgraph/build.ts` — filesystem walk, import-specifier extraction, resolution, artifact writing.
- `src/gdgraph/query.ts` — graph loading + the three query algorithms.
- `src/gdgraph/types.ts` — `GraphNode`, `GraphEdge`, `GraphData`.

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

**Data & artifacts.** Storage `.metaproject/data/gdgraph/storage/`: `nodes.jsonl`,
`edges.jsonl`. Artifacts `.metaproject/data/gdgraph/artifacts/`: `module-map.json`
(module → file paths) and `summary.md` (stats, top modules, unresolved imports,
skipped dirs, next-command hints).

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

Eight fixed page types (`WIKI_PAGE_TYPES`), each mapping to a folder: `architecture`,
`domain-model`, `business-rule`, `user-scenario`, `component`, `service`,
`integration`, `decision`. `--limit` defaults to 12.

**Key files.**
- `src/commands/wiki.ts` — thin CLI handler.
- `src/wiki/service.ts` — all domain logic (status/create/index/collect/check-links/validate + collectors).
- `src/wiki/templates.ts` — Markdown renderers + managed-block sentinels.
- `src/wiki/types.ts` — `WikiPageType`, `WIKI_PAGE_TYPES`, DTOs, `GdWikiService` interface.

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
(complexity/coverage/churn) and `sources/*` (adapters).

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
(all domain logic — analyze, run, select, parse, persist, render), `types.ts` (data
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
**deterministically** — no LLM, no embeddings, pure token/trigram similarity. It is
a Mem0-style memory layer reimplemented deterministically, and it feeds a "learning
signal" (only `accepted` entries) into gdskills.

**CLI surface.** `memoryCommand`:

| Command | Usage |
|---|---|
| `memory new` | `new <type> [slug] --title "<t>" [--force]` — scaffold a draft entry; prints possible duplicates |
| `memory index` | build `data/memory/index/index.json` |
| `memory search` | `search "<q>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>]` — ranked retrieval |
| `memory ingest` | `ingest --from-<review\|health\|job\|skill-verifier> <path>` — ADD/UPDATE entries |
| `memory check` | integrity lint; non-zero exit on issues |
| `memory reflect` | cluster entries by tag; create `pattern` drafts for clusters ≥ minClusterSize |

There are **11 entry types** (`MEMORY_TYPES`), of which `lesson`, `decision`,
`constraint`, `known-mistake` are first-class "new-able" MVP types.

**Key files.** `commands/memory.ts` (dispatcher), `memory/service.ts`
(`createMemoryService` facade: create/index/search/ingest/check), `store.ts`
(Markdown→`MemoryEntry` parser), `search.ts` (weighted ranking), `dedup.ts`,
`text.ts` (similarity primitives), `ingest.ts` (ADD-or-UPDATE), `reflect.ts`
(consolidation), `relevant.ts` (cross-module lookup), `check.ts`, `config.ts`,
`templates.ts`.

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

**Data & artifacts.** Two roots: `memoryRoot` = `.metaproject/memory/` (Markdown
source of truth, one subfolder per type) and `dataRoot` =
`.metaproject/data/memory/` (generated: `index/index.json`, `artifacts/latest.md`,
`artifacts/latest.json`). Config `.metaproject/memory.config.json`.

**Dependencies / integrations.** Node builtins only + `lib/fs`, `lib/json`,
`lib/args`. **Consumed by gdskills** via `relevantAcceptedMemory` (the memory→skills
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
