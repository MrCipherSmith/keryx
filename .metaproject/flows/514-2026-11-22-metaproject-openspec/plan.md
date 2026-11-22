# Plan

Use one TypeScript service and keep Desktop as a projection. Confirm Graph/Wiki v1 both ways and separate all write actions from the reader. Choose an in-memory bounded snapshot over introducing a new durable source database. Use the functional plan and verification in [implementation-plan.md](../../../docs/requirements/keryx-metaproject-openspec/implementation-plan.md).

## Task waves and ownership

- T1 is context (the reviewed docpack). T2–T4 scaffold tasks are superseded by the granular tasks below.
- T5 (Sol) owns src/openspec/catalog.ts. T6 (Sol) owns src/openspec/markdown.ts. T7 (Terra) owns initial fixtures and tests under src/openspec. All three may run in parallel and use the boundary below.
- T8 integrates source, Markdown, history and search. T9 (Sol) owns the Explorer wire and transport. T10 (Terra) owns public CLI, portable routing/guide and core CI discovery. T11 (Sol or Terra) owns Desktop view and styles. T9 and T10 run in parallel after T8. T11 can start from agreed mocks once the T9 contract is fixed.
- T12 GitHub CI, T13 packaged Desktop/Shell verification, T14 implementation review. Verify/review can overlap once all implementation lanes are integrated.
- Luna is unavailable in this host's spawn tool. Terra handles bounded work and Sol takes complex contracts. Workers use disjoint paths and leave Flow mutation and commits to the orchestrator.

## Initial reader boundary for parallel work

T5 exports types and async `scanOpenSpec(root: string)` from catalog.ts. Scan returns `{snapshotId, availability, entries, links, diagnostics, truncated}`. An entry has `{id, kind: "spec" | "change" | "archive", title, path, archiveDate?, artifacts}`. Each artifact has `{path, markdown, digest}` where digest is raw-byte SHA-256 and paths are relative to the selected checkout. The canonical spec entry path names spec.md; change/archive path names its directory. Link rows carry validated source/target kind and paths, zero-based index, file digest and relative config path. Catalog validates shape and source discovery; Explorer resolves targets against its catalogs. Store no files during reads.

T6 exports pure `parseOpenSpecMarkdown(markdown: string, options: { delta: boolean })` returning `{requirements, diagnostics}`. Requirement block contains `{title, markdown, startLine, endLine, operation?, renamedTo?, scenarios}`. Each scenario contains title, markdown, startLine and endLine. Operation is lowercase added/modified/removed/renamed. Parser is artifact-agnostic; service adds source scope and locators, computes canonical baseline matches and histories. Diagnostics from parser include a stable code and 1-based line. Neither lane imports UI or runs upstream tools.

T7 supplies a shared test fixture factory and eligibility coverage for the catalog and parser interfaces, with search contract tests wired after T8. Keep prefixes and IDs opaque. Test paths, line numbers, evidence, and failure states. Never execute a test suite locally.

## Desktop state × event matrix

| View state | Select section or linked item | Switch checkout / unmount | Retry or refresh |
|---|---|---|---|
| Loading | Keep current query and scope, invalidate earlier selection request (AC6) | Drop results from previous generation and show new root loading state (AC6) | Only latest request adopts state (AC6) |
| Ready | Preserve query, show corresponding detail and graph neighborhood (AC4, AC6) | Reset project-scoped selections and ignore old response (AC6) | Keep selected entry when it survives. Re-resolve section or explain stale location (AC3, AC6) |
| Missing or empty | Graph and Wiki still selectable. Distinct OpenSpec source message (AC1, AC6) | Scope state to new root (AC6) | Rediscover without writing the project (AC1) |
| Partial or stale graph | Display available records and omissions with graph freshness separately (AC1, AC4, AC6) | Discard stale results (AC6) | Preserve usable content with retry feedback. Never silently mix snapshots (AC6) |
| Source failed or old CLI | Route Graph/Wiki through established transport when supported. Show OpenSpec-specific message (AC5, AC6) | Hide previous failure and start new root load (AC6) | Retry only the current root and selected executable (AC5, AC6) |

## Shared service and transport

T8 supplies a local service in src/openspec/service.ts with an async `readOpenSpec(root)` entry point. The returned snapshot provides:
- `catalog` from T5 and the parsed entry evidence used by detail and relationships.
- `list({kind,cursor?})`, `detail({id?,path?,artifactPath?,section?,expectedDigest?})`, `history({id,cursor?})`, `search({query,scope?,cursor?})`.
- Scoped, page-bounded outputs with nextCursor and partial status. Search hits carry entry metadata, rank, snippet and section evidence. Keep artifact bodies out of list/search.
- `relationships` with canonical target spec path, change id, evidence and declared link rows. Delta relations derive from actual canonical paths and do not depend on the presence of Graph. Only expose deltas for current target specs in the projected graph.
- Service uses one in-memory scan result per operation. Validate cursor root, snapshot, view/search parameters and offset. The digest pin for a changed source rejects the old section and allows the caller to return to its parent.

T9 composes the source with legacy data. Keep both action-specific validators explicit and test the existing v1 roster using a fixed v2 capabilities request. Preserve Graph/Wiki behavior if there is no OpenSpec. A scope-aware shared search must map OpenSpec sections and rank across sources without losing all matches of either side. The Desktop transport must include selected binary and root in its capability cache, and v1 fallback is narrowly scoped to the negotiation step.
