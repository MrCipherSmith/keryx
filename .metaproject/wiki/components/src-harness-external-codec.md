---
Title: Module src/harness/external/codec
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/external/codec` groups 5 file(s) for external codec selection and lookup; it exposes `EXTERNAL_CODECS`, `getExternalCodec`, and `externalCodecIds` and depends on `src/harness/external`."
---
```markdown
---
Title: Module src/harness/external/codec
Version: 0.1.0
Type: component
Status: accepted
Summary: "`src/harness/external/codec` is the codec-facing layer for external CLI integrations."
---

# Module src/harness/external/codec

## Summary

`src/harness/external/codec` is the codec-facing layer for external CLI integrations.

It groups 5 files, depends on `src/harness/external`, and exposes 3 public symbols:

- `EXTERNAL_CODECS`
- `getExternalCodec`
- `externalCodecIds`

## Overview

This module centralizes codec lookup for external tools used by the harness.

Its main purpose is to provide a stable entry point for callers that need to:

- discover which external codecs are available
- retrieve a codec by identifier
- keep CLI-specific codec details isolated from broader harness code

The current codec implementations are grouped around external CLI integrations, with dedicated files for `claude-cli` and `codex-cli`.

## How it works

The module follows a simple registry-style structure:

- `src/harness/external/codec/index.ts` is the entry point and exposes the public surface.
- `claude-cli.ts` and `codex-cli.ts` contain the codec implementations for specific external CLI integrations.
- `EXTERNAL_CODECS` exposes the available codec set.
- `getExternalCodec` retrieves a codec by identifier.
- `externalCodecIds` returns the list of available codec identifiers.

The module depends on `src/harness/external`, operating within the external integration boundary rather than owning that boundary itself.

It is consumed by:

- `src/harness/external`
- `src/tui`

This makes the module useful both for programmatic external harness logic and for UI-level selection flows.

## Key concepts

### External codec

An external codec represents support for a specific external CLI integration in a way that other harness code can look up and use.

### Codec registry

`EXTERNAL_CODECS` is the public collection of available external codec definitions.

This gives callers a single place to reason about what external codecs exist, without importing each codec file directly.

### Codec identifier

The public API supports identifier-based lookup:

- `externalCodecIds` lists available identifiers
- `getExternalCodec` resolves a codec from an identifier

This pattern allows callers to remain decoupled from the concrete implementation files.

### CLI-specific implementation

The files `claude-cli.ts` and `codex-cli.ts` indicate that codec support is organized by external CLI integration rather than by a single monolithic module.

## Main flows

### Discover available external codecs

A caller imports `externalCodecIds` from the module and calls it to obtain the set of supported external codec identifiers.

This flow supports:

- configuration
- validation
- selector UIs in `src/tui`

### Resolve a codec for a selected external integration

A caller that knows the desired external codec identifier calls `getExternalCodec(...)` to retrieve the corresponding codec definition from `EXTERNAL_CODECS`.

This keeps downstream code from needing direct references to:

- `claude-cli.ts`
- `codex-cli.ts`

### External harness consumes codec support

`src/harness/external` depends on this module to work with external codec definitions through a shared public API.

`src/harness/external/codec` serves as a lookup and packaging layer inside the broader external integration boundary.

## Reference

### Public API

- `EXTERNAL_CODECS` - collection of available external codec definitions
- `getExternalCodec(identifier)` - retrieves a codec by identifier
- `externalCodecIds()` - returns the list of available codec identifiers

### Key files

| File | Description |
|------|-------------|
| `src/harness/external/codec/index.ts` | Entry point; imports 3, imported by 3 |
| `src/harness/external/codec/claude-cli.ts` | Claude CLI codec implementation; imports 1, imported by 5 |
| `src/harness/external/codec/codex-cli.ts` | Codex CLI codec implementation; imports 1, imported by 4 |
| `src/harness/external/codec/claude-cli.test.ts` | Tests for Claude CLI codec; imports 2 |
| `src/harness/external/codec/codex-cli.test.ts` | Tests for Codex CLI codec; imports 2 |

### Dependencies

- `src/harness/external` (5 imports)

### Consumers

- `src/harness/external` (6 imports)
- `src/tui` (2 imports)

## Related pages

- [Wiki Index](../index.md)
- [Module src/harness/external](src-harness-external.md)
- [Module src/tui](src-tui.md)
```
