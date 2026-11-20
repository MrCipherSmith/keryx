# Context
- Spec: docs/requirements/keryx-desktop-workspace-panels (specification §5, §6.4, implementation-plan stage 4).
- Rust: apps/desktop/src-tauri/src/{panels.rs (PanelRoots::require_project), fs.rs (confine, MAX_FILE_BYTES), gitinfo.rs (pattern: git via child::run_bounded, GIT_TIMEOUT), lib.rs (invoke_handler)}.
- Web: src/panels/SidePanel.tsx (SIDE_TABS), src/lib/prefs.ts (SidePanelTab + whitelist), src/session/Composer.tsx (groups/matches/complete popup; groupCommands in src/acp/commands.ts), src/platform/commands.ts.
- A sibling session adds the `changes` tab and git_changes/git_file_diff in lib.rs/SidePanel/prefs: keep those edits small.
