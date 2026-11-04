# Review stop gate never hangs on a large tree; mutation pass copies no nested checkouts and sweeps stale scratch

Status: formalized
Source: live incident, 2026-11-04 — keryx shell session `f732e03c…89ac6706` (PR #1125 review) hung in "thinking" after every final reply, three times; Ctrl+C printed `active operation is still stopping`.

## Problem

After every text-only reply in a session that ran a `keryx review` command, the shell's managed-review stop gate
(`holdReviewGate` → `findReviewGateState`, `src/review/completion-gate.ts`) computes a content signature of
`<root>/.metaproject/data/review` and of the package directory. `dirSignature` walks the tree recursively and
sequentially and SHA-256s every file. Two things made that walk unbounded on the operator's checkout:

1. `keryx review mutate` puts its scratch copy under `<root>/.metaproject/data/review/mutate-scratch/` by default, and
   `copyTree` (`src/review/mutate.ts`) copies everything except `.git` and `node_modules` — including the nested git
   worktrees under `.claude/worktrees/` and `.worktrees/` (≈252k of ≈265k files on this checkout). Two passes killed on
   2026-10-29 left their copies behind: 287 188 files, 5.8 GB. Nothing ever removes such leftovers.
2. The gate walked all of it on every stop. The hash cache holds 4096 entries, so with 287k files nothing was reused and
   every stop re-read everything. The walk takes no AbortSignal, so Ctrl+C could not stop it and the shell finalizer
   timed out waiting.

Verified on the live process (PID 46897): `sample` showed the Bun pool threads in `openat`, `lsof` caught
`…/mutate-scratch/keryx-mutate-AS0xE6/tree/.claude/worktrees/pr803/…` open; deleting `mutate-scratch` unblocked the
session within seconds (nudge at 07:10:54Z).

## Expected Outcome

- The stop gate's work per evaluation is bounded regardless of what lies under `.metaproject/data/review` or a package,
  it never reads the mutation scratch directory, and an aborted turn stops it immediately.
- A mutation pass copies no nested git checkout and removes scratch left behind by earlier, dead passes.

## Outcome criteria

- A session in a managed review ends its turn promptly after a text-only reply on a checkout that carries nested
  worktrees and an earlier pass's leftover scratch; Ctrl+C during the gate ends the turn without the finalizer's
  `still stopping` message.

## Out of Scope

- The gate naming another session's package after `keryx shell -c` (the resumed history is the pruned context, so the
  session tracker no longer sees the commands that named its package). Observed in the same incident; separate fix.
- Changing the default scratch location from `repo` to `tmp`.
- Skipping `.metaproject/data` in the mutation copy: tests may read it, and it is ≈13k files here.
