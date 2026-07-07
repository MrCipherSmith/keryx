# Implementation Plan

Status: ready

## Approach

Create a small rules service that owns entrypoint discovery, managed-block
migration, and imported rule rendering. Wire this service into init/update and
expose it as `gd-metapro rules sync`.

This keeps the behavior reusable without inventing a separate parser format yet.
The imported rule file will carry explicit metadata (`type`, `priority`,
`source`, `version`) so agents and future tooling can rank it as high priority.

## Steps

1. Extract agent rule sync logic into a reusable service.
2. Add `gd-metapro rules sync` CLI command.
3. Update index and project-rules templates to show high-priority imported
   rules and strict root-entrypoint routing.
4. Add tests for standalone sync and init/update integration.
5. Run focused tests, full test suite, typecheck, build, health.
6. Record flow task progress.

## Risks

- Existing generated `.metaproject` files may change after update because tasks
  were intentionally backfilled for this flow.
- Importing a very large root entrypoint still creates a large rule file; the
  current scope is reliable discovery and priority metadata, not semantic
  section splitting.
