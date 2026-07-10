# Module src/standard

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/standard` groups 9 file(s). Depends on `src/lib`, `src/commands`. Exposes 9 public symbol(s).

## Overview

`src/standard` is the compliance and discovery layer that implements the Metaproject Standard (v0.1.0). It validates that a workspace on disk conforms to the specification, evaluates which capability profiles are satisfied, and exposes a machine-readable discovery surface (`llms.txt`) that lets AI agents and tooling understand what a metaproject workspace offers without reading the full filesystem. The module is consumed primarily by the `src/commands` layer and the MCP server, which delegate all structured results back here; `src/standard` itself never prints or formats output.

## How it works

The module is organised in three distinct concern layers. The lowest layer is `profiles.ts`, which holds the authoritative module-category lists (`AGENT_MODULES`, `CI_MODULES`) and two pure functions: `computeProfiles` derives the correct profile set from a list of enabled module keys (always includes `minimal`, adds `agent`/`ci`/`full` based on which category buckets are populated), and `evaluateProfiles` inspects the actual filesystem to determine which profiles a workspace *currently satisfies* and compares them against what `metaproject.json` declares.

The validation layer lives in `validate.ts`. It bundles a self-contained JSON-Schema draft-2020-12 walker (a `walk`/`validateAgainstSchema` pair that resolves both `#/$defs/` references and external named schemas through a `SCHEMA_REGISTRY`) and uses it to verify `metaproject.json` and each enabled module entry against their respective schemas. On top of that schema check it performs eight additional structural checks: required files and directories exist, declared path fields resolve on disk, module manifests are present, root agent entrypoints (AGENTS.md / CLAUDE.md) link `.metaproject/index.md`, and profile declarations match the evaluated satisfaction set. Missing `data/` directories are demoted to warnings because they are generated lazily and are often gitignored.

`capabilities.ts` is a pure, stateless extractor that reads the in-memory manifest and normalises the `capabilities[]` array — accepting both the legacy bare-string form and the richer object form — into a uniform `CapabilitiesReport`. It never touches the filesystem.

`emit-llms.ts` provides the discovery surface. `renderLlms` is a pure, deterministic text renderer (no timestamps, all lists sorted) that produces a `llms.txt` following the llms.txt convention: an H1 title, a blockquote summary, a Modules section linking each enabled module's manifest, and a Generated artifacts section sourced from the on-disk `artifacts/` index. `emitLlms` drives the disk walk to collect artifact paths and composes the final file content.

`service.ts` is the thin facade consumed by the command layer. It provides `runValidate`, `runDoctor` (both delegate to `validateWorkspace`), and `runCapabilities` (reads the manifest then calls `extractCapabilities` and `evaluateProfiles`). Commands stay side-effect-free: they receive structured results and handle all printing themselves.

## Key concepts

**Metaproject Standard version** (`STANDARD_VERSION = "0.1.0"`) — the version string the implementation targets. It appears in manifests and `llms.txt` so tooling can detect compatibility without parsing code.

**Profile** — a named compliance tier for a workspace. The four profiles are `minimal` (core files and directories present), `agent` (agent-facing modules enabled and root entrypoints wired), `ci` (report modules enabled with an `artifacts/` directory), and `full` (all three satisfied simultaneously). Profiles are both *declared* in `metaproject.json` and *evaluated* from disk; the two sets can diverge, and `evaluateProfiles` surfaces both `unsatisfiedDeclared` and `undeclaredSatisfied` so the command layer can advise the user.

**Module category** — modules are grouped into `AGENT_MODULES` (gdgraph, gdctx, gdskills, gdwiki, memory) and `CI_MODULES` (health, testing). These categories determine which profiles a manifest will claim and which the workspace will satisfy.

**ValidationResult / Issue** — the structured output of workspace validation. Each issue carries a machine-readable `code`, a human-readable `message`, and an optional `fix` hint. Errors block compliance; warnings are advisory (e.g. missing `data/` directories).

**CapabilitiesReport** — a normalised, manifest-sourced view of the workspace: the standard version, declared profiles, and per-module enabled status, commands, and capability identifiers. This is the data structure exposed to MCP consumers.

**`llms.txt`** — the machine-readable discovery file written to `.metaproject/llms.txt`. It follows the llms.txt convention and is fully deterministic: re-running `emitLlms` on the same workspace produces a byte-identical file.

## Main flows

**1. `keryx standard validate` (or `doctor`)**
A command handler in `src/commands` calls `runValidate(cwd)` (or `runDoctor`) in `service.ts`. The service delegates immediately to `validateWorkspace(cwd)` in `validate.ts`. That function first checks required files and directories, then reads and parses `metaproject.json`, runs it through the bundled JSON-Schema walker against `MANIFEST_TOP_LEVEL_SCHEMA`, validates each enabled module entry against `MODULE_SCHEMA`, verifies that declared path fields exist on disk, confirms that root entrypoints link the index, and finally calls `evaluateProfiles` from `profiles.ts` to compare declared vs satisfied profiles. A `ValidationResult` with typed `errors` and `warnings` arrays is returned to the command layer for rendering.

**2. `keryx standard capabilities`**
The command calls `runCapabilities(cwd)` in `service.ts`. The service reads `metaproject.json` from disk (throwing a clear error if it is absent or malformed), then runs two independent operations in parallel: `extractCapabilities(manifest)` in `capabilities.ts` (pure, no I/O) normalises module commands and capability ids into a `CapabilitiesReport`, and `evaluateProfiles(cwd, manifest)` in `profiles.ts` checks the filesystem for each profile's conditions. Both results are returned together as `CapabilitiesResult`. The MCP server also calls this entry point to populate its tool responses.

**3. `keryx standard emit-llms`**
The command calls through to `emitLlms(cwd)` in `emit-llms.ts`. The function reads `metaproject.json` into a lightweight `Manifest` shape, then `collectArtifactIndex` walks `.metaproject/data/**/artifacts/**` to gather all artifact paths. Both inputs are handed to `renderLlms`, which builds the deterministic `llms.txt` body: a sorted module list with manifest links and command annotations, followed by a sorted artifact index. The function returns `{ path, content }` — the command layer writes the file to disk and reports the outcome.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `STANDARD_VERSION`
- `computeProfiles` (function)
- `evaluateProfiles` (function)
- `PROFILE_NAMES`
- `DoctorReport`
- `runValidate` (function)
- `runDoctor` (function)
- `CapabilitiesResult`
- `runCapabilities` (function)

### Key files

- `src/standard/profiles.ts` - imported by 6, imports 2
- `src/standard/service.ts` - imported by 4, imports 4
- `src/standard/validate.ts` - imported by 2, imports 3
- `src/standard/emit-llms.ts` - imported by 2, imports 2
- `src/standard/standard.test.ts` - imported by 0, imports 3
- `src/standard/capabilities.ts` - imported by 1, imports 0

### Depends on

- `src/lib` - 5 import(s)
- `src/commands` - 1 import(s)

### Depended on by

- `src/commands` - 6 import(s)
- `src/mcp` - 2 import(s)

### Graph signals

- Files: 9
- Cross-module imports: 6

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/mcp](src-mcp.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki agent from code reads of profiles.ts, service.ts, validate.ts, emit-llms.ts, capabilities.ts.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
