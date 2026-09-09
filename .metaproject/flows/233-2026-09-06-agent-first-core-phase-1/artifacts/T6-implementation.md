# T6 — secure contained resource readers

## Result

Implemented the shared contained-reader seam and integrated it into MCP resource reads/listing plus harness wiki and skill reads. Internal file and directory links are allowed only when their canonical targets remain below the owner root. External links, replaced owner roots, non-regular files, byte-limit violations, descriptor identity changes, and unsupported descriptor backends fail closed with bounded typed errors.

The SAC `readWorkspaceFileNoFollow` entrypoint remains available through a compatibility wrapper over the shared descriptor primitive. It retains workspace-relative validation, `O_NOFOLLOW` directory/file opening, and explicit unsupported-platform refusal.

`resolveContainedPath` now refuses a replaced or symlinked owner root before resolving caller paths. The health port gate union also includes `incomplete`. The pre-existing interactive read-only tool surface was restored to `[get_cwd, list_dir, read_file]` after a concurrent edit temporarily returned an undefined symbol.

## Verification

| Check | Result | Evidence |
|---|---|---|
| Combined focused suites | PASS — 87/87 (15 containment, 64 SAC/workspace, 8 interactive) | `.metaproject/data/gdctx/raw/2026-09-06T12-04-07-001Z_run.log`; summary `.metaproject/data/gdctx/artifacts/2026-09-06T12-04-07-001Z_run.md` |
| Targeted Bun source build | PASS | `.metaproject/data/gdctx/raw/2026-09-06T12-04-57-853Z_run.log`; summary `.metaproject/data/gdctx/artifacts/2026-09-06T12-04-57-853Z_run.md` |
| Full typecheck | PASS | `.metaproject/data/gdctx/raw/2026-09-06T12-03-58-120Z_run.log`; summary `.metaproject/data/gdctx/artifacts/2026-09-06T12-03-58-120Z_run.md` |

No full project test run, network call, model call, package edit, lockfile edit, flow edit, or git mutation was performed.

## Routing audit

`graph_used: yes` (parent graph/context); `wiki_used: yes` (Metaproject wiki/index); `ctx_used: yes` (all searches, reads, commands, and logs); `raw_rg_used: no`.
