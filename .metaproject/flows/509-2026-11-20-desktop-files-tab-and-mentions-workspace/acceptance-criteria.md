# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with a [verify: …] marker.
- After `flow freeze` this file is checksum-protected.

## Criteria

- AC1: `project_files` returns tracked and untracked non-ignored files of a git fixture, excludes ignored files, filters by query and caps results at 200 for a query. [verify: exec `cd apps/desktop/src-tauri && cargo test files::`]
- AC2: `project_file_read` refuses a path escaping the project (`../x`, absolute outside, a symlink pointing outside), a directory, and a file above 8 MiB, and returns text of a normal file. [verify: exec `cd apps/desktop/src-tauri && cargo test files::`]
- AC3: Both commands reject a `cwd` that is not the calling view's registered project root (`require_project`). [verify: exec `cd apps/desktop/src-tauri && cargo test files::`]
- AC4: A `files` side-panel tab exists in the tab bar and the prefs whitelist, shows a tree, filters by search and shows a selected file; list/read failures show an error with retry. [verify: exec `cd apps/desktop && bun test src/panels`]
- AC5: In the composer, `@spec` opens a popup of matching paths; arrow keys move, Enter/Tab inserts `@<path> `, Esc closes, a mid-text `@word` at the caret works, and `/` mode is unchanged. [verify: exec `cd apps/desktop && bun test src/session`]
- AC6: Desktop checks pass: bun tests, tsc, cargo test, clippy -D warnings. [verify: exec `cd apps/desktop && bun test src && bunx tsc --noEmit && cd src-tauri && cargo test && cargo clippy -- -D warnings`]
- AC7: Live: in a debug build with a separate bundle id, `@spec` pick inserts a path and the agent reads the file. [verify: judged]
