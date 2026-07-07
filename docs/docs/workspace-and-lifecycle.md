# Workspace & Lifecycle

`gd-metapro` has exactly one product: the per-project `.metaproject/` workspace — a
file-based "agent operating system" that materializes a repo's structure, quality,
tests, conventions, and history as durable, human-editable Markdown plus
machine-readable JSON. The CLI itself only performs deterministic mechanics
(scaffold, refresh, score, checksum, render); the "thinking" is delegated to the
agent skills the workspace ships.

This page is the contract for that directory: its layout, the source-of-truth vs
generated split, the `metaproject.json` manifest, the agent entrypoints, and how
`init` / `update` build and keep it fresh without ever destroying accumulated
project knowledge.

## The `.metaproject/` directory layout

```text
.metaproject/
├── metaproject.json            # MANIFEST — authoritative runtime config (see below)
├── index.md                    # agent entrypoint: module/rules/skills/workflow/data map
├── README.md                   # human-oriented workspace readme (seed-once)
├── gd-metapro-dashboard.html   # self-contained human dashboard (offline, file://-safe)
├── *.config.json               # per-module config, seed-once: gdctx / health / testing / memory
├── core/                       # vendored runtime scripts per module (e.g. gdgraph build/query/cli)
├── data/                       # GENERATED artifacts — NEVER written by init/update (see invariant)
├── rules/                      # imported + distilled agent rules (source of truth)
│   └── entrypoints/            #   distilled project rules + distilled index.md
├── skills/                     # installed bundled skills (SKILL.md) — regenerated each run
│   └── project-rules/          #   project-rules skill readme
├── project-skills/<m>/<n>/     # project skills — source of truth, human/agent-authored
│   └── entrypoints/<slug>/     #   distilled skills (SKILL.md) from `rules distill`
├── wiki/                       # knowledge-base pages (source of truth)
├── memory/                     # typed memory entries — Markdown, source of truth
├── flows/<NNN>-<date>-<slug>/  # flow (task) packages; flow.json is CLI-owned state
├── modules/                    # per-module manifests + READMEs
├── hooks/                      # hooks readme + post-update.d/ (executables run by `update --hooks`)
└── reports/                    # scratch report output (gitignored)
```

The `data/` subtree fans out per feature module — each module owns and writes only
its own subtree at runtime:

```text
data/
├── gdgraph/{storage,artifacts,summaries,queries}/   # import/dependency graph (nodes/edges JSONL)
├── health/{artifacts,history,raw}/                  # quality scores + baseline history
├── testing/{artifacts,history,logs,context.md}/     # normalized test reports
├── gdctx/{raw,artifacts}/                            # compacted git/rg/shell captures
├── gdwiki/{artifacts,link-check}/                    # wiki link checks / collected drafts
└── memory/{index,artifacts}/                         # typed memory index outputs
```

## Source of truth vs generated `data/` — the data-vs-service invariant

The central invariant of the whole system is a strict split inside `.metaproject/`:

- **Service files** — templates, manifests, skills, hooks, dashboard, config,
  `index.md`. These are *regenerated* by `init` / `update`, reconciled to the
  rendered template on every run.
- **Data artifacts** — everything under `.metaproject/data/**`. These are module
  run outputs and are **NEVER written by the lifecycle commands**. Each feature
  module writes only its own `data/<module>/` subtree at runtime; the lifecycle
  layer treats `data/` as read-only and, after a refresh, explicitly reports
  "Data artifacts were left untouched."

This separation is what lets a self-update refresh the toolchain (new templates,
new skills, new hook scripts) without destroying accumulated project knowledge
(the graph, health history, test reports, wiki, memory, flows).

Source-of-truth trees (`wiki/`, `memory/`, `project-skills/`, `rules/`) are seeded
once by `init` or by module `new`/`create` commands, then owned by the human. The
tooling guards them: `writeTextIfMissing` seeds and never clobbers; gdwiki only
overwrites still-unmodified generated drafts; gdskills `learn` never mutates a
`SKILL.md` without an explicit `apply`; flow's `flow.json` is the CLI's exclusive
writer with an AC-checksum tamper check.

### Versioned vs gitignored

`init` injects a managed block into the repo's root `.gitignore` (delimited by
`# gd-metapro:begin … # gd-metapro:end`, replacing any legacy `.metaproject/`
lines). The policy is: **keep agent-facing context versioned, ignore
executable/generated internals.** The current block:

