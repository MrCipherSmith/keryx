---
Title: Module src/standard
Version: 1.0.1
Type: component
Status: accepted
Summary: "Implements the Metaproject Standard (v0.1.0): validates workspace conformance, evaluates capability profiles, and provides a machine-readable discovery surface."
---
# Module src/standard

VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df  
VerifiedScope: sha256:1e60f5ac7a644f48352f7f476b84d5fc16da0414043f050119a4d922f4e98f24

## Summary

`src/standard` implements the Metaproject Standard (v0.1.0). It validates a workspace against the standard, evaluates its capability profiles, and prepares machine-readable information for tools and AI agents.

The module depends on `src/lib` and `src/commands`. Command handlers and the MCP server consume its structured results; output formatting and printing are handled by their callers.

## Responsibilities

The module covers four related concerns:

- **Profiles:** Derive profile declarations from enabled modules and evaluate which profiles a workspace satisfies.
- **Validation:** Check the manifest, enabled modules, required files, and declared paths for conformance.
- **Capabilities:** Normalize capability information from an in-memory manifest.
- **Discovery:** Build deterministic `llms.txt` content from manifest and artifact information.

## Profiles

The profile logic defines module categories and uses them to derive and evaluate workspace profiles.

- `AGENT_MODULES` identifies agent-facing modules.
- `CI_MODULES` identifies modules associated with CI and reporting.
- `computeProfiles` derives profile declarations from enabled module keys. The `minimal` profile is always included; other profiles depend on the module categories.
- `evaluateProfiles` inspects the workspace and compares the profiles it satisfies with those declared in `metaproject.json`.

The profiles are:

| Profile | Conditions |
|---------|------------|
| `minimal` | Core files and directories are present. |
| `agent` | Agent-facing modules are enabled and root entrypoints are wired. |
| `ci` | Report modules are enabled and an `artifacts/` directory is present. |
| `full` | The `minimal`, `agent`, and `ci` conditions are all satisfied. |

Declared and satisfied profiles may differ. Evaluation reports both declared profiles that are unsatisfied and satisfied profiles that were not declared.

The module categories described by this page are:

- `AGENT_MODULES`: `gdgraph`, `gdctx`, `gdskills`, `gdwiki`, and `memory`
- `CI_MODULES`: `health` and `testing`

## Validation

`validateWorkspace` checks workspace conformance and returns structured validation results. It validates `metaproject.json` and each enabled module entry against their schemas, then performs additional structural checks, including:

- Required files and directories exist.
- Declared paths resolve on disk.
- Module manifests are present.
- Root agent entrypoints (`AGENTS.md` and `CLAUDE.md`) link to `.metaproject/index.md`.
- Declared profiles match the profiles evaluated from the workspace.

Validation issues include a machine-readable code and a human-readable message, with an optional fix hint. Errors indicate failed conformance; warnings are advisory. Missing `data/` directories are treated as warnings because they may be generated lazily and gitignored.

The validation layer includes a JSON Schema draft-2020-12 walker. It resolves `#/$defs/` references and external named schemas through `SCHEMA_REGISTRY`.

## Capabilities

`extractCapabilities` reads the manifest in memory and produces a normalized `CapabilitiesReport`. It accepts both legacy bare-string entries and richer object forms in `capabilities[]`. The extraction itself does not access the filesystem.

The report provides a manifest-sourced view of the standard version, declared profiles, and per-module enabled status, commands, and capability identifiers. `runCapabilities` combines this report with profile evaluation, which does inspect the workspace.

## Discovery with `llms.txt`

`renderLlms` is a pure, deterministic renderer. It produces an `llms.txt` document containing:

- A title and summary blockquote.
- A modules section linking to enabled module manifests.
- A generated artifacts section based on the artifact index.

`emitLlms` gathers the manifest and artifact information needed for rendering and returns the path and content. The command layer handles writing the file. With the same inputs, rendering produces byte-identical content.

## Service entrypoints

The service layer provides a facade for command handlers:

- `runValidate` delegates to workspace validation.
- `runDoctor` also delegates to workspace validation.
- `runCapabilities` reads the manifest, extracts capabilities, and evaluates profiles.

These entrypoints return structured results rather than printing or formatting output.

## Main flows

### Validation and doctor

```text
src/commands handler
  └── runValidate / runDoctor (service.ts)
        └── validateWorkspace (validate.ts)
              ├── Read and validate metaproject.json
              ├── Validate enabled module entries
              ├── Check required files, directories, and declared paths
              ├── Check root entrypoint links
              ├── Evaluate workspace profiles
              └── Return validation issues
```

### Capabilities

```text
src/commands handler or MCP server
  └── runCapabilities (service.ts)
        ├── Read metaproject.json
        ├── extractCapabilities (capabilities.ts)
        └── evaluateProfiles (profiles.ts)
```

### Discovery

```text
src/commands handler
  └── emitLlms (emit-llms.ts)
        ├── Read manifest information
        ├── Collect artifact paths
        └── renderLlms(manifest, artifacts)
              └── Return path and content
  └── Command layer writes the file
```

## Public API

| Export | Type | Description |
|--------|------|-------------|
| `DoctorReport` | Type | Report structure for the doctor command. |
| `runValidate` | Function | Validate workspace conformance. |
| `runDoctor` | Function | Run diagnostic validation. |
| `CapabilitiesResult` | Type | Result structure for the capabilities command. |
| `runCapabilities` | Function | Extract and evaluate workspace capabilities. |
| `STANDARD_VERSION` | Constant | Target standard version, `0.1.0`. |
| `computeProfiles` | Function | Derive profiles from enabled modules. |
| `evaluateProfiles` | Function | Evaluate which profiles a workspace satisfies. |
| `PROFILE_NAMES` | Constant | Array of valid profile names. |

## Dependencies and consumers

`src/standard` depends on `src/lib` and `src/commands`. It is consumed by command handlers and the MCP server; `src/metrics` also depends on it.

## Related Wiki

Graph-derived links; only pages verified to exist are included.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/mcp](src-mcp.md)

## Changelog

- **1.0.1** — Reference refreshed from the code graph (5886c474).
- **1.0.0** — Prose sections enriched by gdwiki agent from code reads of `profiles.ts`, `service.ts`, `validate.ts`, `emit-llms.ts`, and `capabilities.ts`.
- **0.1.0** — Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections were drafts for the gdwiki enrich workflow.
