# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The test preload (`src/lib/test-preload.ts`) makes `os.tmpdir()` return a realpath for every test, guarded by a test that fails if the normalisation is removed; the nine tmpdir-realpath tests (seven "flow 305" in review.test.ts, git-worktrees main-checkout, doctor worktrees, governance AC8, trigger-agent-task AC3) pass on this macOS machine, each file run on its own.
- AC2: `resolveGitCommonDir` returns the same canonical (realpath) directory from a main checkout and from a linked worktree, so `keryx doctor` no longer reports a false-stale worktree under a symlinked checkout path; covered by a test that fails without the change.
- AC3: `shell-exec-tool.test.ts` F5c reads the process table with a `ps` invocation valid on macOS and Linux and passes here.
- AC4: The codex control-char case in `compile.format-safety.test.ts` passes or is skipped with a stated reason when the running Bun's TOML parser rejects control characters; it still runs where the parser accepts them.
- AC5: `planUnattendedSandbox` takes its host-filesystem checks (`/run`, `/var/run`) through the injectable detect seam, and `unattended.test.ts` T14 passes on macOS with a fake Linux filesystem.
- AC6: The schedule-security "pinned wrapper" run-time tests use an interpreter that can execute on macOS, or are skipped with a stated reason where the copied interpreter cannot run — and the "changed wrapper is refused" tests no longer pass vacuously.
- AC7: CI on the flow's pull request is green.
