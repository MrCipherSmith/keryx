---
Title: Module src/contracts
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/contracts` groups 6 file(s). Depends on `src/security/detect`. Exposes 5 public symbol(s)."
---
```markdown
---
Title: Module src/contracts
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/contracts` is a validation-contracts component that exposes five public symbols for schema validation. Its validator is a hand-written Draft 2020-12 subset, and it depends on `src/security/detect` only for the export audit."
---
# Module src/contracts

## Summary

`src/contracts` is the validation-contracts component for the keryx harness. It groups six files and exposes five public symbols: the shape of a validation outcome (`ValidationResult`, `SchemaError`), its options (`ValidateOptions`), and two entry points that check data against a frozen JSON Schema file or an in-memory schema object. Its `validator.ts` is a deterministic, hand-written subset of JSON Schema Draft 2020-12 with no external library. It depends on `src/security/detect` only from `export-audit.ts`, which reuses the repo's secret and PII detectors to audit exported artefacts.

## Overview

The module owns the contract layer that checks structured data against the frozen Keryx harness schemas. It defines what a validation outcome looks like and exposes two ways to validate: `validateAgainstSchema`, which loads a named schema file and resolves its cross-file `$ref`s, and `validateAgainstSchemaObject`, which takes an inline schema (for example a tool's `inputSchema`) directly.

Validation is deterministic: the module reads schema files only, with no clock, network or randomness, so the same data gets the same verdict. The code graph lists the modules that import it, including `src/bundle`, `src/gdskills/manifest`, `src/bus`, `src/commands`, `src/flow` and `src/harness/hooks`; see the Reference section.

## Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `ValidateOptions` | interface | Options passed to validation operations |
| `ValidationResult` | interface | Outcome of a validation operation |
| `SchemaError` | interface | Error or violation during schema validation |
| `validateAgainstSchema` | function | Validate data against a schema |
| `validateAgainstSchemaObject` | function | Validate data against a schema-like object |

## How it works

### Core validator

`validator.ts` holds the validation engine. `validateNode` walks a schema and a value together and appends `SchemaError` entries (a JSON-path-like `path` and a `message`) rather than throwing. It is the single engine behind both public entry points: `validateAgainstSchema` loads the root schema through `SchemaResolver`, while `validateAgainstSchemaObject` uses the schema it is given. When `type` does not match, the node stops there, because type-specific keywords mean nothing for a value of the wrong type. Combinators (`allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`) run sub-validations and count the errors they produce.

### Keyword set

The validator implements only the keywords in `SUPPORTED_KEYWORDS` (`keyword-coverage.ts`). A keyword it does not implement would be silently ignored, so `usedKeywords` walks the frozen schemas and reports which keywords they rely on, and the coverage tests check that every one is supported. Several keywords, including `exclusiveMinimum`, `propertyNames`, `dependentRequired` and `not`, were added because a schema depended on them, as the comments in `validator.ts` record.

### Reference resolution

`resolver.ts` provides `SchemaResolver`. It loads a schema file by bare name from `schemaDir`, caches it, and resolves `$ref`s: local `#/...` pointers, cross-file references, and the `https://keryx.local/schemas/harness/` `$id` prefix. `resolvePointer` decodes RFC 6901 JSON Pointers. Nothing is fetched over the network.

### Type hierarchy

The module separates validation inputs, outputs, and errors through public types:

- `ValidateOptions` — carries `schemaDir`, the directory the schema files are read from
- `ValidationResult` — `valid` plus `errors`; `valid` is true only when `errors` is empty
- `SchemaError` — a `path` (for example `$.field`) and a `message` describing the violation

### Export audit

`export-audit.ts` is the only file here that imports `src/security/detect`. `auditContentForExport` runs `detectSecrets` and `detectPii` on a file's content and also flags absolute home-directory paths (`/Users/...` or `/home/...`). `auditPathsForExport` refuses an empty file list, so an audit cannot pass without scanning anything. This is separate from schema validation: the validator never calls the security detectors.

### Supporting files

