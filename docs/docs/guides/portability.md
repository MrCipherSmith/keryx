# Move skills, rules, agents, and memory between projects and machines

Everything Keryx manages — skills, rules, agents, learned patterns, memory,
hook config — lives in exactly one project's `.metaproject/` by default.
There is no copy/paste story for handing a reviewer-profile rule to another
repo, or for keeping a personal skill or agent that follows you across every
project on one machine. **Portable bundles** are that transfer unit, and
**`~/.keryx/`** is the new machine-local root they can move things into.

This guide is task-oriented. For the full flag reference see
[cli-reference.md](../cli-reference.md); for the design rationale see
`docs/requirements/keryx-agent-platform-expansion/workstreams/W4-portability.md`.

## Scopes and roots

| Scope | Root | Version-controlled | What lives there |
|---|---|---|---|
| `project` | `<project>/.metaproject/` | Yes | Everything already project-scoped today: skills, rules, agents, memory, install-state. |
| `team` | `<project>/.metaproject/` (same tree) | Yes | Not a separate directory — a bundle manifest's `scope: "team"` marks project-scope content a team has chosen to standardize and move between repos via export/import. Labeling discipline over the existing tree, not a new location. |
| `user` | `~/.keryx/` | No (personal, machine-local) | Personal skills, personal agents, learned patterns promoted to user scope, and user-scope memory. |

`~/.keryx/` resolves through the same helper every user-store path uses
(`resolveKeryxHomeDir` in `src/lib/keryx-home.ts`): an explicit `homeDir`
override wins (test-only), then `KERYX_HOME`, then `os.homedir()`. Point
`KERYX_HOME` at an alternate location — a sandbox, a CI runner, a throwaway
profile — and every user-scope command follows it. The layout under that
root:

```
~/.keryx/
  skills/<name>/SKILL.md              # personal skills
  agents/<name>.md                    # personal agent definitions
  memory/<folder>/*.md                # user-scope memory, same folders as project scope
  learning/patterns/<id>.json         # user-scope learned patterns (W3)
  learning/index.json                 # cross-project evidence index (W3; written only by `keryx learn accept`)
  bundles/                            # imported/exported bundle cache
  bundles/applied-state.json          # per-path ledger for bundle apply
  hooks.json                          # user-scope hook config (W6)
  skills/external-imports.json        # referenced (not copied) external Agent-Skills catalog entries
```

Nothing under `~/.keryx/` is created until the first command that needs it
writes there — there is no separate `keryx init`-style step for the user
store.

## What a bundle is

A bundle is a directory or `.tar.gz` with one manifest (`bundle.json`) at its
root, validated against `schemas/portable-bundle.schema.json`. Manifest
fields:

