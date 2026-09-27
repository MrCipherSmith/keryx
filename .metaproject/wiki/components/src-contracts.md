---
Title: Module src/contracts
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/contracts` groups 6 file(s). Depends on `src/security/detect`. Exposes 5 public symbol(s)."
---
```markdown
---
Title: Module src/contracts
Version: 0.1.0
Type: component
Status: accepted
Summary: "`src/contracts` is a validation-contracts component that exposes five public symbols for schema validation. It depends on `src/security/detect` for security-related checks during validation."
---
# Module src/contracts

## Summary

`src/contracts` is a validation-contracts component for the app. It groups six files and exposes five public symbols that define the shape of validation outcomes, validation options, schema errors, and schema-validation functions. It depends on `src/security/detect` for security-related detection used during validation.

## Overview

The module owns the contract layer between application data, harness operations, and schema-driven validation. Its public surface describes what a validation result looks like and how callers ask the module to validate either a schema or a schema-like object.

This keeps validation behavior consistent across modules that consume it, especially harness and flow components.

**Consumers:**
- `src/harness/resume` (4 imports)
- `src/harness/tool` (4 imports)
- `src/harness/child` (3 imports)
- `src/harness/branch` (2 imports)
- `src/harness/flow` (2 imports)
- `src/flow` (2 imports)

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

`validator.ts` exposes the primary validation entry points and supporting types. It is the most widely imported file in the module and coordinates the behavior behind `validateAgainstSchema` and `validateAgainstSchemaObject`.

### Type hierarchy

The module separates validation inputs, outputs, and errors through public types:

- `ValidateOptions` — caller-provided settings that control how validation is performed
- `ValidationResult` — structured outcome returned after validation (success, failure, or metadata)
- `SchemaError` — violation described when input does not match a schema

### Security detection integration

`src/security/detect` provides security detection imported by the validation layer. This allows validation to consult detection logic while checking schemas or objects, without requiring every consumer to wire that dependency directly.

### Supporting files

| File | Purpose |
|------|---------|
| `resolver.ts` | Contract or schema resolution for validation-related callers |
| `export-audit.ts` | Auditing exported contract behavior |
| `keyword-coverage.ts` | Coverage checks for validation keywords |
| `fixtures.test.ts` | Representative validation test cases |

## Main flows

### Validate a schema

1. Caller imports `validateAgainstSchema` from `src/contracts`
2. Supplies a schema plus `ValidateOptions`
3. `validator.ts` performs the check and returns a `ValidationResult`
4. If schema rules fail, result includes one or more `SchemaError` values

### Validate a schema-like object

1. Caller uses `validateAgainstSchemaObject` for object-shaped contract inputs
2. Relevant for harness and flow modules validating structured data
3. Security detection from `src/security/detect` may be incorporated during validation

### Resolve and audit contracts

1. Modules import resolver or audit helpers
2. Check exported contracts, keywords, or validation coverage
3. Fixture tests exercise representative validation cases

## Key concepts

- **Schema validation** — checking a schema or object against expected contract rules
- **Validation result** — structured outcome representing success, failure, or validation metadata
- **Schema error** — violation described by the contract layer when input does not match a schema
- **Validation options** — caller-provided settings controlling validation behavior
- **Security detection integration** — validation uses `src/security/detect` to include security-related checks

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
- `src/security/detect` — 2 cross-module imports (security detection during validation)

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

- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```
