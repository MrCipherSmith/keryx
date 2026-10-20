# Module src/bundle

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/bundle` is the portable-bundle core behind `keryx bundle`: it exports Metaproject content into a checksummed bundle, verifies and plans an import against the target scope's files and an applied-state ledger, and applies it with rollback. It groups 30 file(s), exposes 20 public symbol(s), and depends on `src/lib`, `src/contracts` and the agent-platform schemas.

## Overview

`src/bundle` owns the portable bundle format for moving Keryx content (skills, rules, agents, learned patterns, memory entries and hook config) between projects, scopes and machines. It defines the manifest shape and a closed vocabulary of refusal reasons, builds and reads `.tar.gz` or directory bundles, and runs the export, verify, plan, audit and apply stages of an import. The module does no CLI rendering; `src/commands/bundle.ts` calls it through the facade in `src/bundle/service.ts`.

## How it works

The module is layered from the format outward. `types.ts` holds the shapes (`BundleManifest`, `BundleContentEntry`, the scope and kind unions) and `BUNDLE_REFUSAL`, the named reasons every stage returns instead of a generic error, so the CLI can render stable strings. `archive.ts` is the container: `buildBundleArchive` writes a deterministic ustar tar inside gzip with sorted entries and fixed metadata, while `openBundle` reads a directory or archive fully in memory. It enforces entry, byte and manifest-size caps before decompressing, and refuses symlinks and any tar entry that is not a plain file or directory.

Export goes through `exportBundle` in `export.ts`. It collects candidates per kind from the scope's root, skips symlinks and non-portable names, validates `hooks.json` and learned-pattern JSON against their schemas, and rewrites each agent's `origin` to the bundle's id. The bundle id is derived from the git remote when there is one, and from a digest of the content list otherwise (always for user scope).

Import is a pipeline of separate stages. `planBundleImport` in `plan.ts` verifies checksums first and fails closed, then applies per-entry policy (scope mismatch, the hook opt-in, learned-pattern scope immutability), re-validates kind-specific content, resolves the target path, and buckets each entry as `new`, `identical`, `update` or `conflict`. The bucket comes from comparing the incoming, on-disk and ledger sha256 values, with ownership checked against the ledger record's `bundleId` and `sourceProject`. Conflicts are refused unless named in `--force`. `applyBundlePlan` in `apply.ts` runs only after an audit result is ok. It re-checks every target's sha256 for TOCTOU drift, writes new, update and forced entries through `writeContained`, records ownership in the applied-state ledger, and rolls back files, created directories and any created private `.gitignore` if a write or the ledger update fails. `service.ts` is only a re-export facade over these stages.

## Key concepts

- **Bundle and manifest.** A `BundleManifest` carries `formatVersion` (`BUNDLE_FORMAT_VERSION`, `1.0.0`), a `bundleId`, `provenance` (`producedBy`, `sourceScope`, optional `sourceProject`), `compat` and the sorted `contents` list, each with a path, kind, scope, sha256 and size.
- **Scope.** `project`, `team` or `user`. The manifest's `provenance.sourceScope` is the default target; an entry whose scope differs is refused unless the caller passes a target scope explicitly.
- **Content kinds.** `skill`, `rule`, `agent`, `learned-pattern`, `memory-entry` and `hook-config`. Each kind has its own path rules and validation. Learned-pattern scope is immutable across import.
- **Applied-state ledger.** A per-scope record of what each bundle wrote, keyed by canonical path and holding `bundleId`, `sha256`, `sourceProject`, `contentDigest` and the on-disk path. Ownership is decided by this ledger, not by the file alone.
- **Plan bucket and conflict reason.** `PlanBucket` is `new`, `identical`, `update` or `conflict`. A conflict carries a reason: `user-modified`, `unmanaged-differs` or `owned-by-other-bundle`.
- **Learned-pattern candidate.** An imported learned pattern is always rewritten to `status: "candidate"`, with its TTL reset, its confidence capped at `SEED_MODEL_BACKED`, and its original confidence kept in `provenance.importedFrom`.

`sourceProject` is a trust-on-first-use signal, not a forgery barrier. The comments in `plan.ts` say it only guards against accidental collisions between unrelated projects.

## Main flows

1. **Export.** `exportBundle` gathers candidates for the requested kinds, filters them by include globs and sorts them. Each file is checked against its kind's rules, and any refusal fails the whole export. An empty result is refused as `emptyBundle`. Otherwise the manifest is serialized and written as an archive or a directory.
2. **Import plan and apply.** `openBundle` loads the source, then `planBundleImport` runs `verifyBundle` and the per-entry stages above. The resulting plan goes through the audit gate (`auditBundlePlan`), and `applyBundlePlan` writes only the entries bucketed `new`, `update`, or a forced `conflict`. Identical entries are recorded in the ledger only when that bundle already owns the record.
3. **Learned-pattern import.** `rewriteLearnedPatternCandidate` produces the candidate bytes, which are validated against the learned-pattern schema before planning. `learnedPatternEqualModuloTtl` ignores the day-granular `ttl.expiresAt` and `importedAt` fields when comparing with the file on disk. This keeps a re-import on a later day reporting `identical` instead of a spurious `update`.

---

<!-- keryx:reference:begin v=1 hash=9b58146ff201c6b419ebd294bf7444c5318e3963f85a4773173c95f7633337ad -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `PlanBucket`
- `PlanConflictReason`
- `PlanEntry`
- `BundlePlan`
- `PlanBundleImportOptions`
- `planBundleImport`
- `BUNDLE_FORMAT_VERSION`
- `BUNDLE_CONTENT_KINDS`
- `BUNDLE_SCOPES`
- `BUNDLE_REFUSAL`
- `sha256Hex`
- `normalizeBundlePath`
- `validateKindPath`
- `targetFor`
- `scopeRoot`
- `buildBundleArchive`
- `openBundle`
- `parseManifest`
- `serializeManifest`
- `exportBundle`

### Key files

- `src/bundle/plan.ts` - imported by 8, imports 14
- `src/bundle/service.ts` - imported by 3, imports 14
- `src/bundle/export.ts` - imported by 6, imports 10
- `src/bundle/types.ts` - imported by 15, imports 0
- `src/bundle/archive.ts` - imported by 12, imports 1
- `src/bundle/apply.ts` - imported by 3, imports 9

### Depends on

- `src/lib` - 11 import(s)
- `docs/requirements/keryx-agent-platform-expansion/schemas` - 5 import(s)
- `src/contracts` - 3 import(s)
- `src/agents` - 2 import(s)
- `src/memory` - 2 import(s)
- `src/gdskills/governance` - 2 import(s)

### Depended on by

- `src/commands` - 1 import(s)
- `src/gdskills/governance` - 1 import(s)

### Dependency basis

- Production imports only: 7 import(s) from test file(s) (e.g. `src/bundle/audit.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 30
- Cross-module imports: 29
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/contracts](src-contracts.md)
- [Module src/agents](src-agents.md)
- [Module src/memory](src-memory.md)
- [Module src/gdskills/governance](src-gdskills-governance.md)
- [Module src/commands](src-commands.md)
- `docs/requirements/keryx-agent-platform-expansion/schemas` (no wiki page)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