- `formatVersion` — semver of the bundle *format* (not Keryx's own version);
  an unrecognized major version is refused rather than misread.
- `bundleId` — stable across re-exports of the same source, so `inspect` can
  tell "this is bundle X, contents changed" from "this is an unrelated
  bundle."
- `createdAt`, `sourceKeryxVersion` — export provenance.
- `provenance.sourceProject` — never a raw path: omitted, or a sha256 hash of
  a normalized git remote identity. A bundle never leaks which machine or
  path it was exported from.
- `compat.targetHarnesses` — advisory only (see [Limits](#limits)).
- `contents[]` — one entry per file: `{ path, kind, scope, sha256, sizeBytes, description?, origin? }`.
  `kind` is one of `skill | rule | agent | learned-pattern | memory-entry | hook-config`.
  `path` mirrors the on-disk shape for that `kind`/`scope` — a user-scope
  skill's `path` is `skills/<name>/SKILL.md`, matching `~/.keryx/` directly —
  so applying an entry is a plain, auditable copy, never a kind-specific
  rewrite.

The manifest carries no install script and no shell command of any kind.
Bundle apply is data movement — copy bytes whose checksum matches into a
known-shaped destination — never code execution. Anything that needs to run
(a skill's own `scripts/`) is content *inside* a `kind: "skill"` entry,
audited the same way any locally-authored skill script is audited, not part
of manifest processing.

## Export

```
keryx bundle export --scope <project|team|user> [--include <glob>]... [--kind <k,...>] [--id <bundleId>] [--target-harness <h,...>] <out>
```

Collects every matching item under the scope's root, computes its sha256,
and writes the manifest plus either a directory (`<out>` with no
`.tar.gz`/`.tgz` suffix) or an archive. Fully offline — the only process
spawned is a local `git remote get-url origin` read used for the
`provenance` hash, never bundle *content* execution. `<out>` must not already
exist (a directory target must be empty).

An exported `kind: "agent"` entry's frontmatter `origin:` is rewritten to
`{ kind: imported, sourceRef: <bundleId> }` before it is written into the
bundle — see [Agents](#agents-imported-from-a-bundle) below.

## Verify

```
keryx bundle verify <bundle>
```

Recomputes every `contents[].sha256` against the bundle's actual bytes and
reports pass/fail per entry, without importing anything. This is the
standalone form of import's own checksum step — run it in CI on a bundle a
team publishes, before anyone imports it, to confirm it was not corrupted or
tampered with in transit. A missing or unresolvable entry is reported with a
reason distinct from a checksum mismatch.

## Inspect

```
keryx bundle inspect <bundle> [--target-scope <scope>]
```

Strictly read-only: no temp files, no directory creation, no ledger write,
no process spawned. It reuses import's own plan/diff logic — which is itself
read-only, reading current file bytes and the applied-state ledger but never
writing either — and prints the manifest, each entry's
new/identical/update/conflict status against the current project, and any
`compat.targetHarnesses` warnings the harness capability matrix disagrees
with. Safe to run on an unvetted bundle from an untrusted source.

## Import lifecycle

```
keryx bundle import <bundle> [--target-scope <scope>] [--render-for <h,...>] [--force <path>]... [--dry-run]
```

Three fixed stages, always in this order, never skippable:

1. **Plan.** Every `contents[].sha256` is recomputed and compared against the
   manifest. **Any mismatch fails the whole import closed** — zero files
   written, no partial apply. Each remaining entry is then diffed against
   disk and the target scope's applied-state ledger into one of four
   buckets:

   | Bucket | Meaning |
   |---|---|
   | `new` | No file exists at the target path yet. |
   | `identical` | The existing file's sha256 already matches what the bundle would write — a no-op. |
   | `update` | The existing file matches what Keryx itself last wrote there (per the ledger) but not the incoming bytes — an ordinary update. |
   | `conflict` | The existing file differs from both the ledger's last-known value and the incoming bytes — a human (or something other than Keryx) touched it. |

2. **Audit.** Every `new`/`update`/forced-`conflict` entry's *bytes* are
   staged into a temp directory at their bundle paths and handed to
   `keryx security audit-harness` under the `imported-bundles` surface,
   before a single byte is written to the real target. An unsuppressed
   high/critical finding, or a staged surface that could not be scanned at
   all, refuses the whole import.
3. **Apply.** Only `new` entries and `conflict` entries explicitly named in
   `--force <path>` are written — atomically (temp file + rename), with a
   re-check of every target's current sha256 immediately before writing and
   a full rollback if any single write fails partway through. A file the
   ledger doesn't recognize as Keryx-managed, or one whose current bytes
   diverge from what the ledger last recorded, is never silently
   overwritten. `--force` takes exact bundle-relative paths (or
   `<scope>:<path>` display ids from `--dry-run`/`inspect` output) — there is
   no blanket "force everything" flag.

`--dry-run` runs plan (and, implicitly, the checks that gate it) and prints
the bucketed result without touching disk or the ledger.

**Applied-state ledger.** Every scope keeps its own ledger of "the last
sha256 Keryx itself wrote at this path": `~/.keryx/bundles/applied-state.json`
for user scope, `<project>/.metaproject/data/bundles/applied-state.json` for
project/team. `identical` entries are recorded too, so a bundle re-exported
and re-imported later is still recognized as Keryx-managed. Corrupt ledger
JSON fails closed rather than being treated as empty.

**Uninstall.**

```
keryx bundle uninstall <bundleId> --target-scope <scope> [--dry-run]
```

Removes only the files the ledger records as written by that `bundleId` *and*
still unmodified (current sha256 still equals the ledger's recorded value).
A file you've since hand-edited is kept, reported as `user-modified`, never
force-removed — uninstall has no override for this.

## Learned-pattern scope rule

`keryx bundle import` never changes a `kind: "learned-pattern"` entry's
`scope`, and never writes one at any status other than `candidate`:

- A `scope: project` entry can only be imported at `--target-scope project`
  (or `team`, same tree). Importing it at `--target-scope user` is refused
  with a named reason (`learned-pattern-scope`) and writes nothing.
- A `scope: user` entry can only be imported at `--target-scope user`, and
  always lands at `status: "candidate"` under `~/.keryx/learning/patterns/`
  — even if the source bundle recorded it as `accepted`. `keryx learn accept`
  is the only command that ever makes a record `accepted`; bundle import is
  a transport mechanism, never a second path to acceptance or to
  project→user promotion (that's `keryx learn promote`, a separate flow).

Import never writes `learning/index.json` — that file is owned entirely by
`keryx learn accept`.

## Agents imported from a bundle

A bundle's `kind: "agent"` entries carry `origin.kind: imported` with
`origin.sourceRef` set to the exporting bundle's `bundleId` — rewritten at
export time (see [Export](#export) above) so a project that later imports
the agent definition can tell it apart from one authored locally. See
[Give a subagent a name instead of a paragraph](agent-catalog.md) for the
full frontmatter contract, including the `origin` field's other `kind`
values (`authored`, `generated`, `learned`) and what `keryx agents verify`
checks about it.

## External Agent-Skills catalogs

`keryx bundle import <catalog-dir> --external` treats a directory of
`SKILL.md`-shaped folders (the public Agent Skills standard's own shape,
frontmatter `name`/`description`) as read-only vetting input, not content to
copy in wholesale:

1. Every candidate skill runs through `keryx skills scout`'s dedupe gate —
   an existing local skill judged a duplicate or an overlap rejects the
   candidate, so an operator authors a fork through the normal path instead
   of the catalog quietly growing near-duplicates.
2. Every candidate that survives scout also runs through the W8 security
   audit for unsafe shell/network/credential behavior in its scripts, the
   same check locally-authored skill scripts get.
3. A skill that passes both gates is **referenced, not copied**: recorded by
   reference in `~/.keryx/skills/external-imports.json` (source path,
   description, per-file sha256, the scout/audit decisions, the vetting
   timestamp). No file is copied into `.metaproject/skills/`, into
   `~/.keryx/skills/<name>/`, or into any bundle. A rejected candidate leaves
   no trace in that registry at all.

`keryx skills scout --include-imports` additionally searches this registry
when checking for a near-duplicate before a new skill is authored.
`keryx bundle verify --external-imports` reports each recorded import as
`ok`, `unresolvable` (the source path or one of its files is gone —
distinct from a checksum failure), or `checksum-mismatch` (the upstream file
changed since it was vetted).

## Cross-harness memory handoff

A memory entry can now record `source_harness` (which harness's session
wrote it) and `target_harnesses` (which harnesses may read it back;
absent/null means "all", the back-compatible default for every entry written
before this field existed).

`source_harness` is set exactly once, by the MCP server process itself, at
launch:

```
keryx serve-mcp --harness <id>          # or KERYX_HARNESS=<id> keryx serve-mcp
```

`--harness` wins when both the flag and `KERYX_HARNESS` are set. This
identity is bound once at process start and never re-resolved per call —
there is deliberately no per-call tool argument that can set or override it,
so a connected client cannot claim a different harness identity per call
than the process it is actually talking through.

Two ways to read across harnesses:

- **CLI:** `keryx memory handoff --from <harness> --target <harness> [--scope project|user] [--json]`.
- **MCP tool:** `memory.handoff` (`from` param; `target` is always the
  server's own bound `--harness` identity, never a caller-supplied value).
  Calling it on a server started without `--harness`/`KERYX_HARNESS` returns
  an error result rather than guessing an identity.

Both select entries whose `Source-Harness` equals `from` and whose
`Target-Harnesses` is unset or includes the target. `memory.search` applies
the same `target_harnesses` filter automatically to every automatic-recall
hit, using the server's bound identity.

**Fails closed on an incomplete scan.** If any memory folder can't be
listed, any file can't be read, or any entry is missing its title or carries
an unparseable `Source-Harness`/`Target-Harnesses` header, the handoff read
reports `status: "incomplete"` with the specific problems named — never a
smaller result silently labeled complete. Treat `entries` from an
`"incomplete"` result as partial, not authoritative.

**Private-dir `.gitignore` refusal.** User-scope memory (`~/.keryx/memory/`)
is expected to own a Keryx-managed `.gitignore`. If that file already exists
with different content, Keryx never overwrites or appends to it — writing
into that directory (via bundle import or otherwise) is refused with a
named reason (`private-gitignore-conflict`), and the existing file is left
byte-for-byte unchanged.

## Rules export to harness instruction files

`.metaproject/rules/` is Keryx's own canonical rule source. Rendering it
*outward* into a harness's native instruction file is the `rules-export`
surface, opt-in per harness:

```
keryx integrations install --runtime <id> --surface rules-export
```

or, as part of `keryx bundle import --render-for <h,...>` after an import
that wrote a `rule` entry into project scope (omit `--render-for` to render
for every harness `installedRulesExportHarnesses` already reports as
installed).

Every rendered file gets one managed block, delimited by
`<!-- keryx:rules -->` / `<!-- /keryx:rules -->` — an index of rule
path + description, never rule bodies. Only that block is inserted or
replaced; anything else in the file, including a *different* managed block
the same file already carries (for example `GEMINI.md`'s own
`keryx:instructions` pointer block), is left byte-for-byte untouched.

| Harness | File | Confidence |
|---|---|---|
| Claude Code | `CLAUDE.md` | verified |
| Codex | `AGENTS.md` | verified |
| Gemini CLI | `GEMINI.md` | experimental |
| GitHub Copilot (coding agent) | `.github/copilot-instructions.md` | experimental |
| Cursor | `.cursor/rules/keryx-rules.mdc` | experimental |
| Kiro | `.kiro/steering/keryx-rules.md` | experimental |
| Windsurf | `.windsurf/rules/keryx-rules.md` | experimental |

"Verified" means Keryx confirmed the harness reads that file end-to-end
(Claude Code's and Codex's own documented entrypoint conventions, and this
repository's own `CLAUDE.md`/`AGENTS.md` bootstrap blocks prove it in
practice). "Experimental" means the file and front matter follow that
harness's own documented convention, but whether the harness actually reads
it the way documented — beyond what's independently confirmed here — is not
verified; each surface's own risk note says exactly what is unconfirmed.

## Limits

- **`compat.targetHarnesses` is advisory, never a gate.** A bundle author
  naming `cursor` there is a hint, not a promise that Cursor will behave —
  `inspect`/`import` only warn when the harness capability matrix disagrees;
  they never block on it.
- **No three-way merge.** A `conflict` bucket entry is never automatically
  reconciled with a human's edit. Keryx surfaces the conflict and waits for
  an explicit per-path `--force`; it does not attempt to merge the two
  versions.
- **User scope has no rules root.** A bundle's `kind: "rule"` entry can only
  target `project`/`team` scope — importing one with `--target-scope user`
  is refused (`user-scope-rule-refused`).
- **Several `rules-export` targets are experimental**, not verified end to
  end — see the table above and each surface's risk note before relying on
  one for anything load-bearing.
- **Referenced-not-copied external skills can go stale or dangle.** Because
  an accepted external import records a path and per-file hashes rather than
  a copy, a later `bundle verify --external-imports` can report
  `unresolvable` if the source moved, or `checksum-mismatch` if it changed
  upstream — check both before trusting an old import is still what it was
  vetted as.
