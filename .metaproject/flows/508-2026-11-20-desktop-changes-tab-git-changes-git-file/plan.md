# Plan

Rust (apps/desktop/src-tauri/src/gitinfo.rs, lib.rs): `git_changes(cwd)` and `git_file_diff(cwd, path)` with PanelRoots::require_project; path validated lexically against the last git_changes result (cached per cwd); `git status --porcelain=v2 -z --untracked-files=all`, 3s timeout, GIT_OPTIONAL_LOCKS=0, 2000 entries cap; diff via `git diff HEAD -M`, deleted -> old side from HEAD, untracked -> diff vs empty; 1 MiB cap.

Web: platform wrappers, `changes` tab in SidePanel/prefs, diff view on unifiedDiff.ts with line numbers + selection, comment input; `line-comment` kind in useChatAttachments; sent as a plain text block; footer GitStatus counter opens the tab.

State x event matrix: not applicable beyond: loading/empty/error states shown; a selected file that vanishes after refresh clears the diff.
