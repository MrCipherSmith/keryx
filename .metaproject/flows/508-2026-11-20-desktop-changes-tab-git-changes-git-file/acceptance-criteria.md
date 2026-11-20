# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: git_changes on a fixture returns M/A/D/R/? statuses and truncated:true above 2000 entries [verify: exec `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml gitinfo`]
- AC2: git_file_diff shows the old side of a deleted file and a renamed file, and refuses paths absent from git_changes, `../x` and absolute paths [verify: exec `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml gitinfo`]
- AC3: line comments are sent as a plain text "Line comments" block with no resource and no untrusted marker; drafts clear after send and survive a rejected send [verify: exec `cd apps/desktop && bun test src`]
- AC4: tsc is clean [verify: exec `cd apps/desktop && bunx tsc --noEmit`]
- AC5: the Changes tab lists files, shows a numbered diff, selects lines, adds comments, and the footer counter opens the tab [verify: judged]