```gitignore
# gd-metapro:begin
# Metaproject: keep agent-facing context versioned, ignore executable/generated internals.
.metaproject/runtime/
.metaproject/core/**/*.ts
.metaproject/data/**/storage/
.metaproject/data/**/raw/
.metaproject/data/**/queries/
.metaproject/data/**/summaries/
.metaproject/data/gdctx/artifacts/
.metaproject/data/gdwiki/artifacts/
.metaproject/data/gdwiki/link-check/
.metaproject/data/health/history/
.metaproject/data/health/artifacts/latest.md
.metaproject/data/health/artifacts/latest.json
.metaproject/data/testing/history/
.metaproject/data/testing/logs/
.metaproject/data/testing/artifacts/latest.md
.metaproject/data/testing/artifacts/latest.json
.metaproject/reports/
# gd-metapro:end
```

| Ignored (not versioned) | Versioned (committed) |
|---|---|
| `runtime/` (the self-updating CLI clone) | `metaproject.json`, `index.md`, `README.md` |
| `core/**/*.ts` (vendored, re-copied on update) | `rules/`, `skills/`, `project-skills/`, `wiki/`, `memory/`, `flows/` |
| `data/**/storage`, `raw`, `queries`, `summaries` | `data/**` summaries/reports that *aren't* listed (durable, human-facing) |
| gdctx/gdwiki `artifacts/`, gdwiki `link-check/` | the dashboard HTML and per-module manifests/READMEs |
| health/testing `history/`, `logs/`, and `latest.{md,json}` | |
| `reports/` | |

The rule of thumb: *raw and re-derivable* outputs are ignored; the *distilled,
agent-facing* narrative (wiki, memory, rules, skills, flows, manifest, index) is
committed so a clone carries its context with it.

## The `metaproject.json` manifest

`metaproject.json` is the single authoritative runtime config. A freshly-init'd
manifest records:

- `schemaVersion` (currently `1`), `name` (`"<project>-metaproject"`),
  `createdBy: "gd-metapro"`.
- `paths{}` — resolved workspace paths (`root`, etc.).
- `agentEntrypoints{ root: string[], metaproject: ".metaproject/index.md" }` —
  the discovered root entrypoint sources plus the workspace index (see below).
- `modules{}` — a map keyed by **module id**, one entry per module. Each entry
  carries:
  - `enabled` — whether the lifecycle commands scaffold/refresh it (8 modules are
    optional and default on).
  - per-module settings — e.g. gdskills stores `profile`, `skills`, `catalog`,
    `projectSkills`, and a `projectSkillRegistry[]`.
  - `hooks{ gitPostCommit?, prePush?, postUpdate }` — which git hooks this module
    installs.
  - `commands[]` — the module's canonical CLI subcommand list.

### `commands[]` comes from `MODULE_COMMANDS` (single source of truth)

The `commands[]` arrays are never hand-written into the manifest. `src/commands/
module-commands.ts` holds `MODULE_COMMANDS`, one canonical subcommand list per
module id, and the helper `moduleCommands(id)` returns a *fresh mutable copy*.
Both `init` (`buildManifest`) and `update` (`refreshServiceFiles`,
`writeRecoveredManifest`, `enableTasksInManifest`) fill `commands[]` from exactly
this one place, and `module-commands.test.ts` enforces that the generated manifest
stays in sync with the routers.

Current canonical lists:

| Module id | Subcommands |
|---|---|
| gdgraph | build, query, affected |
| gdctx | status, diff, rg, read, run, show |
| gdwiki | status, new, collect, index, check-links, validate |
| gdskills | status, list, inspect, route, catalog, install, create, verify, learn, export, sync, contracts |
| memory | new, index, search, ingest, check, reflect |
| tasks | init, list, status, freeze, start, task, ac, implemented, complete, block, unblock, check |
| health | run, status, gate, sources, explain, baseline, trend |
| testing | init, analyze, run, status, context, explain, related, report |

**Naming skew to remember:** the manifest key `tasks` corresponds to the CLI verb
`flow` (the flow command routes the `tasks` subcommand set), and the manifest key
`gdwiki` corresponds to the CLI verb `wiki` (legacy `wiki` manifest keys are
migrated forward on read).

## Agent entrypoints and the managed routing block

`AGENTS.md` / `CLAUDE.md` at the repo root are the agent's front door. The `rules`
module keeps them in sync with the workspace so any agent that reads the root file
is routed through Metaproject tooling.

