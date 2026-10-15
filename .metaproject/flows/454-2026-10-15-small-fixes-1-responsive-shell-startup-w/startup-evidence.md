# Startup execution evidence

- 333 tests passed, 0 failed; 1490 assertions across 7 files, 41.74 seconds.
- TypeScript and ESLint passed using root-installed tooling for the isolated worktree.
- Baseline/optimized warm orientation samples overlap; no proven full-startup speedup.
- Final PTY startup ~12.55s; TUI loading ~9.249s; tools/MCP/config ~8.7s; orientation ~490ms.
- Lag numbers redacted in captured output; animation freeze is not certified fixed.
- Mutations TP-M06/M08/M10 killed after test repairs; TP-M13/M14 survive (minor completion-wiring coverage gap).
- Raw local logs: .metaproject/data/review/small-fixes-1/ (not committed; see consolidated review.md for durable results).
