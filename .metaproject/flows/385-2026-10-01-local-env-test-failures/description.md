# Tests that fail only on a developer macOS checkout

Status: formalized 2026-10-01 after diagnosis.
Source: the user asked to fix the ~15 tests that fail on a clean `main` on this macOS machine while CI is
green (observed during flow 360's baseline runs).

## Problem

Diagnosis (T1, one test file at a time on `main` a3b25c26): none of the failures read the real home,
`XDG_*`, keryx config, the global project registry or credentials. They are macOS portability defects that
CI does not see because the full suite runs only on ubuntu; the macOS CI legs run a sandbox/TUI subset.

1. **`$TMPDIR` is a symlink on macOS** (`/var/folders/…` → `/private/var/folders/…`). Tests build paths from
   `os.tmpdir()`; the product canonicalises (`process.cwd()` after `chdir`, `realpathSync.native` in the
   project registry, git's absolute paths), so string comparisons disagree. 9 tests: seven "flow 305" tests in
   `src/commands/review.test.ts`, `src/lib/git-worktrees.test.ts` (main-checkout resolution),
   `src/commands/doctor.test.ts` (worktrees agree), `src/governance/report.test.ts` (AC8 all-projects),
   `src/commands/trigger-agent-task.test.ts` (AC3 granted tools). Proven: `TMPDIR=$(realpath $TMPDIR)` makes
   every one pass. Side finding in product code: `resolveGitCommonDir` (`src/lib/git-worktrees.ts`) returns a
   symlinked path from the main checkout and a realpath from a linked worktree, which makes `keryx doctor`
   report a false-stale worktree when the main checkout's path contains a symlink.
2. **`ps -eo pid,pgid,cmd`** is invalid on macOS (`cmd` keyword) — `src/harness/tool/builtin/shell-exec-tool.test.ts` F5c.
3. **`Bun.TOML.parse` rejects control characters on Bun 1.3.14** (the `engines` floor; CI uses latest) —
   `src/agents/compile.format-safety.test.ts` control-char / codex.
4. **`planUnattendedSandbox` reads the host filesystem** (`isDir("/run")`, `/var/run` realpath) although the
   test injects a Linux platform — `src/harness/process/sandbox/unattended.test.ts` T14.
5. **A copied `/bin/sh` is SIGKILLed on macOS** (signed system binary) — `src/commands/schedule-security.test.ts`
   "pinned wrapper runs"; its sibling "changed wrapper is refused" tests pass vacuously for the same reason.

## Expected Outcome

The full suite passes on a macOS developer checkout as it does in CI, and the test harness stops tests from
depending on whether the temp directory is a symlink.

## Outcome criteria

- On this machine, the 15 named tests pass when their files are run one at a time.

## Out of Scope

- Adding a macOS full-suite CI leg (noted as a follow-up; it costs CI minutes and is the user's call).
- Raising the `engines.bun` floor.