| File | Purpose |
|------|---------|
| `resolver.ts` | `SchemaResolver` and `resolvePointer`: loads schema files and resolves `$ref`s |
| `export-audit.ts` | Export audit of the agent-first-core schemas and examples (secret, PII and private-path checks) |
| `keyword-coverage.ts` | `SUPPORTED_KEYWORDS` and `usedKeywords`, which show schemas use only keywords the validator implements |
| `fixtures.test.ts` | Positive, negative, keyword, mutation, migration and fixture-hash matrices over the frozen fixtures |

## Main flows

### Validate a schema file

1. Caller passes a schema file name and data to `validateAgainstSchema`, with `ValidateOptions.schemaDir`
2. `SchemaResolver` loads and caches the root schema; cross-file `$ref`s are resolved against the same directory
3. `validateNode` checks the data and collects `SchemaError` entries
4. The result is a `ValidationResult`, valid only when no errors were collected

### Validate against an inline schema

1. Caller passes a schema object (such as a tool's `inputSchema`) to `validateAgainstSchemaObject`
2. The same `validateNode` core runs; `schemaDir` is read only if the schema contains a cross-file `$ref`

### Audit an export

1. `auditPathsForExport` receives the list from `listAgentFirstCoreExportFiles`, which enumerates every schema and example file
2. Each file is passed to `auditContentForExport`, which runs the secret, PII and private-path checks
3. The result reports `clean` and the findings per file; an empty input is rejected rather than reported as clean

## Key concepts

- **Schema validation** — checking a schema or object against expected contract rules
- **Validation result** — structured outcome representing success, failure, or validation metadata
- **Schema error** — violation described by the contract layer when input does not match a schema
- **Validation options** — caller-provided settings controlling validation behavior
- **Export audit** — the check that exported artefacts contain no secrets, PII or absolute home-directory paths, using `src/security/detect`; the validator itself does not use it
- **Keyword coverage** — the proof that every schema keyword in use is one the validator implements

## File inventory

| File | Imports received | Imports made |
|------|-------------------|--------------|
| `src/contracts/validator.ts` | 43 | 1 |
| `src/contracts/export-audit.ts` | 1 | 2 |
| `src/contracts/keyword-coverage.ts` | 2 | 0 |
| `src/contracts/resolver.ts` | 1 | 0 |
| `src/contracts/agent-first-core.fixtures.test.ts` | 0 | 3 |
| `src/contracts/fixtures.test.ts` | 0 | 2 |

## Dependencies

**Module depends on:**
- `src/security/detect` — 2 cross-module imports, both from `export-audit.ts` (secret and PII detectors)

## Related Wiki

- [Wiki Index](../index.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/harness/resume](src-harness-resume.md)
- [Module src/harness/tool](src-harness-tool.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/flow](src-flow.md)
- [Module src/harness/branch](src-harness-branch.md)
- [Module src/harness/flow](src-harness-flow.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```

<!-- keryx:reference:begin v=1 hash=15bad24179de3fb173daaab947d475d94113b82636c0a43529d882f2c62ba6ad -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `SchemaError`
- `ValidationResult`
- `ValidateOptions`
- `validateAgainstSchema`
- `validateAgainstSchemaObject`

### Key files

- `src/contracts/validator.ts` - imported by 61, imports 1
- `src/contracts/agent-first-core.fixtures.test.ts` - imported by 0, imports 3
- `src/contracts/export-audit.ts` - imported by 1, imports 2
- `src/contracts/fixtures.test.ts` - imported by 0, imports 2
- `src/contracts/keyword-coverage.ts` - imported by 2, imports 0
- `src/contracts/resolver.ts` - imported by 1, imports 0

### Depends on

- `src/security/detect` - 2 import(s)

### Depended on by

- `src/bundle` - 3 import(s)
- `src/gdskills/manifest` - 2 import(s)
- `src/bus` - 1 import(s)
- `src/commands` - 1 import(s)
- `src/flow` - 1 import(s)
- `src/harness/hooks` - 1 import(s)

### Dependency basis

- Production imports only: 44 import(s) from test file(s) (e.g. `src/commands/operator-confirm-review-tools.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 6
- Cross-module imports: 2
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/bundle](src-bundle.md)
- [Module src/gdskills/manifest](src-gdskills-manifest.md)
- [Module src/bus](src-bus.md)
- [Module src/commands](src-commands.md)
- [Module src/flow](src-flow.md)
- [Module src/harness/hooks](src-harness-hooks.md)

## Changelog

- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
