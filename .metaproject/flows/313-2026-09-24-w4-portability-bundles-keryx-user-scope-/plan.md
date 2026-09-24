# Implementation Plan

Status: approved (dispatched run; decisions recorded in journal.md)

## Approach

Five lanes with disjoint file ownership, run in parallel after a tiny shared foundation:

| Lane | Task | Owns |
|---|---|---|
| F | T5 | `src/lib/keryx-home.ts` — `resolveKeryxHomeDir(env, homeDir?)` (same semantics as W6 `resolveHookHomeDir`, which now delegates to it), `userStoreRoot`, `userStorePaths` (skills/agents/memory/learning/bundles/hooks.json) |
| A | T6 | `src/bundle/**` core (zone `core`): manifest types + schema validation, per-kind/scope target mapping with containment, sha256, directory + `.tar.gz` archive (no network, no exec), export collectors, verify, plan (new / identical / update / conflict / user-modified buckets, learned-pattern scope rule), applied-state ledger, staged W8 audit handoff, atomic apply, inspect, uninstall of bundle-managed files; service facade |
| B | T7 | `src/security/audit-harness/{index,types,checks}.ts` + audit report schema: `imported-bundles` surface over a staged bundle (`RunAuditOptions.importedBundle`), `bundle-*` check ids inheriting per-check severity |
| C | T8 | `src/memory/**`, `src/mcp/**`, `src/commands/memory.ts`: `source_harness`/`target_harnesses` (header fields `Source-Harness`/`Target-Harnesses`), strict scan (`status: complete|incomplete`), user-scope memory root + private-dir `.gitignore` fail-closed helper, MCP harness identity bound at `serve` launch (`--harness` / `KERYX_HARNESS`), `memory.search` filtered by target, MCP `memory.handoff` (strict read) and a draft-only write tool stamping the bound identity, `keryx memory handoff` CLI |
| D | T9 | `src/integrations/**`, `src/rules/**`, W8 `discoverInstructions`: parameterised managed markdown block (new `<!-- keryx:rules -->` marker so the existing `keryx:index`/`keryx:instructions` blocks are never touched), canonical-rules renderer, opt-in `rules-export` surfaces (flag `instructions`) for claude `CLAUDE.md`, codex `AGENTS.md`, gemini-cli `GEMINI.md`, cursor `.cursor/rules/keryx-rules.mdc`, kiro `.kiro/steering/keryx-rules.md`, windsurf `.windsurf/rules/keryx-rules.md`, github-copilot-agent `.github/copilot-instructions.md`; matrix regenerated |

Then, sequentially after A (+B, C, D merged into the branch):

| Task | What |
|---|---|
| T10 | `keryx bundle export|import|inspect|verify|uninstall` CLI (`src/commands/bundle.ts`, `CLI_ROUTES`, usage banner, help), `--render-for` → lane D renderer, external catalog import (`--external`: scout dedupe + W8 audit, referenced not copied, reference registry read by `keryx skills scout --include-imports`) |
| T11 | Docs: `docs/docs/cli-reference.md` sections (`bundle`, `memory handoff`), a portability guide, W4 spec status notes |
| T12 | Verification: Wave-3 exit fixture — export→import→inspect round trip byte-identical for checksummed content; a fixture file marked user-modified is never overwritten |
| T13 | Verification: every AC has an automated test or reproducible command (evidence list) |
| T14 | Adversarial review rounds + fix loop |

T1 (context) closes after this plan; T2 umbrella closes with T5–T10; T3 with targeted tests/typecheck/eslint; T4 when the draft PR is open.

## Key decisions

- **Scope roots.** project/team → `<project>/.metaproject/`; user → `<home>/.keryx/` where home =
  `KERYX_HOME` or `os.homedir()` (same resolver W6 uses for `hooks.json`). Bundle `contents[].path`
  is relative to the scope root: `skills/<name>/**`, `rules/**`, `agents/<name>.md`,
  `memory/<folder>/<file>.md`, `hooks.json`, learned patterns `data/learning/candidates/<id>.json`
  (project) / `learning/patterns/<id>.json` (user). User-scope `rules` are refused (no user rules
  root in the layout). Nothing ever targets `learning/index.json` or `learning/observations/`.
- **Applied-state ledger.** `.metaproject/data/bundles/applied-state.json` (project/team) and
  `~/.keryx/bundles/applied-state.json` (user): per target path → `{bundleId, sha256, kind,
  appliedAt}`. A file whose current sha256 differs from the ledger value, or an existing file with
  no ledger record that differs from the incoming bytes, is **user-modified**.
- **All-or-nothing apply.** Checksum mismatch, schema failure, unsupported `formatVersion` major,
  path escape, learned-pattern scope violation, audit failure, or any un-forced user-modified
  conflict → zero writes, named reasons. `--force <path>` is per path only (no blanket force).
  Chosen over the spec's "write the new entries, skip conflicts" reading because a partial import is
  harder to reason about and the invariant is fail-closed; recorded in the journal.
- **Agents.** Export writes the agent `.md` into the bundle with frontmatter `origin.kind: imported`,
  `origin.sourceRef: <bundleId>` (the checksummed bytes), so import is a byte-identical copy that
  `keryx agents verify` accepts; no rewrite at apply time.
- **Learned patterns.** Import never changes `scope`; a `scope: project` record with
  `--target-scope user` (or any mismatch) is refused by name; a `scope: user` record lands with
  `status: candidate` (the only content rewrite apply performs; the ledger records the written sha).
- **Audit gate.** Import stages `new`/`update`/forced-conflict entries into a temp dir and calls
  `runHarnessAudit(staging, { importedBundle })`; any unsuppressed `high`/`critical` finding, or an
  `error` surface status, refuses the import.
- **Rules rendering on import.** `--render-for <h,...>` runs the lane-D renderer for the named
  harnesses; omitted, it re-renders only harnesses whose `rules-export` surface is already installed
  (never creates a harness file nobody asked for).
- **Memory identity.** Bound once at `keryx mcp serve` launch; no tool accepts a harness argument;
  unbound server writes `source_harness: null`.
- **External catalogs.** Vetting is read-only: candidates are staged to a temp dir for scout +
  audit; passing skills are recorded by reference (source path + sha256 of each file) in
  `~/.keryx/skills/external-imports.json`; nothing is copied into `.metaproject/skills/` or the
  bundled catalog.

## Risks

- Parallel flows 311 (bundled agent renames) and 312 (W3 learning) touch neighbouring areas: this
  flow never edits `src/gdskills/bundled/agents/**` or implements `keryx learn`.
- Capability matrix drift gate (CI): lane D must regenerate `docs/integrations/harness-capability-matrix.json`.
- CLI reference coverage test: every new verb/subcommand must be named in `docs/docs/cli-reference.md`.
