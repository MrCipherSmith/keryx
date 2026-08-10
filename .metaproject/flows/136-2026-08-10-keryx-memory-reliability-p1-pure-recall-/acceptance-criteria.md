# Acceptance Criteria

- AC1: `MemoryService.search()` is pure and its result has no required report path; all direct callers, fakes, fixtures, native/harness/MCP/approval/flow contexts compile and use the migrated contract.
- AC2: An explicit report DTO/rendering path emits only bounded projection fields, never a raw `MemoryEntry` or absolute path, and validates against `memory-search-report.schema.json`.
- AC3: `MemoryReportStore.writeReport()` accepts injected clock/run identity, atomically publishes immutable unique run artifacts, rejects/retries collisions without overwrite, and cleans interrupted temporary publication.
- AC4: `memory search --save-report` writes the explicit report and returns its identity/path contract; default text and `--json` search write stdout only and preserve project state.
- AC5: Unified `memory_search` remains `risk: "read"`, MCP `memory.search` remains `mutating: false`, and native and subprocess fallback paths are observably pure by default.
- AC6: `KERYX_P0_ENFORCE=1` passes for service, CLI text/JSON, harness/native, unified operation, MCP, and approval surfaces; repeated defaults retain a clean fixture.
- AC7: Semantic reranking/no-network fallback behavior remains green after the result migration.
- AC8: Only P1-1 through P1-10 are checked in the requirement plan after focused/type/broader verification; unrelated pre-existing sandbox proxy failures are distinguished if present.
