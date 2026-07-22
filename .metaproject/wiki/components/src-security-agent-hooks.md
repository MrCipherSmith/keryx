---
Title: Module src/security/agent-hooks
Version: 1.0.0
Type: component
Status: accepted
Summary: `src/security/agent-hooks` groups 2 file(s). Depends on `src/security`. Exposes 11 public symbol(s).
---

# Module src/security/agent-hooks

## Summary

`src/security/agent-hooks` groups 2 file(s). Depends on `src/security`. Exposes 11 public symbol(s).

## Overview

`src/security/agent-hooks` is the multi-runtime hook installer for Keryx's security guardrails. It provides a registry of `RuntimeHook` adapters — one per supported AI agent runtime (Claude Code, Cursor, Windsurf, and a generic MCP target) — that know how to merge, strip, and validate the Keryx security CLI hooks into each runtime's settings file. The core invariant is idempotency and user-content preservation: managed entries are tagged with a sentinel (`_keryxManaged`) so install/uninstall operations never duplicate or destroy user-defined configuration.

## How it works

The module centers on a single `RuntimeHook` interface with four operations:

- `settingsPath` – resolves the runtime’s config file path under a project root.
- `merge` – injects managed hook entries idempotently.
- `strip` – removes only managed entries.
- `validate` – structurally checks that the rendered config routes both input and output through the security CLI.

Claude Code uses an event-keyed schema rooted in `.claude/settings.json`, where managed entries are inserted into the `UserPromptSubmit` and `PreToolUse` hook arrays. The other three runtimes (Cursor, Windsurf, generic-mcp) share a simpler flat-array model stored in their own per-runtime JSON files, where hook groups carry `{ on, command, _keryxManaged }` entries. Both paths use the same sentinel discipline: `setSentinel`/`clearSentinel` maintain a top-level `_keryxManaged` array in the settings object to track which installer owns which entries, and `stripManagedFromArray` filters them out before re-adding on install, making every install call idempotent.

The module exports the concrete `RUNTIME_HOOKS` array (all four adapters) and two navigation helpers, `runtimeIds` and `getRuntime`, which are the surface consumed by the parent `src/security` module for install/uninstall orchestration.

## Key concepts

- **`RuntimeHook` interface** — the contract each supported runtime must satisfy: settings location, merge, strip, and validate. Enables uniform treatment of structurally different settings schemas.
- **Sentinel discipline (`_keryxManaged`)** — a tag attached to every managed hook entry and also recorded in a top-level array in the settings file. Allows targeted removal of only Keryx-owned entries without touching user configuration.
- **Managed commands** — two CLI entry points are wired by all runtimes: `keryx security check-input --source untrusted-external` (runs on incoming user prompts) and `keryx security check-output` (runs before write/edit tool use). These are the actual security enforcement points.
- **Claude Code schema vs. flat schema** — Claude Code's `settings.json` uses named event keys (`UserPromptSubmit`, `PreToolUse`) with nested hook arrays; the other three runtimes use a flat top-level `hooks` array with `on: "input"/"output"` discrimination. The two merge/strip/validate strategies handle this divergence.
- **`RUNTIME_HOOKS` registry** — the ordered list of all four `RuntimeHook` instances; the source of truth for `runtimeIds()` and `getRuntime()` lookups from the parent module.

## Main flows

**Install flow** — a caller (from `src/security`) calls `installRuntimeHooks(projectRoot, runtime)`. The runtime's `settingsPath` resolves the target file. The file is read (or defaulted to `{}`), passed to `merge`, which calls `stripManagedFromArray` on the relevant event/group arrays to remove any prior managed entries, then appends fresh managed hook groups, then calls `setSentinel` to record ownership at the top level. The merged settings object is written back to disk. Running install a second time strips the old managed entries before re-adding, so the result is identical to the first install.

**Uninstall flow** — a caller invokes `uninstallRuntimeHooks(projectRoot, runtime)`. The runtime's `strip` method reads the settings, calls `stripManagedFromArray` on each relevant array (removing only entries tagged with the sentinel), removes empty keys, and calls `clearSentinel` to remove the installer's name from the top-level `_keryxManaged` array. User-defined hook entries and all other settings keys survive untouched. Other runtimes' settings files are never read or modified.

**Validation flow** — after install, `runtime.validate(settings)` is called to confirm the rendered config actually contains the required commands for both input and output interception. Claude Code's validator walks the event-keyed arrays extracting `command` strings; the flat validator looks up `on: "input"` and `on: "output"` groups. An empty error array means the config is structurally correct and will enforce the security CLI on both prompt ingestion and file-write tool use.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by `--force`. The prose sections above are the agent/human-owned part.

### Public API

- `AGENT_HOOKS_SENTINEL`
- `MANAGED_KEY`
- `AGENT_CHECK_INPUT_COMMAND`
- `AGENT_CHECK_OUTPUT_COMMAND`
- `Settings`
- `RuntimeHook` (interface)
- `isManagedGroup` (function)
- `CLAUDE_RUNTIME`
- `RUNTIME_HOOKS`
- `runtimeIds` (function)
- `getRuntime` (function)

### Key files

- `src/security/agent-hooks/runtimes.test.ts` - imported by 0, imports 2
- `src/security/agent-hooks/runtimes.ts` - imported by 2, imports 0

### Depends on

- `src/security` - 1 import(s)

### Depended on by

- `src/security` - 1 import(s)

### Graph signals

- Files: 2
- Cross-module imports: 1

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/security](src-security.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
