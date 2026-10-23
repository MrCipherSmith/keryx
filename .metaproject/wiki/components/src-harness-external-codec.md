---
Title: Module src/harness/external/codec
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/external/codec` maps each shipped external agent (`codex-cli`, `claude-cli`, `antigravity-cli`) to its codec and fails closed on unknown ids; it exposes `EXTERNAL_CODECS`, `getExternalCodec`, and `externalCodecIds` and depends on `src/harness/external`."
---
```markdown
---
Title: Module src/harness/external/codec
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/external/codec` maps each shipped external agent (`codex-cli`, `claude-cli`, `antigravity-cli`) to its codec and fails closed on unknown ids; it exposes `EXTERNAL_CODECS`, `getExternalCodec`, and `externalCodecIds` and depends on `src/harness/external`."
---

# Module src/harness/external/codec

## Summary

`src/harness/external/codec` is the code half of the external agent runtime: it holds the argv builders, stream parsers and failure classifiers for `codex-cli`, `claude-cli` and `antigravity-cli`, and a fail-closed lookup over them. Agent metadata lives elsewhere, in `src/harness/external/registry.ts`.

## Overview

This module is the point where the external agent runtime turns an agent id into the code that knows how to launch that CLI and read its output. Each external CLI needs logic that cannot be expressed as registry rows: how its argv is built, how its stream is parsed, and how a failed run is classified. The module keeps that logic in one file per CLI and exposes a single lookup over them, so callers never import the per-CLI files directly.

## How it works

`src/harness/external/codec/index.ts` is the entry point and the only file callers need. It holds the table `EXTERNAL_CODECS`, in registry order: `codexCliCodec`, `claudeCliCodec`, then `antigravityCliCodec`.

`getExternalCodec(agentId)` searches that table by `codec.id` and returns `undefined` for an unknown id. It never substitutes another codec, because an adapter built for the wrong agent would produce the wrong argv and misread its output. The index comment states that the registry's `getExternalAgent` is meant to fail closed in the same way.

Each per-CLI file exports one codec object built from three pure functions: argv construction, event parsing and outcome classification. None of them spawns a process, touches the filesystem or reads a clock, so the adapters are tested offline against recorded transcripts under `fixtures/external/`.

- `claude-cli.ts` builds `claude -p` argv. It offers an allow-list tool roster (`CLAUDE_ALLOWED_TOOLS`, plus `Edit` and `Write` in `CLAUDE_WRITE_TOOLS` for write runs) and an empty MCP config. The argv order is load-bearing, because the flags in `CLAUDE_VARIADIC_FLAGS` would swallow a prompt placed directly after them.
- `codex-cli.ts` translates keryx sandbox modes into codex's vocabulary through `CODEX_SANDBOX_MODES`, where `worktree-write` becomes `workspace-write`, and adds confinement flags for write runs. Its classifier treats top-level `error` events as retry noise rather than a terminal failure.
- `antigravity-cli.ts` builds `agy -p ... --output-format stream-json` argv and folds the `step_update` events of the vendor stream onto the canonical `ExternalEvent` set. It never emits `--dangerously-skip-permissions`.

The module depends on `src/harness/external`, using its shared types, and sits inside that external integration boundary rather than owning it.

It is consumed by:

- `src/harness/external`
- `src/tui`

`src/harness/external/runtime.ts` calls `getExternalCodec(entry.id)` for non-ACP entries, and `src/tui/external-delivery.ts` resolves a target's codec with it. The tests in `src/harness/external` import the same exports, including one that checks registry and codec agreement.

## Key concepts

### External codec

An external codec is one object per external CLI, with an `id` and the three functions above. It is typed as `ExternalAgentCodec` in `src/harness/external/types.ts`.

### Codec registry

`EXTERNAL_CODECS` is the public, enumerable table of shipped codecs. Callers can list agents from it instead of guessing, and a test can pin that the registry and the codecs agree.

### Codec identifier

Lookup uses `codec.id`, which matches the agent id in the registry. `externalCodecIds()` lists the ids in registry order, and `getExternalCodec` resolves one codec from an id.

### Fail-closed lookup

An id with no codec returns `undefined`, and there is no default. Callers treat that as a true fact, that keryx cannot drive this agent, and refuse the dispatch with that reason.

### Canonical event stream

Each vendor stream (codex JSONL, Claude stream-json, Antigravity stream-json) is mapped onto the shared `ExternalEvent` set. Downstream reducers can then consume external child runs without vendor-specific code.

## Main flows

### Enumerate available external codecs

A caller that needs the list of agents, rather than a single lookup, calls `externalCodecIds()`. It maps `EXTERNAL_CODECS` to ids in registry order. The index file names agent listing and a registry-agreement test as the users of this list.

### Resolve a codec for a dispatch

A caller holding an agent id calls `getExternalCodec(id)`. In `src/harness/external/runtime.ts` the lookup is skipped for ACP entries. The caller then uses the codec's argv builder, parser and classifier. If the result is `undefined`, the dispatch is refused.

### Translate a sandbox mode for codex

For a `worktree-write` codex run, `codex-cli.ts` maps the keryx sandbox term through `CODEX_SANDBOX_MODES` to `workspace-write`. The raw keryx term would be rejected by the codex CLI, so the translation is required before argv is built.

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

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
```
