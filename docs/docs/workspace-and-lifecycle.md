# Workspace & Lifecycle

`keryx` has exactly one product: the per-project `.metaproject/` workspace — a
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
├── llms.txt                    # deterministic llms.txt index of the workspace (agent-facing)
├── assets.lock.json            # pinned asset registry — checksums for vendored assets (e.g. tree-sitter grammars)
├── keryx-dashboard.html   # self-contained human dashboard (offline, file://-safe)
├── *.config.json               # per-module config, seed-once: gdctx / health / testing / memory / security
├── core/                       # vendored runtime scripts per module (e.g. gdgraph build/query/cli)
├── templates/                  # scaffolded templates dir
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
├── workspaces/<id>/             # SAC primary records (workspace.json, proposals, activity.jsonl)
├── context-operations/          # SAC access-receipt ledger + optional policy-experiment config
├── reviews/<date>-<target>/     # standalone managed review packages
├── modules/                    # per-module manifests + READMEs
├── hooks/                      # hooks readme + post-update.d/ (executables run by `update --hooks`)
├── jobs/                       # orchestration job folders (gdskills)
└── reports/                    # scratch report output (gitignored)
```

The `data/` subtree fans out per feature module — each module owns and writes only
its own subtree at runtime:

```text
data/
├── gdgraph/{storage,artifacts,summaries,queries}/   # import/dependency graph (nodes/edges JSONL)
├── health/{artifacts,history,raw}/                  # quality scores + baseline history
├── testing/{artifacts,history,logs,context.md}/     # normalized test reports
├── gdctx/{raw,artifacts,queries}/                    # compacted git/rg/shell captures
├── gdwiki/{artifacts,link-check}/                    # wiki link checks / collected drafts
├── gdskills/{artifacts,proposals,reports}/          # skill learn/verify outputs
├── security/{artifacts,incidents,policies,raw,redactions}/  # scan reports, incidents, redactions
├── tasks/{artifacts}/                               # flow (task) run outputs
├── memory/{index,embeddings}/                      # optional disposable memory catalog/cache
├── wiki/                                            # wiki freshness queue (freshness-queue.jsonl)
├── trigger/                                         # runs.jsonl ledger, schedules.json (per machine), reports/
├── governance/artifacts/                            # latest.md / latest.json from `governance report`
├── product/                                         # index.json, the disposable intent index
├── retention/                                       # last-auto-sweep stamp
├── forgetting/                                      # journal.jsonl, the deletion trail
├── learning/                                        # observations, candidates, graduation proposals
├── bundles/                                         # applied-state.json (what a bundle import wrote)
├── integrations/install-state/                      # per-runtime install records
└── sac/                                             # target locks for accepted proposals
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
writer with an AC-checksum tamper check. Managed review manifests are likewise
service-owned; standalone packages live under `reviews/`, while attached packages
live under a flow's `reviews/` subtree.

### Versioned vs gitignored

