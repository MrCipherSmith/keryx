# Module src/security/audit-harness

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/security/audit-harness` is the engine behind `keryx security audit-harness`. It scans the agent configuration surfaces (instructions, settings, MCP configs, hooks, agent definitions, skills and staged imported bundles) and returns a scored, baseline-aware report. It only reads by default and writes through two explicit paths: fix-proposal apply and baseline add. It groups 13 file(s), depends on `src/lib`, `src/security`, `src/security/detect`, and exposes 4 public symbol(s).

## Overview

This module owns the read-only audit of an agent workspace's configuration. It discovers the files on each surface, runs the check catalog against their content, gives each finding a stable id, applies the checksum-guarded suppression baseline, and scores the result. `computeAuditInternal` in `src/security/audit-harness/index.ts` is the core, and `runHarnessAudit` returns its public report. The only writing paths are `applyAuditProposal` in `proposals.ts` and `addBaselineEntry` in `baseline.ts`.

## How it works

The module has three layers. Surface discovery (`./surfaces`, re-exported from `index.ts`) finds candidate files. Content is read as raw bytes and decoded through `decodeTextVariants`, which returns a BOM-aware view and a lossy UTF-8 view, so a UTF-16 or UTF-32 file is not silently scanned as noise. The check functions in `checks.ts` are pure: they take already-read content and return `RawFinding` values that have no id yet.

`computeAuditInternal` runs the surfaces in a fixed order (instructions, settings, mcp-configs, hooks, agent-definitions, skills, then imported-bundles when `options.importedBundle` is set). It then assigns each finding an id (`findingId`, a truncated SHA-256 over surface, check, path, policy id, matched token and pointer or line), applies baseline suppression, sorts, and computes the summary from the complete unsuppressed set. `--severity-floor` only trims the listed findings. `auditGate` reads the summary, so a display filter cannot hide a blocking finding from the gate. Coverage is `incomplete` when any surface reports `error` or a coverage reason is recorded, such as an MCP rug-pull baseline that was never established.

Each surface result has a status of `scanned`, `not-applicable` or `error`. A path that was discovered but could not be read or parsed makes the surface `error`, so it is never reported as clean.

Fix proposals carry an internal structured edit (`json-remove`, `json-set`, `text-replace` or `manual`) that is never serialized into the report. Their public ids are `p-` plus a 16-character hash, so no attacker-controlled text reaches a file name.

## Key concepts

- **Surface** (`SurfaceId`): one class of configuration the audit reads. The seven are instructions, settings, mcp-configs, hooks, agent-definitions, skills and imported-bundles.
- **Check** (`CheckId`): a named detector such as `hook-command-injection` or `over-permissive-allowlist`. For staged bundle content, the `bundle-*` variants run the same detectors and rewrite the surface to `imported-bundles`, keeping the severity unchanged.
- **RawFinding and AuditFinding**: a `RawFinding` comes from a check before it has an id. An `AuditFinding` is the same data with a stable `id` and a `suppressed` flag. Severity uses the `AuditSeverity` set, which is `SecuritySeverity` without `info`.
- **Baseline**: the checksum-guarded file `.metaproject/security-audit-baseline.json`. Each entry is keyed by `findingId` and has a justification and an optional `expiresAt`. Only a baseline whose `tamperState` is `ok` suppresses anything. An entry with no expiry is reported back as a low `indefinite-suppression` finding. An expiry date is inclusive through the end of that day in UTC.
- **ImportedBundleEntryKind**: the kind of a staged bundle entry (`skill`, `rule`, `agent`, `learned-pattern`, `memory-entry` or `hook-config`). The kind selects which checks run against that entry.
- **Downgraded injection**: a prompt-injection match that is quoted, fenced, or introduced as reported speech is downgraded to `medium` with confidence capped at 0.3, so it is still visible but does not fail the gate.

## Main flows

1. **Direct audit.** `runHarnessAudit(root)` calls `computeAuditInternal`. For each surface, the matching `discover*` helper lists files and the check functions run on their content. For settings and hook files, `collectHookCommands` walks `hooks`, `securityHooks` and `unmigratedHooks`. It handles both the bare-string `command` and the `command.argv` / `command.env` shapes, and each argv element and env value is checked at its own JSON pointer. The findings then get ids, go through baseline suppression, and are scored by `scoreFindings`.

2. **Imported bundle.** When `options.importedBundle` is set, `scanImportedBundle` handles each staged entry. Entry paths that are absolute, contain `..` or a backslash, or resolve outside the root are reported as unreadable and never opened. A `hook-config` is parsed as JSON once per decode variant. A `skill` has every file scanned as text, with no binary allowlist, because an allowlist was a bypass in an earlier review. Each variant's findings are unioned by id and rewritten onto the `imported-bundles` surface.

3. **Applying a fix.** `applyAuditProposal` checks the id format, takes a file lock, and refuses an id that was already applied. It re-runs the audit to find the proposal in the current tree, refuses `manual` edits, and then applies the edit with `applyJsonEdit` or `applyTextEdit`. Both refuse no-op edits, and `applyTextEdit` refuses an ambiguous match. The write is contained by realpath, a changelog line is appended to `changelog.jsonl`, and an `*.applied.json` marker is written. `addBaselineEntry` follows the same pattern: it refuses to add to a tampered baseline unless `reseal` is passed, and a reseal first backs up the old file to `<file>.bak-<timestamp>`.

---

<!-- keryx:reference:begin v=1 hash=b65f7916af489038ad5edbdae70f8c96e1b3bdadeb76c2e533ba9e14b6a6d732 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `computeAuditInternal`
- `defaultBaselinePath`
- `applyAuditProposal`
- `addBaselineEntry`

### Key files

- `src/security/audit-harness/index.ts` - imported by 8, imports 10
- `src/security/audit-harness/checks.ts` - imported by 2, imports 8
- `src/security/audit-harness/audit-harness.test.ts` - imported by 0, imports 9
- `src/security/audit-harness/baseline.ts` - imported by 2, imports 6
- `src/security/audit-harness/types.ts` - imported by 7, imports 1
- `src/security/audit-harness/proposals.ts` - imported by 1, imports 5

### Depends on

- `src/lib` - 10 import(s)
- `src/security` - 6 import(s)
- `src/security/detect` - 3 import(s)
- `src/agents` - 1 import(s)
- `src/integrations` - 1 import(s)

### Depended on by

- `src/gdskills/governance` - 1 import(s)
- `src/security` - 1 import(s)

### Dependency basis

- Production imports only: 7 import(s) from test file(s) (e.g. `src/agents/export.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/security/audit-harness/index.ts`

### Graph signals

- Files: 13
- Cross-module imports: 21
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/security](src-security.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/agents](src-agents.md)
- [Module src/integrations](src-integrations.md)
- [Module src/gdskills/governance](src-gdskills-governance.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
