# Keryx Memory Artifact Lifecycle
Version: 1.1.0

## Purpose

Define which memory files are durable project knowledge, which are generated
views, where they live, whether Git tracks them, how they are published, and how
legacy `latest` artifacts are retired.

## Classification

| Data class | Example | Canonical | Git | Retention | Writer |
|---|---|---:|---|---|---|
| memory entry | `.metaproject/memory/decisions/use-x.md` | yes | tracked | durable | guarded memory write seam |
| memory config | `.metaproject/memory.config.json` | yes | tracked | durable | init/update or maintainer |
| entry template/index | `.metaproject/memory/templates/entry.md`, `memory/index.md` | yes | tracked | durable | init/update |
| catalog snapshot | `.metaproject/data/memory/index/index.json` | no | ignored | regenerate/delete anytime | explicit `memory index` |
| embedding cache | `.metaproject/data/memory/embeddings/*` | no | ignored | content-hash invalidated | explicit/opt-in embedding index |
| search report | `.metaproject/runtime/memory/search/<run-id>/*` | no | ignored | user/tool cleanup policy | explicit `--save-report` only |
| staging/lock | `.metaproject/runtime/memory/tmp/*` | no | ignored | remove after run/crash recovery | atomic write/report seams |
| legacy latest report | `.metaproject/data/memory/artifacts/latest.*` | no | ignored/untracked | migration only | no new writer |

## Durable Entry Invariant

Only files under typed folders in `.metaproject/memory/` constitute durable
knowledge. Generated reports, catalogs, vectors, dashboards, verifier signals, and
runtime summaries must never override or silently amend that knowledge.

Durable entries are:

- human-readable Markdown;
- reviewable in Git;
- parsed on recall;
- changed only by explicit commands/manual edits;
- protected by validation and the memory security write seam when Keryx writes.

## Search Report Lifecycle

```text
pure search result in memory
        │
        ├── normal caller return ──▶ end (no artifact)
        │
        └── explicit --save-report
                 │
                 ▼
        allocate unique run-id
                 │
                 ▼
        write bounded md/json to temp run dir
                 │
                 ▼
        validate both formats
                 │
                 ▼
        atomic publish as immutable run dir
```

Rules:

- no implicit persistence from service, harness, MCP, approval, flow, or skill
  recall;
- run IDs are unique and injectable in tests;
- report files contain only relative paths and bounded projections;
- a successfully published run is immutable;
- interrupted temporary runs are not discoverable as completed reports;
- no global mutable `latest` file or symlink is required.

If a future dashboard needs “latest”, it resolves the newest completed run at read
time or consumes an explicitly maintained runtime pointer. That pointer remains
ignored and non-canonical.

## Catalog Lifecycle

`memory index` remains a compatibility command that builds a disposable catalog
of entry metadata. The catalog:

- is not consumed by canonical lexical search;
- may support dashboards or offline inspection;
- may include a source fingerprint to report staleness;
- is never required for recall correctness;
- is excluded from Git;
- may be removed without confirmation because it is reproducible generated data.

`memory check` validates entries regardless of catalog presence. If a catalog is
present and stale/corrupt, check reports a warning and the regeneration command.

## Embedding Lifecycle

Embeddings are a derived cache keyed by canonical-entry content hashes. They:

- are built only when the optional capability is requested and available;
- contain no authoritative status or lifecycle state beyond cache metadata;
- are ignored by Git;
- may be invalidated per-entry by content hash;
- may be deleted in full without data loss;
- never make lexical recall fail.

## Git Policy

Managed ignore rules must cover all generated memory classes. Init/update tests
must evaluate concrete paths with Git ignore semantics, not only compare template
text.

Expected rules:

```gitignore
.metaproject/data/memory/index/
.metaproject/data/memory/embeddings/
.metaproject/data/memory/artifacts/
.metaproject/runtime/
```

The repository continues to track `.metaproject/memory/**` and
`.metaproject/memory.config.json`.

## Privacy and Size Bounds

Generated reports must not serialize internal `MemoryEntry` objects directly.
Specifically they omit:

- `absolutePath`;
- full `details`;
- unbounded provenance payloads;
- unrelated scopes;
- embedding vectors.

Reports include only the bounded public result described in the specification.
The total result count and per-result excerpt are hard-capped. Security redaction
or guarding applies before explicit report publication if the report can contain
tool-originated content.

## Concurrency and Atomicity

- Pure searches share no mutable report state.
- Explicit report runs publish to unique directories.
- Canonical entry writes stage a same-filesystem temporary file and rename.
- Multi-entry operations validate and guard all next values before replacement.
- Recoverable failure removes temporary files and preserves canonical values.
- Crash leftovers are confined to the ignored runtime temp root and may be cleaned
  by a future maintenance command.

## Migration from Legacy Latest Artifacts

### Keryx repository

The implementation change removes the currently tracked:

```text
.metaproject/data/memory/artifacts/latest.md
.metaproject/data/memory/artifacts/latest.json
```

and adds the generated-data ignore policy. Their content is not migrated because
they are query receipts, not durable knowledge.

### Downstream projects

`keryx init/update` must be non-destructive:

1. add/update managed ignore rules;
2. stop producing legacy latest artifacts;
3. detect legacy tracked/untracked paths for an informational migration message;
4. never delete or invoke Git index mutation automatically;
5. provide a maintainer command example for optional untracking;
6. leave canonical memory entries untouched.

Example advisory text may suggest:

```bash
git rm --cached .metaproject/data/memory/artifacts/latest.md \
  .metaproject/data/memory/artifacts/latest.json
```

Keryx must not execute that command on the user's behalf.

## Retention

No automatic deletion policy is required in this corrective scope. Recommended
defaults:

- canonical entries: retain until explicit deprecate/supersede/removal workflow;
- catalog/embeddings: regenerate as needed;
- explicit reports: retain locally until manually cleaned;
- runtime temp: clean incomplete files on next write or maintenance run.

A configurable age/count retention command is a future capability, not a release
requirement.

## Lifecycle Acceptance Checks

- default recall creates no artifact;
- two explicit report runs coexist;
- all generated paths are ignored in a freshly initialized project;
- canonical entries are not ignored;
- reports omit absolute paths and full details;
- legacy artifacts are never read as source data;
- interrupted publication leaves no completed partial run;
- deleting catalog/embeddings does not change lexical results.