`init` and `update` keep keryx's ignore rules out of the tracked `.gitignore`.
They write the entries below as a managed block delimited by
`# keryx:begin … # keryx:end` to `.git/info/exclude`. That file is per clone
and never committed; from a linked worktree keryx writes the clone's common
`info/exclude`, which every worktree shares. Because it is shared while each
worktree's `.gitignore` belongs to its own branch, the block holds every entry
even when this checkout's `.gitignore` or your global excludes file already
covers it: a redundant line is harmless, and the block comes out the same
whichever worktree runs `update`. The same block lists the per-developer agent
files keryx writes (`CLAUDE.local.md`, `AGENTS.override.md`,
`.claude/settings.local.json` — see
[where the block goes](#where-the-block-goes-local-and-shared-scope)), and a
`CLAUDE.local.md` left over after the `claude` runtime went back to shared is listed whether
or not this checkout has one. `.metaproject/` ignored as a whole is no
exception: a blanket `.metaproject/` line in `.gitignore` is one branch's rule,
so the block still carries every entry, and a worktree whose branch lacks that
line keeps `.metaproject/runtime/` and `.metaproject/data/security/raw/`
ignored. The blanket line itself is read, never edited. keryx refuses to write a line that starts
with `!` (it would re-include a path) or holds a line break. Outside a git
repository the step is skipped with a note and `.gitignore` is neither created
nor changed.

A block an older keryx left in `.gitignore` is moved out by the next `update`,
by the same rules as the entrypoint block (see [Migration](#migration-from-the-tracked-files)):
an uncommitted block is removed and the file restored to `HEAD` — also when
the older keryx had deleted team lines that repeated its own, or a blanket
`.metaproject/` line, since that deletion was keryx's; a block the team
committed stays where it is.

The policy is: **keep agent-facing context versioned, ignore
executable/generated internals.** The current entries (abridged):

```gitignore
# keryx:begin
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
.metaproject/data/tasks/runtime/
.metaproject/data/tasks/logs/
.metaproject/flows/.flow-init.lock/
.metaproject/flows/.flow-lock-*/
# Security: local-only HMAC key, self-protect state, and local hash report must never be committed.
.metaproject/data/security/raw/
.metaproject/data/security/raw/**
.metaproject/data/security/artifacts/latest.md
.metaproject/data/security/artifacts/latest.json
.metaproject/reports/
# keryx:end
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
  `createdBy: "keryx"`.
- `standardVersion` — the Metaproject Standard version the manifest targets
  (currently `"0.1.0"`).
- `profiles[]` — the standard profiles the workspace declares, a subset of
  `minimal` / `agent` / `ci` / `full`, derived from the enabled modules
  (`computeProfiles`).
- `updatedAt` — ISO timestamp of the last lifecycle write.
- `paths{}` — resolved workspace paths (`root`, etc.).
- `agentEntrypoints{ root[], claudeSettings, metaproject: ".metaproject/index.md" }` —
  where the managed block and the `claude` hooks go, one `root` entry per runtime
  with its scope, plus the workspace index (see
  [where the block goes](#where-the-block-goes-local-and-shared-scope)).
- `modules{}` — a map keyed by **module id**, one entry per module. Each entry
  carries:
  - `enabled` — whether the lifecycle commands scaffold/refresh it (9 modules are
    optional and default on; the MCP server module is opt-in via `--mcp`).
  - per-module settings — e.g. gdskills stores `profile`, `skills`, `catalog`,
    `projectSkills`, and a `projectSkillRegistry[]`.
  - `hooks{ gitPostCommit?, prePush?, agent?, postUpdate }` — which hooks this
    module installs (`security` also records `agent` → the `claude` settings file,
    `.claude/settings.local.json` by default).
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
| gdgraph | build, query, affected, repomap |
| gdctx | status, diff, rg, read, run, show |
| gdwiki | status, new, collect, index, check-links, validate |
| gdskills | status, list, inspect, route, catalog, install, create, import, update, verify, learn, export, sync, contracts |
| memory | new, index, search, supersede, transition, ingest, check, reflect |
| tasks | init, list, status, freeze, start, task, ac, implemented, complete, block, unblock, check |
| health | run, status, gate, sources, explain, baseline, trend |
| testing | init, analyze, run, status, context, explain, related, report |
| security | status, scan, check-input, check-output, redact, report, policy, incidents |
| sac (opt-in) | create, list, show, add-resource, archive, remove-resource, rename, overview, read, propose, confirm-review, review, handoff, collaboration, policy-readiness, catch-up, list-proposals, dismiss-candidate |

**Naming skew to remember:** the manifest key `tasks` corresponds to the CLI verb
`flow` (the flow command routes the `tasks` subcommand set), the manifest key
`gdwiki` corresponds to the CLI verb `wiki` (legacy `wiki` manifest keys are
migrated forward on read), and the opt-in module `sac` corresponds to the CLI verb
`workspace`.

## Agent entrypoints and the managed routing block

`AGENTS.md` / `CLAUDE.md` at the repo root are the team's agent instructions. The
`rules` module imports them into the workspace and adds a managed routing block
next to them, so any agent that reads its instructions is routed through keryx
tooling.

**Sync (`rules sync`, also run by `init`/`update`).** For each discovered root
entrypoint, `syncAgentRules` imports the file verbatim into
`.metaproject/rules/<slug>.md` (a high-priority "imported rule" mirror). It then
writes an idempotent managed block, delimited by `<!-- keryx:index -->` and
`<!-- /keryx:index -->`, where `agentEntrypoints.root` says — by default the
per-developer `CLAUDE.local.md` and `AGENTS.override.md`, not the team files (see
[where the block goes](#where-the-block-goes-local-and-shared-scope)). The text
between the markers is regenerated; everything outside them (the human's own
prose) is preserved. The block adds per-skill
routing policies (consult `.metaproject/index.md` and the module skills before
doing raw file/code work) for gdgraph, gdwiki, gdctx, gdskills, testing, memory,
and flow, plus a **Model choice** policy (`src/lib/model-choice.ts`) telling
the `claude` and `codex` runtimes which model tier to run on — the flagship tier for
planning/review, one tier down for subagents/docs/unattended work, the
smallest tier only for trivial work — in tier words, adding a concrete
provider/model id only when this project's `routing.config.json` resolves and
the operator has approved one. Disable it with `.metaproject/tasks.config.json`
`{"modelGuidance":{"enabled":false}}`. See [cli-reference#rules](cli-reference.md#rules).

The block is **self-healing**: `ensureMetaprojectReference` migrates old policy
wording to the current phrasing, de-duplicates repeated policies, and
adds/removes the flow policy based on `modules.tasks.enabled`. A team file keryx
creates (only under shared scope) gets the full policy set from the
`renderAgentEntrypoint` template.

Entrypoint discovery resolves `realpath` and de-duplicates symlinks (so an
`AGENTS.md → CLAUDE.md` symlink isn't imported twice); candidate order is
`agentEntrypoints.importSources` first, then `AGENTS.md`, `agents.md`,
`CLAUDE.md`, `claude.md`. Only team files are imported as rules: `CLAUDE.local.md`
and `AGENTS.override.md` are per-developer and never mirrored into the tracked
`rules/` tree. `index.md` is refreshed.

### Where the block goes: local and shared scope

`agentEntrypoints` in `metaproject.json` holds one `root` entry per runtime and
one `claudeSettings` entry. A fresh `init` writes every target local:

```json
"agentEntrypoints": {
  "root": [
    { "runtime": "claude", "path": "CLAUDE.local.md", "scope": "local" },
    { "runtime": "codex", "path": "AGENTS.override.md", "scope": "local",
      "mode": "override", "source": "AGENTS.md" }
  ],
  "claudeSettings": { "path": ".claude/settings.local.json", "scope": "local" },
  "metaproject": ".metaproject/index.md"
}
```

The older form, `"root": ["AGENTS.md", "CLAUDE.md"]`, is still read, and one
`keryx update` rewrites it to the entry form (see
[Migration](#migration-from-the-tracked-files)).

| Target | `scope: "local"` (default) | `scope: "shared"` |
|---|---|---|
| Claude Code block | `CLAUDE.local.md` | `CLAUDE.md` |
| Codex block | `AGENTS.override.md` (`mode: "override"`) or nothing (`mode: "skip"`, which only removes an override keryx generated) | `AGENTS.md` |
| keryx-managed Claude hooks | `.claude/settings.local.json` | `.claude/settings.json` |
| Opt-in `rules-export` block (`<!-- keryx:rules -->`), Claude Code | `CLAUDE.local.md`; nothing when git tracks it | `CLAUDE.md` |
| Opt-in `rules-export` block, Codex | the keryx-generated `AGENTS.override.md`, after its index block; nothing with `mode: "skip"`, no `AGENTS.md`, or an override keryx did not generate | `AGENTS.md` |

The `rules-export` block is written only by `keryx integrations install
--surface rules` and `keryx bundle import --render-for`, never by `init` or
`update` on their own; see
[Integrations: rules-export surface](integrations.md#rules-export-surface). A
regenerated `AGENTS.override.md` keeps it. A team file whose `rules-export`
block is committed in `HEAD` keeps receiving it: that is the team's shared
choice. Once installed, the block follows the scope: switch a runtime between
`local` and `shared` and run `keryx update`, and the block is moved to the new
file, re-rendered there, and left in exactly one file.

Local targets are gitignored per clone, so `init` and `update` leave `AGENTS.md`,
`CLAUDE.md`, `.gitignore` and `.claude/settings.json` untouched and a `git pull`
of upstream changes to them never meets a local edit. Each local target is
added to `.git/info/exclude`. If a `!` rule in the team's `.gitignore`
re-includes one, keryx says so: that rule outranks `info/exclude`. A local
entry always uses its runtime's standard file — `CLAUDE.local.md`,
`AGENTS.override.md`, `.claude/settings.local.json` — whatever `path` the
manifest states, and a path with a control character or a leading `!` or `#`
is rejected: the manifest is tracked, so a cloned repository controls it. For
the same reason a shared entry is only ever its runtime's team file
(`CLAUDE.md`, `AGENTS.md`, in any case), and a Codex `source` is only
`AGENTS.md`: an entry naming any other file — `.env`, the manifest itself — is
ignored, and that runtime's scope is decided from `HEAD` as for a manifest
that never stated it. Neither the `keryx:index` block nor the `rules-export`
block is ever written anywhere else. A
`CLAUDE.local.md` the team tracks gets no block; the output says to untrack it
or set the claude entry to `"shared"`.

**The `claude` runtime** loads `CLAUDE.local.md` after `CLAUDE.md`. It also counts
a `CLAUDE.local.md` as a `CLAUDE.md` when it decides whether to fall back to
`AGENTS.md`, so in a repository that has `AGENTS.md` and no `CLAUDE.md`, the
`CLAUDE.local.md` keryx creates starts with an `@AGENTS.md` import; without it,
the runtime would stop reading the team's instructions. A `CLAUDE.local.md` you
already had only gets the block.

**The `codex` runtime** has no additive local file: it reads `AGENTS.override.md` *instead of*
`AGENTS.md` in the same directory. So the mode is always stated, never inferred:

- `override` (default) — `AGENTS.override.md` is generated as a provenance line,
  the block, then the full content of `AGENTS.md`. A bare block is never written
  there, because it would hide the team's `AGENTS.md` from the runtime. The override is
  regenerated by `keryx update` and `keryx rules sync`, not when `AGENTS.md`
  changes: until then the runtime reads the old copy, and `keryx doctor` reports it as
  stale. It also reads at most 32 KiB of project instructions by default
  (`project_doc_max_bytes`), and the override holds `AGENTS.md` plus the block, so
  a large `AGENTS.md` can be cut off. An `AGENTS.override.md` keryx did not
  generate is left alone and reported. When `AGENTS.md` is gone, an override
  keryx generated (untracked, with its provenance line) is removed, so the runtime
  does not keep reading the old copy. A `source` reached through a symlink
  leaving the project is never read: the override is not generated, and the
  output and `keryx doctor` say so.
- `skip` — nothing is written for `codex`, and the command output says so. The
  one change a `skip` run makes to a `codex` file is removing an
  `AGENTS.override.md` that keryx generated earlier (its first line is keryx's
  provenance line), so a leftover copy cannot keep hiding `AGENTS.md` from
  the runtime. An `AGENTS.override.md` without that line is yours and is never
  touched.

With no `AGENTS.md`, `codex` is skipped with a message and no tracked `AGENTS.md`
or `CLAUDE.md` is created.

**Shared scope** is the explicit opt-in that keeps the block (or the hooks) in the
committed team file, for a team that wants every clone to carry it. Set that
runtime's entry to `{ "runtime": "claude", "path": "CLAUDE.md", "scope": "shared" }`
(or `claudeSettings` to `{ "path": ".claude/settings.json", "scope": "shared" }`)
and run `keryx update`; keryx creates a missing team file under shared scope only.
A local entry that names a team file is read as "switch this runtime to local"
and gets the local path. Switching back to shared cleans up the old local
files, so the `claude` runtime never reads the block twice and `codex` does not keep
reading an old copy of `AGENTS.md`:

- `CLAUDE.local.md` loses keryx's block, and the `@AGENTS.md` import when
  keryx's comment above it shows keryx added it. A file left with nothing but
  that is removed; one holding your own lines keeps them byte for byte, stays
  in `info/exclude`, and is named in the output.
- `AGENTS.override.md` is removed when its first line is keryx's provenance
  line; one keryx did not generate is left alone and reported. The same
  happens when the Codex mode is set to `skip`. A `rules-export` block in it
  goes with it: install the surface again to write it to `AGENTS.md`.
- A tracked copy of either file is not deleted: that would be a change for the
  team to commit, so the output names it instead. The same holds for a tracked
  `.claude/settings.local.json` when the hooks move back to
  `.claude/settings.json`: keryx's hooks leave it, the file stays.

`keryx update --preview` lists what would be removed, and `keryx doctor` warns
while a shared runtime still has keryx content in its local file.

### Migration from the tracked files

A manifest in the legacy form is settled per target against `HEAD`, never the
working tree, by the first `keryx update` (`keryx rules sync` settles the block
only, not the hooks or `.gitignore`):

- **Block or hooks only as uncommitted edits in the team file** — keryx wrote
  them, so the target becomes local. The block moves to the local target and the
  team file is restored to its `HEAD` bytes, so `git diff --quiet -- <file>`
  passes. The same happens to a managed block in `.gitignore` (its entries move to
  `info/exclude`) and to keryx-managed hook groups in `.claude/settings.json`
  (every `_keryxManaged` group moves, whichever installer wrote it, and keryx's
  install state follows them).
- **The file has other uncommitted edits too** — only the text between the
  markers (or keryx's own hook groups) is removed; your edits stay byte-for-byte,
  and the output names the file.
- **The file is untracked** — only the block goes and the file stays, unless
  nothing but keryx's content is left in an untracked, unstaged `.gitignore` or
  `.claude/settings.json`; that file is removed.
- **The block or hooks are committed in `HEAD`** — the team chose them, so that
  target is recorded as `scope: "shared"`, the file is left alone, and the output
  prints how to switch. For the block: set the entry's scope to `"local"`, run
  `keryx update`, and commit the removal it makes. For the hooks: commit
  `.claude/settings.json` without keryx's hook groups first, then set
  `claudeSettings` to local, run `keryx update`, and re-run any other hook
  installer you use (ctx, orient, learning observer, jev edit guard). For
  `.gitignore`: delete the block and commit that.

The block and the hooks are never left in both places: the `claude` runtime merges the two
settings files, so a hook in both would fire twice. A managed block that stays in
a tracked file whose scope is local is reported by `keryx doctor` with the fix
command.

**The `rules-export` block** (0.3.47) follows the same cases in `keryx update`
and in `keryx init` over an existing project. A `<!-- keryx:rules -->` block a
keryx before 0.3.47 left as an uncommitted edit in `CLAUDE.md` or `AGENTS.md`,
whose runtime's scope is local, moves to `CLAUDE.local.md` or
`AGENTS.override.md`, re-rendered there from the current `.metaproject/rules/`;
the team file goes back to its `HEAD` bytes, or loses only the block when it
has other uncommitted edits (a CRLF file stays CRLF). A block committed in
`HEAD` is left where it is and no local copy is written. Codex with
`mode: "skip"`, or an `AGENTS.override.md` keryx did not generate, has no local
target, so the block stays in `AGENTS.md`. `keryx doctor` warns about an
uncommitted `rules-export` block in a tracked file whose scope is local, with
`keryx update` as the fix.

### Known limits

- **Local files exist per checkout.** `.git/info/exclude` is shared by every
  worktree of a clone, but `CLAUDE.local.md`, `AGENTS.override.md` and
  `.claude/settings.local.json` are not: a linked worktree has no block and no
  keryx hooks until you run `keryx update` in it.
- **Cloud and remote sessions** start from a fresh clone, so they have no
  `CLAUDE.local.md`, and they do not read `.claude/settings.local.json`. For a
  project worked on that way, use shared scope.
- **Scope is a team setting.** `metaproject.json` is tracked, so the scopes and
  the `codex` mode apply to everyone who pulls it.
- **Blank-line-only edits** to a tracked entrypoint count as "equal to `HEAD`"
  during migration, so they are reverted along with the block.
- **Other harnesses' `rules-export` files** (`GEMINI.md`,
  `.github/copilot-instructions.md`, and the keryx-owned files under
  `.cursor/rules/`, `.kiro/steering/` and `.windsurf/rules/`) are tracked: none
  has a per-developer counterpart its tool reads. Installing the surface there
  is an explicit edit to the team's files.

**Distill (`rules distill`).** For large monolithic entrypoints, distill runs sync
first, then splits each Markdown section and classifies it heuristically into:

- a project **rule** → `.metaproject/rules/entrypoints/<slug>.md`
  (`type: distilled-entrypoint-rule` frontmatter),
- a procedural **skill** → `.metaproject/project-skills/entrypoints/<slug>/SKILL.md`,
- or **root-only** instructions that stay in the trimmed root file.

The root entrypoint is then rewritten to keep only global/personal always-on
instructions — plus the managed block when that file is a shared target; under
local scope the block stays in `CLAUDE.local.md` and `AGENTS.override.md` is
regenerated from the rewritten `AGENTS.md` — and a distilled index
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
  `# keryx:<id>:begin … :end` (`.git/info/exclude`, git hooks) and
  `<!-- keryx:index -->` (the agent entrypoint block) — so regeneration replaces
  only the managed span and leaves surrounding human content intact.

### What `init` creates

`initCommand` (`src/commands/init.ts`) bootstraps the workspace:

1. **Parse flags** → per-module enablement. The 9 optional modules
   (`gdgraph, gdctx, gdwiki, gdskills, health, testing, memory, tasks, security`)
   default on (security via `--no-security`); the MCP server module is opt-in via
   `--mcp`. `--no-<module>` disables one; `--yes` skips prompts; otherwise it asks
   interactively (TTY-safe, defaults when piped). gdskills additionally prompts for
   an install profile. Under `--yes` all post-commit hooks default on; only the
   pre-push testing gate is off by default (opt-in even under `--yes`).
2. **Scaffold** the base dirs (`core, data, rules, skills, skills/project-rules,
   modules, reports, templates, hooks, hooks/post-update.d`) plus per-enabled-module
   dirs derived from the config tables (`WIKI_PAGE_TYPES` → wiki folders,
   `MEMORY_TYPES` → memory folders, gdgraph storage/artifacts/summaries/queries,
   etc.).
3. **Write managed blocks** — the ignore block to `.git/info/exclude`, and
   `syncAgentRules` writes the routing block to `CLAUDE.local.md` /
   `AGENTS.override.md` (or the team files under shared scope), moving any
   uncommitted keryx block or hooks out of the tracked files.
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
   runtime git repo — `.metaproject/runtime/keryx/.git` (project) or
   `$HOME/.keryx/keryx/.git` (global) — and does
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
   - **Entrypoints**: settle `agentEntrypoints` (a legacy array is rewritten to
     the entry form), move the ignore block and any keryx block or hooks out of
     tracked files, and write them to the targets
     ([migration](#migration-from-the-tracked-files)).
   - Re-run `syncAgentRules`, re-render all managed docs/manifests/SKILL.md files,
     re-copy gdgraph core scripts, re-run `installGdskills` (with
     `createDataDirs: false`), and re-write configs only via `writeTextIfMissing`
     (never overwriting user config).
   - **Reconcile without touching `data/`**: `createServiceDirs` re-creates only
     managed dirs for enabled modules — never `data/` dirs.
   - **Reinstall hooks conservatively**: each module's git hook is reinstalled only
     if the manifest already records it (`modules.<m>.hooks.gitPostCommit` /
     `prePush`); the dashboard post-commit hook is reinstalled if any module has a
     post-commit hook or the existing hook already contains a `# keryx:` block.
   - **Rebuild the dashboard**: `collectDashboardData` re-reads read-only `data/`
     snapshots (health/graph/testing/wiki/memory/docs) and re-renders the
     self-contained HTML.
   - **Manifest write-back**: a recovered/invalid manifest is rewritten via
     `writeRecoveredManifest` (a leaner `version: 1, generatedBy: "keryx
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
is absent and otherwise idempotently injects a `# keryx:<blockId>:begin … :end`
block into `.git/hooks/<post-commit|pre-push>` (creating a `#!/usr/bin/env sh`
shebang if the file is new, `chmod 0o755`). Every post-commit hook `return 0`s on
every branch and so never fails a commit; most are staleness reminders, while the
gdgraph and dashboard hooks regenerate their artifacts. The blocking exceptions are
the opt-in testing pre-push gate (blocks on test failure) and the opt-in security
pre-push gate (blocks in `enforced`/`ci`/`gateway` mode).

| Hook | Trigger | Behavior | Default under `--yes` |
|---|---|---|---|
| gdgraph post-commit | post-commit | rebuilds the graph (`keryx gdgraph build`) after a graph-relevant commit; warns instead of failing, `KERYX_GDGRAPH_HOOK_REBUILD=0` reverts it to a reminder | on |
| gdwiki post-commit | post-commit | appends one entry to `data/wiki/freshness-queue.jsonl` for `keryx wiki freshness` to drain (installed with the gdgraph post-commit hook) | on (derived) |
| gdskills post-commit | post-commit | skill verify / staleness reminder | on |
| health post-commit | post-commit | reminder to re-run health | on |
| dashboard post-commit | post-commit | rebuild the dashboard (installed if any post-commit hook is enabled) | on (derived) |
| testing post-commit | post-commit | reminder to re-run tests | on |
| **testing pre-push** | pre-push | **blocking** test gate — fails the push on test failure | **off** (opt-in even under `--yes`) |
| **security pre-push** | pre-push | scans changed files with `security scan`; **advisory (default) warns, enforced/ci/gateway block** the push | on (offered when `security` enabled; opt out `--no-security-hook`) |

The security pre-push block coexists with the testing pre-push block and any
user-authored content in `.git/hooks/pre-push`. `--no-*-hook` flags force any hook
off. On `update`, a hook is reinstalled only if the manifest already records it, so
the workspace never silently re-adds hooks the user removed.

### Agent hook (`.claude/settings.local.json`)

The `security` module also offers a non-git, project-local **`claude` agent
hook** at `init` (opt out with `--no-security-agent-hook`). Rather than a
`.git/hooks/*` block, `installSecurityAgentHooks` **merges** two hooks —
`UserPromptSubmit` → `security check-input --source untrusted-external` and
`PreToolUse(Write|Edit)` → `security check-output` — into the `claude` settings
file `agentEntrypoints.claudeSettings` names: `.claude/settings.local.json` by
default, the tracked `.claude/settings.json` under shared scope. Every other
keryx-managed `claude` hook (ctx guard, orient, learning observer, jev edit guard)
resolves to the same file, so none is ever split across the two. The
merge is **merge-safe**: a `_keryxManaged: "security-agent-hooks"` sentinel
keeps re-install idempotent and preserves every pre-existing key and user hook.
Advisory by default. It is recorded in the manifest at `security.hooks.agent` and,
like the git hooks, refreshed by `update` only when already recorded.

### Orientation and routing hooks

Two additional opt-in integrations are installed explicitly rather than by
`init` defaults:

- `keryx orient install-hook --runtime <id>` injects a bounded project-root
  `.metaproject/index.md` excerpt plus the graph map and wiki index
  at turn start for the `claude`, `codex` or `cursor` runtimes.
- `keryx ctx install-hook --runtime <id>` installs the gdctx routing guard, which
  blocks broad raw shell/search reads and recommends the bounded `ctx` command.

Both installers are merge-safe, idempotent, and reversible through their matching
`uninstall-hook` commands. They modify only managed config entries or sentinel
blocks and preserve surrounding user settings.
