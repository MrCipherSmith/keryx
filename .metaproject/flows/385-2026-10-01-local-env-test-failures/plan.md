# Implementation Plan

Status: ready

## Approach

Fix the causes, not the 15 assertions: one harness change (realpath `TMPDIR` in the bun preload) clears nine
tests and every future `mkdtemp(tmpdir())` test; the other four causes are fixed where they live. Product code
changes only where the diagnosis found a real defect or a missing seam: `resolveGitCommonDir` canonicalisation
(doctor false-stale) and the sandbox planner's host-filesystem reads.

## Steps

One task, T5, one implementer, in this order (the items are small and the first two touch neighbouring tests):

1. Preload `TMPDIR` realpath + guard test (AC1).
2. `resolveGitCommonDir` realpath + test; git-worktrees/doctor tests compare canonical paths (AC2).
3. `ps -eo pid,pgid,command` in F5c (AC3).
4. Bun TOML control-char probe-skip (AC4).
5. Sandbox `detect` seam for `isDir`/`realpath` + T14 with a fake FS (AC5).
6. Schedule-security interpreter (AC6).
7. Verification: run the affected files one at a time on this machine (the only local runs — they are the
   point of the flow), then a draft PR for CI (AC7). T4 is the review round.

## Risks

- The preload realpath changes `os.tmpdir()` for every test: a test that asserted the symlinked form would flip.
  The verification step runs every file the diagnosis named; CI covers the rest on Linux, where tmpdir is not a
  symlink and nothing changes.
