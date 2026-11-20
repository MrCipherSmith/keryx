# Desktop Files tab and @ mentions (workspace panels stage 4)

Status: draft
Source: docs/requirements/keryx-desktop-workspace-panels (stage 4, requirement R7)

## Problem

The desktop client has no way to browse project files, and the composer cannot reference a file by path. Users type paths by hand.

## Expected Outcome

- Rust commands `project_files` (list/search tracked and untracked non-ignored files) and `project_file_read` (read one file), both behind `PanelRoots::require_project`, path-confined, 8 MiB read limit.
- A `files` side-panel tab: tree, search, file view.
- An `@` mode of the composer popup: `@spec` lists matching paths, picking inserts `@<relative path>` into the message.
- English UI strings.

## Outcome criteria

- Demo: type `@spec` in the composer, pick a path, send; the agent reads the file.

## Out of Scope

Changes tab, line comments, attention, native images. Drag-and-drop from the tree is optional.
