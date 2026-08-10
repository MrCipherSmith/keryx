# Acceptance Criteria

## Criteria

- AC1: A shared automatic-recall helper builds accepted/current filters with a hard result bound, while explicit diagnostic CLI search still returns a requested non-accepted status.
- AC2: `MetaprojectPort.memorySearch` defaults to accepted/current, validates query/status/class/limit inputs, and returns only bounded portable DTOs with relative paths and excerpts.
- AC3: Unified harness `memory_search`, unified MCP `memory_search`, and legacy MCP `memory.search` project the same bounded portable DTO and never expose a raw `MemoryEntry`, details, or an absolute path.
- AC4: Approval context requests accepted/current memory with limit one, remains best-effort, and cannot make draft, conflict, deprecated, expired, superseded, or not-yet-valid memory advisory instruction.
- AC5: Flow related-memory selection is accepted/current; any retained planning-only material is explicitly advisory and not rendered as instruction.
- AC6: Procedural injection uses accepted/current/scoped procedural memory and enforces a hard maximum even when configuration requests more.
- AC7: gdskills verification reads canonical accepted/current authoritative entries directly and no longer relies on legacy latest-memory artifacts.
- AC8: Cross-surface matrix tests cover accepted, draft, conflict, deprecated, expired, superseded, future/not-yet-valid, and Valid-To-boundary states; large summary/detail tests prove automatic agent/harness/MCP payload bounds.
- AC9: Focused and cross-surface tests, changed tests, TypeScript check, and the appropriate broader suite pass; only P3 checklist/progress lines are updated after verification.
