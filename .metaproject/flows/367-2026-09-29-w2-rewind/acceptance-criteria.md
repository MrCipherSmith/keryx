# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A snapshot of the work tree is taken lazily, once per turn, immediately before the first tool call whose risk is write, shell, destructive or delegate; a turn that only reads creates no snapshot. Modules live in `src/rewind/`. [verify: exec `bun test src/rewind/snapshot.test.ts`]
- AC2: Snapshots live in a per-session shadow git repository under the session directory, addressed only through an explicitly set GIT_DIR and GIT_WORK_TREE. After snapshot and restore the project's own `.git` (HEAD, index, refs, stash list) is byte-identical, and a run started with GIT_DIR/GIT_WORK_TREE in the parent environment behaves the same. [verify: exec `bun test src/rewind/shadow-isolation.test.ts`]
- AC3: Restoring turn N returns the work tree to its state before turn N's first mutation: modified files are restored, files created since are removed, files deleted since are recreated; paths ignored by `.gitignore`, `.git`, `node_modules` and `.metaproject/data` are never touched; a file over 5 MB is skipped and reported by name. Before any restore a `pre-rewind` snapshot is taken so the rewind can itself be undone. An end-to-end test in a temporary git repository drives a real `apply_patch` and a real `shell_exec` write, then rewinds. [verify: exec `bun test src/rewind/restore.test.ts`]
- AC4: Rewinding history truncates `history` and `archive` to the chosen turn's user message and persists through the session store; the turn marker is an archive index that survives `/compact`; the rewind is refused when the session lease cannot persist. [verify: exec `bun test src/rewind/history.test.ts`]
- AC5: `/rewind` is in the slash registry and help, opens a TUI modal picker of turns (time, prompt excerpt, number of files changed) with the choices files only, history only, both, and asks for confirmation before applying; the sidebar shows a rewind section with the snapshot count; `/rewind` also works in the readline shell with a numbered list and appears in `READLINE_AGENT_COMMANDS`. UI text is English. [verify: exec `bun test src/tui/rewind-inspector.test.ts src/commands/shell-slash-registry.test.ts`]
- AC6: Retention keeps at most 50 snapshots per session and prunes the oldest; the shadow repository is removed with its session; `KERYX_REWIND=off` disables snapshots; an unattended run (trigger, serve, external agent) creates no shadow repository and refuses `/rewind`. [verify: exec `bun test src/rewind/retention.test.ts`]
- AC7: Documentation describes `/rewind`, its limits (work tree only, `shell_exec` side effects elsewhere are not covered) and the retention rule, on the docs site and in the README feature list; CHANGELOG has an entry; package.json is bumped to the next patch. [verify: exec `bun run docs:links`]
- AC8: The change ships as the next patch release: CI green on the PR head, a review round against the PR head with the verifier on, and the installed build passes `keryx --version`, `keryx review tier`, `keryx mcp list` and a scripted `/rewind` round trip through the real CLI route. [verify: judged]
- AC9: The flow stops after the release smoke; write-mode external agents wait for the operator's word. [verify: none — a stop is an absence of work; the journal entry and the operator report are the evidence]