**Sync (`rules sync`, also run by `init`/`update`).** For each discovered root
entrypoint, `syncAgentRules` imports the file verbatim into
`.metaproject/rules/<slug>.md` (a high-priority "imported rule" mirror) and injects
an idempotent managed block, delimited by the sentinel `<!-- gd-metapro:index -->`,
directly into the root file. Everything after the sentinel is regenerated;
everything before it (the human's own prose) is preserved. The block adds per-skill
routing policies (consult `.metaproject/index.md` and the module skills before
doing raw file/code work) for gdgraph, gdwiki, gdctx, gdskills, testing, memory,
and flow.

The block is **self-healing**: `ensureMetaprojectReference` migrates old policy
wording to the current phrasing, de-duplicates repeated policies, and
adds/removes the flow policy based on `modules.tasks.enabled`. New root files get
the full policy set written fresh from the `renderAgentEntrypoint` template.

Entrypoint discovery resolves `realpath` and de-duplicates symlinks (so an
`AGENTS.md → CLAUDE.md` symlink isn't imported twice); candidate order is
manifest-declared sources first, then `AGENTS.md`, `agents.md`, `CLAUDE.md`,
`claude.md`. The discovered list is persisted back to
`agentEntrypoints.root` and `index.md` is refreshed.

**Distill (`rules distill`).** For large monolithic entrypoints, distill runs sync
first, then splits each Markdown section and classifies it heuristically into:

- a project **rule** → `.metaproject/rules/entrypoints/<slug>.md`
  (`type: distilled-entrypoint-rule` frontmatter),
- a procedural **skill** → `.metaproject/project-skills/entrypoints/<slug>/SKILL.md`,
- or **root-only** instructions that stay in the trimmed root file.

The root entrypoint is then rewritten to keep only global/personal always-on
instructions plus the managed block, and a distilled index
(`.metaproject/rules/entrypoints/index.md`) is written. `index.md` records
`hasDistilledEntrypoints` so the workspace map reflects whether distillation ran.

## Lifecycle: `init` and `update`

Both lifecycle commands are idempotent and can be re-run any number of times. They
share the managed-block / idempotent-writer mechanism that makes this safe:

- `writeTextIfMissing` — seed once, never overwrite user edits.
- `writeTextIfChanged` / `writeJsonIfChanged` — managed files, always reconciled to
  the freshly rendered template (no-op when identical, so no needless churn).
- `copyFileIfChanged` — vendored runtime scripts.
- **Sentinel-delimited managed regions** inside otherwise user-owned files —
  `# gd-metapro:<id>:begin … :end` (gitignore, git hooks) and
  `<!-- gd-metapro:index -->` (agent entrypoints) — so regeneration replaces only
  the managed span and leaves surrounding human content intact.

### What `init` creates

`initCommand` (`src/commands/init.ts`) bootstraps the workspace:

1. **Parse flags** → per-module enablement. The 8 optional modules
   (`gdgraph, gdctx, gdwiki, gdskills, health, testing, memory, tasks`) default on;
   `--no-<module>` disables one; `--yes` skips prompts; otherwise it asks
   interactively (TTY-safe, defaults when piped). gdskills additionally prompts for
   an install profile. Hooks default off.
2. **Scaffold** the base dirs (`core, data, rules, skills, skills/project-rules,
   modules, reports, templates, hooks, hooks/post-update.d`) plus per-enabled-module
   dirs derived from the config tables (`WIKI_PAGE_TYPES` → wiki folders,
   `MEMORY_TYPES` → memory folders, gdgraph storage/artifacts/summaries/queries,
   etc.).
3. **Inject managed blocks** — the `.gitignore` block, and `syncAgentRules` seeds/
   updates `AGENTS.md`/`CLAUDE.md` with the routing block.
4. **Per-module bootstrap** — gdgraph copies vendored `build.ts`/`query.ts`/
   `types.ts` into `core/gdgraph` and renders a local `cli.ts`; gdskills runs
   `installGdskills(profile)`; testing runs `analyzeTestingProject` once (the only
   place `init` produces analysis).
5. **Install git hooks** (see below) — idempotent managed blocks in
   `.git/hooks/*`, a no-op if `.git` is absent.
6. **Write the manifest** via `buildManifest` (embedding `moduleCommands(id)` per
   module, preserving any existing `projectSkillRegistry`), then write the managed
   docs — `index.md`, per-module manifests/READMEs, every `skills/<m>/SKILL.md`, and
   the dashboard HTML. Seed-once files (root `README.md`, core/rules READMEs) go
   through `writeTextIfMissing`.

Re-running `init` over an existing workspace updates managed files but never
clobbers seeded user files or anything under `data/`.

### What `update` does

`updateCommand` (`src/commands/update.ts`) refreshes an existing workspace (it
errors if `.metaproject/` is missing):

1. **Runtime self-update** (unless `--skip-runtime`): `updateRuntime` finds the
   runtime git repo — `.metaproject/runtime/gd-metapro/.git` (project) or
   `$HOME/.gd-metapro/gd-metapro/.git` (global) — and does
   `git fetch --depth 1 origin main` then `git checkout --force FETCH_HEAD`. The
   CLI updates the copy of itself it was launched from — the same shallow-fetch
   mechanism `install.sh` uses.
2. **`refreshServiceFiles`** — the core of update:
   - **Manifest recovery / migration**: if `metaproject.json` is missing or
     unparseable, infer enablement from directory existence
     (`inferManifestFromExistingMetaproject`); if parseable, `normalizeManifest`
     migrates legacy `modules.wiki` → `modules.gdwiki`.
   - **Tasks backfill**: if the `tasks`/flow module is disabled and `--no-tasks`
     wasn't passed, force-enable it — this upgrades pre-tasks workspaces created
     before the flow module existed.
   - Re-run `syncAgentRules`, re-render all managed docs/manifests/SKILL.md files,
     re-copy gdgraph core scripts, re-run `installGdskills` (with
     `createDataDirs: false`), and re-write configs only via `writeTextIfMissing`
     (never overwriting user config).
   - **Reconcile without touching `data/`**: `createServiceDirs` re-creates only
     managed dirs for enabled modules — never `data/` dirs.
   - **Reinstall hooks conservatively**: each module's git hook is reinstalled only
     if the manifest already records it (`modules.<m>.hooks.gitPostCommit` /
     `prePush`); the dashboard post-commit hook is reinstalled if any module has a
     post-commit hook or the existing hook already contains a `# gd-metapro:` block.
   - **Rebuild the dashboard**: `collectDashboardData` re-reads read-only `data/`
     snapshots (health/graph/testing/wiki/memory/docs) and re-renders the
     self-contained HTML.
   - **Manifest write-back**: a recovered/invalid manifest is rewritten via
     `writeRecoveredManifest` (a leaner `version: 1, generatedBy: "gd-metapro
     update"` shape); a backfilled-tasks-only case uses `enableTasksInManifest` to
     surgically inject the `tasks` entry without disturbing other keys; every run
     calls `updateManifestAgentEntrypoints`.
3. **Report** — heading "Refreshed service files", the note "Data artifacts were
   left untouched", flags for a recovered manifest or backfilled tasks, and a
   per-module status line. With `--hooks`, `runPostUpdateHooks` executes every
   executable in `.metaproject/hooks/post-update.d` (sorted, `access X_OK`, inherited
   stdio); otherwise it hints to pass `--hooks`.

`dashboard build | open` (and bare `dash`, which defaults to `open`) delegate to
`buildDashboard`, which re-collects the `data/` snapshots and writes the
self-contained HTML — again without touching `data/`.

## Git hooks

`init` installs git hooks through `installManagedHook`, which no-ops when `.git`
is absent and otherwise idempotently injects a `# gd-metapro:<blockId>:begin … :end`
block into `.git/hooks/<post-commit|pre-push>` (creating a `#!/usr/bin/env sh`
shebang if the file is new, `chmod 0o755`). The rendered hooks are deliberately
non-mutating staleness reminders that `return 0` on every branch — the one
exception being the opt-in testing pre-push gate, which blocks on failure.

| Hook | Trigger | Behavior | Default under `--yes` |
|---|---|---|---|
| gdgraph post-commit | post-commit | reminder that the import graph may be stale | on |
| gdskills post-commit | post-commit | skill verify / staleness reminder | on |
| health post-commit | post-commit | reminder to re-run health | on |
| dashboard post-commit | post-commit | rebuild the dashboard (installed if any post-commit hook is enabled) | on (derived) |
| testing post-commit | post-commit | reminder to re-run tests | on |
| **testing pre-push** | pre-push | **blocking** test gate — fails the push on test failure | **off** (opt-in even under `--yes`) |

`--no-*-hook` flags force any hook off. On `update`, a hook is reinstalled only if
the manifest already records it, so the workspace never silently re-adds hooks the
user removed.
