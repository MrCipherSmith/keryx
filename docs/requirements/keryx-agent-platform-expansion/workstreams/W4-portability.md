# W4 — Portability
Version: 0.1.3

## Summary

Keryx today writes its catalog content (skills, rules, learned patterns, memory) into exactly one
place: `<project>/.metaproject/`. There is no unit of transfer for that content between projects, no
user-level store for personal skills/agents/learned patterns, and no format for handing a memory
entry from one harness to another. W4 defines that unit — a portable bundle — plus the scope model
(project/team/user) it moves between, the lifecycle that keeps import safe (plan → audit → apply,
fail closed, never overwrite user edits), the fields memory entries need to travel between harnesses
honestly, and the adapter point where one canonical instruction source becomes `AGENTS.md`,
`CLAUDE.md`, `GEMINI.md`, and other harnesses' native rule files. Everything in this workstream is
`planned`; nothing described here exists in the repository today except where a file path is cited as
proof.

## Implementation status (flow 313)

Flow 313 implemented this workstream. Each row maps a W4 acceptance criterion
to the module and test that proves it; see `docs/docs/guides/portability.md`
for the task-oriented user-facing guide and `docs/docs/cli-reference.md`
(`## bundle` section) for the full CLI flag reference.

| AC | Implementing module | Test |
|---|---|---|
| W4-AC1 (export) | `src/bundle/export.ts` (`exportBundle`) | `src/bundle/export.test.ts` |
| W4-AC2 (verify) | `src/bundle/verify.ts` (`verifyBundle`, `verifyBundlePath`) | `src/bundle/verify.test.ts` |
| W4-AC3 (import fails closed on checksum mismatch) | `src/bundle/plan.ts` (`planBundleImport`) | `src/bundle/plan.test.ts` |
| W4-AC4 (never overwrite a human-modified file; uninstall keeps modified files) | `src/bundle/apply.ts` (`applyBundlePlan`), `src/bundle/applied-state.ts`, `src/bundle/uninstall.ts` | `src/bundle/apply.test.ts`, `src/bundle/applied-state.test.ts`, `src/bundle/uninstall.test.ts` |
| W4-AC5 (inspect is read-only) | `src/bundle/inspect.ts` (`inspectBundle`) | `src/bundle/inspect.test.ts` |
| W4-AC6 (`source_harness` bound at MCP launch, never per-call) | `src/commands/serve-mcp.ts` (`resolveServeHarness`), `src/mcp/tools.ts` (`memory.search` / `memory.handoff` harness filtering) | `src/commands/serve-mcp.test.ts`, `src/mcp/memory-harness-identity.test.ts` |
| W4-AC7 (incomplete scan fails closed) | `src/memory/store.ts` (`collectEntriesStrict`), `src/memory/handoff.ts` (`selectHandoffEntries`) | `src/memory/handoff.test.ts` |
| W4-AC8 (private-dir `.gitignore` refusal) | `src/lib/private-dir.ts` (`checkPrivateDirGitignore`, `ensurePrivateDirGitignore`) | covered under `src/bundle/plan.test.ts`, `src/bundle/apply.test.ts` |
| W4-AC9 (external catalog: scout + audit gates, referenced not copied) | `src/bundle/external.ts` (`vetExternalCatalog`, `applyExternalImports`) | `src/bundle/external.test.ts`; reported-by-scout coverage in `src/gdskills/governance/scout.test.ts` (`scoutImports`, backing `keryx skills scout --include-imports`) |
| W4-AC10 (managed-block rendering, byte-identical elsewhere) | `src/integrations/surfaces-rules.ts`, `src/integrations/rules-export.ts` (`renderRulesForHarnesses`, `installedRulesExportHarnesses`) | covered under `src/integrations/markdown-block.test.ts`, `src/integrations/w5b-adapters.test.ts` |
| W4-AC11 (learned-pattern scope immutable, always `candidate`) | `src/bundle/plan.ts` (learned-pattern candidate rewrite) | `src/bundle/plan.test.ts` |
| W4-AC12 (W8 audit gates plan → apply) | `src/bundle/audit.ts` (`auditBundlePlan`), `src/security/audit-harness/index.ts` (`imported-bundles` surface) | `src/bundle/audit.test.ts`, `src/security/audit-harness/imported-bundles.test.ts` |
| W4-AC13 (export → import → inspect round trip) | `src/bundle/service.ts` (public facade) | `src/bundle/roundtrip.e2e.test.ts` |
| W4-AC14 (`~/.keryx/` resolver, imported-agent origin) | `src/lib/keryx-home.ts` (`resolveKeryxHomeDir`, `userStorePaths`), `src/bundle/export.ts` (`rewriteAgentOrigin`) | `src/bundle/export.test.ts` |

