# Plan

## Approach
1. Rust (`src-tauri/src/files.rs`, registered in `lib.rs`): `project_files(cwd, query?)` runs `git ls-files -co --exclude-standard -z` (bounded via `child::run_bounded`, `GIT_OPTIONAL_LOCKS=0`), caps at 20000 paths, filters by case-insensitive substring/subsequence query, returns at most 200 results when a query is given (full list up to the cap when empty, for the tree). Non-git folders: bounded directory walk skipping `.git`, `node_modules`. `project_file_read(cwd, path)` goes through `require_project` + `fs::confine` (a symlink pointing outside is refused), refuses directories, files above `fs::MAX_FILE_BYTES` (8 MiB); a binary file (NUL in the first bytes) returns `binary: true`.
2. Web: wrappers in `platform/commands.ts`; `src/panels/FilesPanel.tsx` (tree built from the path list, search box, file view); `files` added to `SidePanelTab`, the prefs whitelist and `SIDE_TABS`.
3. Composer: `@` mode as a second mode of the popup: a word starting with `@` at the caret opens a "Files" group fed by `projectFiles`, same list, keys and completion; picking replaces the word with `@<path> `.

Deviation from spec §5: the read limit is the existing 8 MiB `MAX_FILE_BYTES` (owner instruction), not 1 MiB; the view truncates its rendering.

State × event matrix: not applicable for the Rust commands. UI:

| state \ event | query change | selection change | unmount / cwd change | retry |
|---|---|---|---|---|
| loading | drop stale response; loading shows for the newest | drop stale file response | no state write after unmount | re-request |
| loaded | refilter | open file | cleared | refresh list |
| empty | "No matching files" | — | — | — |
| list failed | error inline, last list kept | — | — | Retry reloads |
| read failed | — | error in the viewer, tree stays | — | reopen file |