**"Unverified" notes below resolved by this flow:** the "first-party harness
documentation check" this document's Design section flagged as needed before
implementing `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` rendering was done for two of
the three — Claude Code's own documented memory-file convention and Codex's
`AGENTS.md`/agents.md convention are both marked `confidence: "verified"` in
`src/integrations/surfaces-rules.ts`, backed by `sourceDocs` (a live URL each)
and this repository's own `CLAUDE.md`/`AGENTS.md` bootstrap blocks as a
working proof. `GEMINI.md`, Cursor, Kiro, Windsurf, and the GitHub Copilot
coding agent surface remain `confidence: "experimental"` — each carries a
`riskNotes` entry naming exactly what was not independently confirmed (see
`docs/docs/guides/portability.md`, "Rules export to harness instruction
files"). The separate "first-party Agent Skills documentation check" flagged
for the external-catalog `SKILL.md` shape (Design → "Importing external
Agent-Skills-standard catalogs") is outside `surfaces-rules.ts`'s scope and
was not addressed by this flow; `src/bundle/external.ts` implements
`vetExternalCatalog` against the frontmatter shape this document already
specifies (`name`/`description`), unchanged.

## Current state

Verified by reading the cited files directly (all paths confirmed to exist in this worktree).

- **No `~/.keryx` or any other user-level store exists.** A repo-wide search for `.keryx` (`keryx ctx
  rg "\.keryx" src`) returns 107 matches across 42 files, but every one is a **project-local** path —
  `<project-root>/.keryx/mcp-servers.json` (`src/mcp-servers/config.ts` and its tests), `<project-
  root>/.keryx/external-slates/<externalSessionId>.json` (`src/session/external-slate.ts:9,68,75,112`,
  `src/sac/catch-up.ts:340-407`), and `<project-root>/.keryx/sandbox-policy.json`
  (`src/lib/project-sandbox-policy.ts:3,18`). `.keryx/` is an established project-scoped directory
  convention for machine-local, non-catalog state (MCP server bindings, session handoff artifacts,
  sandbox policy) that sits **beside** `.metaproject/` rather than inside it — but nothing in the
  codebase creates or reads a directory under the user's home. A user scope for learned patterns,
  personal skills, or personal agents does not exist.
- **No bundle/export/import command exists.** `keryx ctx rg "bundle" src/commands` returns zero
  matches. There is no `keryx bundle` subcommand of any kind.
- **Memory has no cross-harness fields and one scope.** `src/memory/types.ts` defines `MemoryEntry`
  (lines 80-112) with `type`, `status`, `confidence`, `scopes: MemoryScopes` (`module`/`entity`/
  `files`/`skills`, lines 73-78), and AFC-25 provenance fields `author`/`confirmedBy`/`caveat` (lines
  109-111) — but no `source_harness`, `target_harnesses`, or any harness-identity field anywhere in
  the type. `src/memory/store.ts:16-18` fixes the store root as `path.join(cwd, ".metaproject",
  "memory")` — one project-scoped tree, no team or user root, no `.gitignore` handling in the module
  (`keryx ctx rg "gitignore" src/memory` returns zero matches). `MemoryScopes` conflates a different
  kind of "scope" (which module/entity a memory is about) with the project/team/user scope this
  workstream needs; W4 must not overload the existing field.
- **Checksums are a well-established pattern, just not for this.** `sha256` is used pervasively for
  content-addressing and integrity (`src/assets/resolver.ts` verifies an asset's sha256 on every
  load; `src/harness/run/run.ts:218-219` and `src/sac/fwk-service.ts:84` compute canonical-JSON sha256
  fingerprints for policy decisions and checkpoint ledgers). A portable-bundle manifest reuses this
  established pattern rather than inventing a new integrity primitive.
- **`skills_catalog`/`skill_load` are implemented, and they set the precedent for "referenced, not
  copied."** Per `docs/requirements/keryx-skills-runtime-tools/README.md` (Status: implemented,
  R1/R2/R4/R5 shipped 0.2.50, PR #359), these two `MetaprojectOperation`s (confirmed registered:
  `skills_catalog` at `src/harness/tool/metaproject-operations.ts:1897`, `skill_load` at
  `src/harness/tool/metaproject-operations.ts:1918`) let any MCP-connected agent discover and load
  `.metaproject/skills/` content without copying it into the agent's own context ahead of time — the
  same "reference, don't duplicate" shape W4 needs for imported external skill catalogs. The README's
  own non-goal (line 99: "a generic cross-assistant skill protocol standard... this package targets
  keryx's own supported assistants only") is a hard boundary this workstream respects: W4 is about
  *importing bundles into* Keryx's supported set, not defining a new universal wire protocol.
- **`keryx-claude-plugin`'s conclusion constrains packaging.** `docs/requirements/keryx-claude-plugin/
  README.md` assessed and **rejected** (for now) bundling skills+hooks+MCP into one Claude-Code-native
  plugin artifact: the engineering case was found weak after correcting a false claim about
  `${CLAUDE_PROJECT_DIR}` argv substitution (measured: unexpanded in argv, present only in the spawned
  process's environment — table in that README), and the recommendation was "do not build the plugin
  for engineering reasons... only build it if [marketplace discoverability] is a yes" (final
  paragraph). **Constraint for W4: the portable bundle format must not assume or require Claude
  Code's plugin packaging shape** (`.claude-plugin/plugin.json`, `commands/`, `hooks/hooks.json` at a
  plugin root). It is a harness-neutral tarball/directory format `keryx bundle` reads and writes
  itself; a Claude Code plugin, if ever built per that README's Option C, would be a *consumer* of
  bundle content, not the bundle format itself.
- **`syncAgentRules` is the only existing canonical→per-harness projection, and it targets exactly two
  files.** `src/rules/agent-entrypoints.ts` (`syncAgentRules`, lines 24-64) imports `AGENTS.md`/
  `CLAUDE.md` into `.metaproject/rules/` and maintains an idempotent managed block (`<!-- keryx:index
  -->` / `<!-- /keryx:index -->`, `ensureMetaprojectReference`, lines 66-84) inside those two files.
  `ensureDefaultAgentEntrypoints` (lines 116-125) creates `AGENTS.md`/`CLAUDE.md` on request but
  writes no `GEMINI.md`, `.cursor/rules/*.mdc`, Kiro steering, or Windsurf rules file anywhere. This
  is the *import* direction (host file → `.metaproject/rules/`); W4 needs the *export* direction
  (`.metaproject/rules/` → every harness's native instruction file), which does not exist today and
  is explicitly deferred to W5 adapters (see Integration).
- **No hooks-config or learned-pattern export path exists to bundle.** W3 (`learned-pattern` records)
  and W6 (`hook-config`) are themselves `planned` sibling workstreams; W4's bundle contents section
  for those categories therefore describes a target schema shape, not present behavior, and is marked
  accordingly.

## Goals & non-goals

**Goals**
- Define one portable bundle format covering skills, rules, agents (W2), learned patterns (W3),
  memory entries, and hook configs (W6), with a manifest that names, hashes, and dates every item.
- Define project/team/user scopes and where each lives on disk, including a first `~/.keryx/` user
  root (there is none today).
- Define export/import/inspect/verify lifecycle: plan is dry-run and diffable, apply never overwrites
  a file a human has edited since the last Keryx-managed write, checksum mismatch fails closed, and
  W8's audit sits between plan and apply for imports.
- Extend `MemoryEntry` with the fields needed to carry a memory item across harnesses honestly
  (source recorded at write time, not spoofable at read time) and to fail closed rather than silently
  under-report on a partial or interrupted scan.
- Define how an externally-authored Agent-Skills-standard-conformant catalog is vetted and referenced
  (not copied) into a project, reusing W1's scout dedupe gate.
- Define the seam where one canonical instruction source becomes every harness's native instruction
  file, and hand the per-harness rendering itself to W5 (this document defines the contract, not the
  renderers).

**Non-goals**
- W4 does not implement stack packs, skill authoring, or governance evals (W1); it only describes how
  a stack pack or skill, once it exists, is packaged for transfer.
- W4 does not implement the agent-definition compiler (W2); it only describes how a compiled agent
  definition is packaged for transfer.
- W4 does not implement the observe/extract/learn pipeline (W3); it only describes the wire shape a
  learned-pattern record takes inside a bundle.
- W4 does not implement per-harness hook installers (W5/W6); it only describes what a `hook-config`
  bundle entry contains.
- W4 does not perform the security audit itself (W8); import's plan step *calls* the W8 audit as a
  gate, but the audit's checks are W8's to define.
- W4 does not design a new universal cross-vendor wire protocol. Where a public standard exists
  (Agent Skills open standard, AGENTS.md), W4 conforms to it for interoperability; where none exists
  (learned patterns, hook configs), the bundle format is Keryx's own and is honest about being
  Keryx-specific.
- No automatic promotion of anything project-scoped into team or user scope. Every scope move in this
  document is a human-invoked `keryx bundle export`/`import` or `keryx learn promote`, consistent with
  D-4 (no automatic promotion) from `brainstorm.md`.

## Design

### Scopes: project / team / user, and on-disk layout

Three scopes, matching the shape already implied by existing project-local (`.metaproject/`) and
machine-local (`.keryx/`) directories, extended with a new user root:

| Scope | Root | Version-controlled | Contents |
|---|---|---|---|
| `project` | `<project>/.metaproject/` | Yes (existing convention) | Skills, rules, agents, memory (`memory/`, per `src/memory/store.ts:16-18`), install-state — everything already project-scoped today. |
| `team` | `<project>/.metaproject/` (same tree, a designated subset) | Yes | The subset of project-scope content a team has explicitly chosen to standardize and share via bundle export/import across repos (e.g. a shared reviewer-profile rule, a shared stack pack override). Not a separate directory — a *bundle manifest's* `scope: "team"` marks which project-scope paths are meant to move between a team's repositories, so "team scope" is a labeling and transfer discipline over the existing project tree, not a new location. This avoids inventing a fourth on-disk root for a distinction that is really about intent, not storage.
| `user` | `~/.keryx/` (new) | No (personal, machine-local, gitignored where it needs the OS default) | Personal skills, personal agents, accepted learned patterns promoted to user scope (W3's project→user promotion step), and the personal-scope memory root `~/.keryx/memory/`, mirroring the existing project-scope `memory/<folder>/*.md` layout under `src/memory/store.ts`'s type-to-folder table (`MEMORY_TYPES`, `src/memory/types.ts:23-35`) so `collectEntries`-shaped code can be reused for a user-scope root without a parallel implementation. |

`~/.keryx/` is a new directory this workstream introduces; nothing in the codebase reads or writes it
today (see Current state). Placing it at `~/.keryx/` rather than under a dotfile inside `.metaproject`
follows the same naming convention the project-local `.keryx/` directory already uses for
machine-local, non-catalog state (`.keryx/mcp-servers.json`, `.keryx/sandbox-policy.json`) — user
scope is machine-local state too, just at the home-directory level instead of the project level.

Layout:

```
~/.keryx/
  skills/<name>/SKILL.md              # personal skills, Agent-Skills-standard shape
  agents/<name>.md                    # personal agent definitions (W2 canonical format)
  memory/<folder>/*.md                # user-scope memory, same MEMORY_TYPES folders as project scope
  learning/patterns/<id>.json         # W3 learned-pattern records promoted from project scope (JSON, learned-pattern.schema.json)
  learning/index.json                 # cross-project evidence index (keyed by pattern id -> per-identity entries), written only by `keryx learn accept`
  bundles/                            # cache of imported/exported bundle artifacts and their manifests
  bundles/applied-state.json          # per-path "last sha256 Keryx wrote here" ledger for bundle apply
  hooks.json                          # user-scope hook config (W6 schema), merged under project config
```

### Portable bundle format

A bundle is a versioned directory or tarball with one manifest at its root, validated against
`schemas/portable-bundle.schema.json` (owned by this workstream). Every content item the manifest
lists is content-addressed by sha256, following the pattern already used for asset integrity
(`src/assets/resolver.ts`) and canonical-JSON fingerprints (`src/harness/run/run.ts:218-219`,
`src/sac/fwk-service.ts:84`) rather than inventing a new hashing scheme.

Manifest top-level fields:

- `formatVersion` — semver of the bundle format itself (not Keryx's own version), so an older Keryx
  build can refuse an unrecognized future format instead of misreading it.
- `bundleId` — stable identifier for this bundle across re-exports (a rename or content edit produces
  a new `contents[].sha256` but the same `bundleId`, so `keryx bundle inspect` can show "this is bundle
  X, contents changed" rather than treating every export as unrelated).
- `createdAt`, `sourceKeryxVersion` — provenance of the export itself.
- `provenance` — `{ producedBy: "keryx bundle export", sourceProject: <redacted-or-hash>, sourceScope:
  "project"|"team"|"user" }`. `sourceProject` is never a raw absolute path (path leaks nothing about
  the current project into a bundle shared elsewhere); it is either omitted or a hash, mirroring the
  project-id hashing approach W3 uses for its cross-project evidence index (`project.identity`, see W3
  → "Scope & project identity") — a hash of a normalized project identifier such as the git remote URL.
- `compat` — `{ minKeryxVersion, targetHarnesses: string[] }`. `targetHarnesses` is advisory (a hint
  for `keryx bundle inspect` to warn "this bundle's hook-config entries name a harness not in your
  W5 capability matrix"), never a hard gate — a bundle of skills/rules/memory is harness-agnostic even
  if one of its optional hook-config entries names a specific harness.
- `contents` — an array of content entries, each: `{ path, kind, sha256, sizeBytes, scope,
  description? }`. `kind` is one of `skill | rule | agent | learned-pattern | memory-entry |
  hook-config`. `path` is relative to the bundle root and mirrors the target on-disk layout for that
  `kind` and `scope` (e.g. a `kind: "skill"`, `scope: "user"` entry's `path` is
  `skills/<name>/SKILL.md`, matching the `~/.keryx/` layout above), so `apply` is a direct, auditable
  copy rather than a kind-specific rewrite.

The schema deliberately does **not** include an executable `install` script or arbitrary shell
commands inside the manifest — bundle apply is data movement (copy files whose checksums match into
known-shaped destinations), not code execution, so a malicious or malformed bundle cannot use the
import mechanism itself as an execution vector. Anything requiring code execution (e.g. a skill's own
`scripts/`) is content inside a `kind: "skill"` entry, audited by W8 like any other skill script, not
part of the manifest-processing path.

### Export / import / inspect lifecycle

`keryx bundle export --scope <project|team|user> [--include <glob>...] <output-path>`
1. Collect content matching the requested scope and optional filters.
2. Compute sha256 for every item, write the manifest, write the bundle (directory or `.tar.gz`).
3. No network access, no external calls — export is fully offline, consistent with the deterministic-
   core convention.

`keryx bundle import <bundle-path> [--target-scope <scope>] [--dry-run|--json]`

Three fixed stages, in order, never skippable:

1. **Plan.** Read and validate the manifest against the schema; recompute every `contents[].sha256`
   from the bundle's actual bytes and compare against the manifest's declared value. **Any mismatch
   fails the entire import closed** — no partial apply, no "skip the bad entry and continue" mode,
   because a checksum mismatch means the bundle was corrupted or tampered with in transit and nothing
   in it can be trusted by degree. Plan then diffs each entry's target path against what is already on
   disk, producing three buckets: `new` (no existing file), `identical` (existing file's sha256
   matches what the bundle would write — a no-op), and `conflict` (an existing file differs from both
   the last-known-imported version and the incoming version). Plan output is the same
   dry-run/JSON-diffable shape W1's install-manifest plan already establishes as the project
   convention (`keryx skills install --profile <p> --dry-run --json`, per the W1 target-stack table,
   `workstreams/W1-stack-catalog.md`), reused here rather than inventing a second plan format.
   For a `kind: "learned-pattern"` entry specifically, plan also validates the entry against the
   scope rule below before it can land in the `new` or `conflict` bucket at all.
2. **Audit.** The plan's `new` and `conflict` buckets are handed to W8's `keryx security audit-harness`
   surface (this workstream defines the handoff; W8 defines the checks) before any file is written —
   an imported skill's scripts, an imported hook-config's commands, and an imported agent definition's
   tool allowlist are exactly the surfaces W8 already audits for locally-authored content, applied
   here to content arriving from outside the project.
3. **Apply.** Only `new` entries and explicitly `--force`-confirmed `conflict` entries are written.
   **A file the human has modified since Keryx last wrote it is never silently overwritten** — apply
   tracks, per destination path, the sha256 Keryx itself last wrote there (a small local
   `bundles/applied-state.json` ledger under the target scope's root, e.g. `~/.keryx/bundles/` for a
   user-scope apply); if the on-disk file's current sha256 differs from that recorded value, the file
   is treated as user-modified and apply refuses it by default, surfacing it as a `conflict` requiring
   an explicit `--force` per path (not a blanket `--force` for the whole import) plus a written note of
   which path was overwritten. This is the same "never clobber a hand-edited file" discipline the
   `_keryxManaged` sentinel already enforces for the four existing writer-into-somebody-else's-file
   installers (`docs/requirements/keryx-claude-plugin/README.md`, "What keryx has today," items 1-4),
   generalized to bundle apply instead of being reinvented per content kind.

`keryx bundle inspect <bundle-path> [--json]` — read-only: prints the manifest, per-entry
new/identical/conflict status against the current project (the same diff plan stage 1 computes, without
writing anything), and any `compat.targetHarnesses` warnings. Safe to run on an unvetted bundle from
an untrusted source, since it never executes or writes anything.

`keryx bundle verify <bundle-path>` — recomputes every `contents[].sha256` and reports pass/fail per
entry without importing; the standalone form of plan's checksum step, useful in CI for a bundle a team
publishes (verify it wasn't corrupted in transit before anyone imports it).

**Conflict policy summary:** identical → no-op; new → written on apply; conflicting with an unmodified
Keryx-written file → written on apply (this is an ordinary update); conflicting with a human-modified
file → refused unless explicitly force-confirmed per path. There is no automatic three-way merge —
Keryx does not attempt to reconcile a human's edits with an incoming bundle's version of the same
file; it surfaces the conflict and lets the human choose, consistent with "proposals never write" and
"human consent before persistence."

**Learned-pattern scope rule.** `keryx learn promote` is the only path that creates a user-scope pattern
from project-scope evidence (see W3 → "Cross-project evidence" and "Promotion rule"). `keryx bundle
import` may transport an already-`scope: user` record into `~/.keryx/learning/patterns/`; it never
changes a record's scope and always writes it at `status: candidate`. `keryx learn accept` is the only
command that makes any record `accepted`: it writes the status transition in the record's own store
(`.metaproject/data/learning/` for `scope: project`, `~/.keryx/learning/patterns/` for `scope: user`)
and, for a `scope: project` record only, appends one entry to `~/.keryx/learning/index.json`; it refuses
any target outside `.metaproject/data/learning/` or `~/.keryx/learning/`. Concretely, for bundle import:
- A `kind: "learned-pattern"` entry with `scope: project` may only be imported with
  `--target-scope project`; a `--target-scope user` on the same entry is refused with a named reason
  ("cannot import a project-scope learned-pattern at user scope; scope is immutable across import").
- A `kind: "learned-pattern"` entry with `scope: user` may be imported at `--target-scope user`, but
  always lands at `status: candidate` regardless of the status it carried in the source bundle — it
  still requires a human `keryx learn accept` in the destination project/machine before it counts as
  anything more than a candidate. This keeps bundle import a transport mechanism, never a second path
  to an accepted or promoted pattern.
- Any other `--target-scope`/entry-`scope` mismatch for `kind: "learned-pattern"` is refused the same
  way, with the mismatch named in the refusal message.

### Cross-harness memory handoff

`MemoryEntry` (`src/memory/types.ts:80-112`) gains two new optional fields, additive and back-
compatible with the existing "absent ⇒ null" convention the type already uses for its C2/C3/AFC-25
fields (comment, lines 95-98):

- `source_harness?: string | null` — which harness's session originally wrote this entry. Set once, at
  write time, by the MCP server process itself — **bound at server launch, not read per call**, so a
  connected client cannot claim a different harness identity per tool call than the process it is
  actually talking through. This is a fixed-at-launch harness-identity pattern — bound once by the
  server process's own environment at startup, never by a per-call client argument — and is a
  materially stronger guarantee than trusting a client-supplied field in the tool-call payload.
- `target_harnesses?: string[] | null` — which harnesses this entry is meant to be readable from;
  `null`/absent means "all" (back-compatible default matching every entry written before this field
  existed). A read request from a harness not in `target_harnesses` (and not `"all"`) is filtered out
  before scoring, not merely deprioritized.

Two fail-closed rules, both new behavior (no equivalent exists in `src/memory/` today per Current
state):

1. **Incomplete scan fails closed.** `collectEntries` (`src/memory/store.ts:20-…`) walks
   `memoryRoot(cwd)`'s folders; if any folder read is interrupted, truncated, or hits a malformed entry
   partway through, the read-tool path for cross-harness handoff reports `status: "incomplete"` rather
   than returning whatever partial set it collected as if it were complete — a caller must never
   receive a silent under-count that looks like "there simply were fewer relevant entries." This
   reuses the "fail closed with named reasons, no silent degradation" convention already stated as a
   repo-wide rule rather than introducing a new philosophy.
2. **Private-dir `.gitignore` conflict fails closed.** A project-scope memory root that is meant to
   stay private to one operator (e.g. `~/.keryx/memory/` for user scope, or a project-local
   `.metaproject/memory/private/` subtree if W3 introduces one) is expected to own a `.gitignore`
   entry it manages. If that `.gitignore` already exists with different, conflicting content (someone
   else's rule already covers or excludes that path in an incompatible way), Keryx does not silently
   append or overwrite — it refuses to write into that directory and surfaces the conflict, the same
   fail-closed posture Keryx already applies whenever an existing file's contents cannot be safely
   reconciled, applied here to its own private-directory convention.

### Importing external Agent-Skills-standard catalogs

An external catalog is a set of `SKILL.md`-shaped directories conforming to the public Agent Skills
open standard (frontmatter `name`/`description`, optional `references/`/`scripts/`/`assets/` —
unverified — requires a first-party Agent Skills documentation check before implementation). Import
path:

1. `keryx bundle import <external-catalog-path> --external` treats the source as read-only vetting
   input, not bundle content to copy in wholesale.
2. Each candidate skill runs through W1's pre-creation dedupe gate (`keryx skills scout`) to check
   whether an equivalent skill already exists locally before anything is added, avoiding a catalog-
   bloat failure mode: vague, overlapping skill descriptions compete for selection and degrade both
   dedupe and discovery as the local catalog grows.
3. Each candidate also runs through the W8 audit for unsafe shell/network/credential behavior in
   bundled scripts — the same class of check W8 already applies to locally-authored skill scripts,
   applied here to content arriving from outside the project.
4. A skill that passes both gates is **referenced, not copied**: the manifest records a `kind: "skill"`
   entry whose content lives at its original external path (or a pinned, checksummed cache of it under
   `~/.keryx/skills/<name>/`, still distinct from the project's own `.metaproject/skills/`), with
   `metadata.origin` (the provenance field W1 already defines for catalog governance) set to the
   external source. This keeps an operator's decision to trust one external skill from silently
   duplicating its content into every project that imports the bundle, and keeps a later upstream fix
   to that skill reachable by re-running verify/import rather than requiring every project to notice
   and manually re-copy it.

### Canonical instructions → per-harness instruction files

`.metaproject/rules/` is the canonical source (already the *target* of the existing import direction,
`syncAgentRules`, `src/rules/agent-entrypoints.ts:24-64`). W4 defines the **contract** for the reverse
direction — one canonical rule set rendered into every harness's native instruction file — and hands
the actual per-harness renderers to W5, since W5 owns the harness capability matrix and adapter
registry those renderers must be validated against:

- Targets: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` (flat files, each harness's own instructions-file
  convention — unverified — requires a first-party harness documentation check before implementation),
  `.cursor/rules/*.mdc` (per-file frontmatter `description`/`globs`/`alwaysApply`), Kiro steering
  (`.kiro/steering/*.md`), Windsurf rules (`.windsurf/rules/*.md`, current location; legacy
  `.windsurfrules` noted as deprecated-but-still-read).
- Every rendered file is a **managed block**, reusing the `<!-- keryx:index -->`/`<!-- /keryx:index -->`
  sentinel convention `ensureMetaprojectReference` already implements (`src/rules/agent-entrypoints.ts:
  66-84`) rather than a new marker syntax — a harness-specific renderer inserts/replaces only its
  managed block and leaves the rest of the file (any content a human added outside the markers)
  untouched, and a `.mdc` file with no existing marker gets the marker inserted the same way
  `insertMetaprojectBlockNearTop` already does for `AGENTS.md`/`CLAUDE.md` (lines 139-167).
- A bundle's `kind: "rule"` entries are the canonical, harness-neutral source content; rendering them
  into a specific harness's file format happens at `apply` time via the W5 adapter registry, not at
  export time — this keeps one bundle importable into a project that only wants (say) Cursor's
  `.mdc` files without also writing `GEMINI.md` nobody asked for. `keryx bundle import` accepts
  `--render-for <harness>[,<harness>...]` to select which renderers run; omitted, it renders for every
  harness the target project's W5 capability matrix marks `native` or `adapter`.

### CLI surface

| Command | Purpose |
|---|---|
| `keryx bundle export --scope <project\|team\|user> [--include <glob>] <output>` | Produce a portable bundle from the given scope. |
| `keryx bundle import <bundle> [--target-scope <scope>] [--render-for <harness,...>] [--dry-run\|--json] [--force <path>...]` | Plan → W8 audit → apply, per the lifecycle above. |
| `keryx bundle inspect <bundle> [--json]` | Read-only manifest + diff-against-current-project report. |
| `keryx bundle verify <bundle>` | Recompute and check every entry's sha256; no import. |
| `keryx memory handoff --from <harness> --target <harness> [--scope <scope>]` | Explicit cross-harness memory read, filtered by `target_harnesses`, failing closed per the rules above rather than silently returning a partial set. |

## Data contracts

- `schemas/portable-bundle.schema.json` (this workstream) — the manifest shape described above:
  `formatVersion`, `bundleId`, `createdAt`, `sourceKeryxVersion`, `provenance`, `compat`, `contents[]`.
- `MemoryEntry` gains `source_harness` / `target_harnesses` (additive, optional, default-null/all) —
  a change to `src/memory/types.ts`, not a new schema file; the existing type already has no separate
  JSON Schema mirror in this codebase for the writer's cited evidence, so this workstream does not
  invent one.
- Dependency on W1's `install-manifest.schema.json` (plan/dry-run JSON shape reused, not duplicated).
- Dependency on W2's `agent-definition.schema.json` (bundle `kind: "agent"` entries are that shape).
- Dependency on W3's `learned-pattern.schema.json` (bundle `kind: "learned-pattern"` entries are that
  shape).
- Dependency on W6's `hook-config.schema.json` (bundle `kind: "hook-config"` entries are that shape).
- Dependency on W8's `harness-audit-report.schema.json` (the audit stage's output shape, consumed by
  `bundle import`'s plan→audit handoff).
- Dependency on W5's harness-capability-matrix (drives `--render-for` defaults and `compat.
  targetHarnesses` warnings).

## Integration

- **W1 (catalog)** — dedupe gate (`keryx skills scout`) gates external-catalog import; install-manifest
  plan format is reused for bundle plan output; `metadata.origin` provenance field is reused for
  referenced (not copied) external skills.
- **W2 (agents)** — agent definitions are one bundle content kind; W2's schema is the wire shape.
- **W3 (learning)** — learned-pattern records are one bundle content kind, wire-shaped per
  `learned-pattern.schema.json`. `keryx learn promote` is the only path that creates a user-scope
  pattern from project-scope evidence, and it reads the cross-project evidence index
  (`~/.keryx/learning/index.json`, written only by `keryx learn accept`) to require records from at
  least two distinct project identities before promoting. `keryx bundle import` may transport an
  already-`scope: user` record into `~/.keryx/learning/patterns/`; it never changes a record's scope
  and always writes it at `status: candidate` — it is not how project→user promotion happens. `keryx
  learn accept` is the only command that makes any record `accepted`, whether the record arrived via
  promote or via bundle import.
- **W5 (multi-harness)** — owns the actual per-harness instruction-file renderers this document
  specifies the contract for, and owns the capability matrix `compat.targetHarnesses`/`--render-for`
  read to decide which renderers apply.
- **W6 (hooks)** — hook-config is one bundle content kind; W6 owns its schema and the runtime that
  consumes an applied `hooks.json`.
- **W8 (security)** — the mandatory audit stage between plan and apply for imports; also the audit
  applied to a referenced-not-copied external skill catalog before it is trusted.

## Risks

- **`~/.keryx/` is a new, previously-nonexistent surface.** Introducing a user-home directory means
  Keryx now writes outside any project boundary for the first time in a catalog-content sense (the
  existing `.keryx/` project-local uses are all inside a project). This needs its own permission/
  consent story (first-run prompt before ever creating `~/.keryx/`) distinct from project-scope writes,
  which this document flags but leaves to implementation-plan sequencing rather than resolving here.
- **Conflict-policy fatigue.** Per-path `--force` confirmation is safer than a blanket flag but could
  make importing a large team bundle with many legitimately-updated files tedious; the plan/inspect
  output must make the `conflict` bucket easy to scan in bulk (e.g. grouped by content kind) so this
  does not become a reason operators reach for a blanket override instead.
- **`compat.targetHarnesses` as an advisory, not a gate, could be misread as a promise.** Documentation
  and CLI output must be explicit that a "targets: cursor" hint in a bundle's manifest is not the same
  as W5 confirming that harness will actually behave — the harness capability matrix (W5) is the
  source of truth for what is real; the bundle manifest only records what the *bundle's author*
  claimed.
- **Referenced-not-copied external skills create a dangling-reference risk.** If a skill is referenced
  by external path or a pinned cache rather than copied into the project, a later `bundle export` from
  that project could ship a manifest entry pointing at content the recipient cannot resolve (a
  different machine, a moved cache). `verify`/`inspect` must surface an unresolvable reference as its
  own failure mode distinct from a checksum mismatch, so operators do not confuse "cannot find this
  content" with "this content was tampered with."
- **Sibling-workstream schemas not yet final.** W4's bundle `contents[]` entries for `agent`,
  `learned-pattern`, and `hook-config` kinds depend on schemas owned by W2/W3/W6, which are themselves
  `planned`. If those schemas change shape after this document is written, `portable-bundle.schema.json`
  only constrains the envelope (`path`/`kind`/`sha256`/`scope`/`description`), not the content's
  internal shape, which limits the blast radius of a later change in a sibling workstream.

## Acceptance criteria

- **W4-AC1.** `keryx bundle export --scope project <out>` produces a manifest validating against
  `portable-bundle.schema.json`, with every `contents[].sha256` matching the actual exported bytes.
- **W4-AC2.** `keryx bundle verify` on a bundle whose bytes were altered after export (any single
  byte in any content file) reports that entry as a checksum failure and does not report the bundle as
  verified overall.
- **W4-AC3.** `keryx bundle import` on a bundle with any checksum mismatch fails the entire import
  closed — zero files are written — and reports which entries failed and why.
- **W4-AC4.** `keryx bundle import` never overwrites a target file whose current on-disk sha256 differs
  from the sha256 Keryx itself last wrote there, unless that specific path is passed to `--force`.
- **W4-AC5.** `keryx bundle inspect` on an unvetted, untrusted bundle performs no filesystem write and
  executes no script or command from the bundle.
- **W4-AC6.** A `MemoryEntry` with `source_harness` set can only have that value set by the MCP server
  process at launch time (a guard test asserts no code path lets a per-call tool argument override an
  already-bound `source_harness`).
- **W4-AC7.** A cross-harness memory read (`keryx memory handoff`) against a memory root with a
  truncated or malformed scan reports `status: "incomplete"`, never a smaller-but-labeled-complete
  result set.
- **W4-AC8.** Writing into a private-scope memory directory whose `.gitignore` already exists with
  conflicting content is refused with a named reason, and no `.gitignore` is silently modified.
- **W4-AC9.** Importing an external Agent-Skills-standard catalog entry that fails the W1 dedupe scout
  gate or the W8 audit is not added to the project in any form (neither copied nor referenced).
- **W4-AC10.** Rendering canonical rules into a harness-specific instruction file inserts or replaces
  only the managed block for that harness's renderer; pre-existing human-authored content outside the
  managed markers in `GEMINI.md`, a `.cursor/rules/*.mdc` file, Kiro steering, or a Windsurf rules file
  is byte-for-byte unchanged.
- **W4-AC11.** `keryx bundle import` never changes a `kind: "learned-pattern"` entry's `scope` field and
  always writes it at `status: candidate`, consistent with the rule that `keryx learn promote` is the
  only path that creates a user-scope pattern from project-scope evidence and `keryx learn accept` is
  the only command that makes any record `accepted`: a `scope: project` entry imported with
  `--target-scope user` is refused with a named reason and writes nothing; a `scope: user` entry
  imported with `--target-scope user` is written at `status: candidate` even when the source bundle
  recorded it as `accepted`.

## Open questions

- Should `team` scope eventually get its own on-disk root distinct from `project`, once real usage
  shows the label-only approach (a manifest's `scope: "team"` over the same `.metaproject/` tree) is
  insufficient to prevent a team-shared rule from accidentally being treated as merely project-local
  when the project itself is copied or forked?
- Should `~/.keryx/bundles/applied-state.json` (the per-path "last sha256 Keryx wrote here" ledger)
  live per-scope-root instead of one file, to avoid a single ledger growing unbounded across many
  imports over a long-lived user profile?
- Where exactly does a "private" project-scope memory subtree (referenced in the `.gitignore` fail-
  closed rule) get defined — is it a new `.metaproject/memory/private/` folder W3 introduces, or does
  every project-scope memory folder need the same `.gitignore` discipline? This document assumes W3
  will specify the boundary and only defines the fail-closed behavior once a private root exists.
- Should `keryx bundle import --external` cache a pinned copy of a referenced external skill under
  `~/.keryx/skills/` by default, or only on an explicit `--pin` flag — the tradeoff being resolvable-
  everywhere (cached) versus always-fresh-from-source (referenced live, at the cost of the dangling-
  reference risk noted above)?
