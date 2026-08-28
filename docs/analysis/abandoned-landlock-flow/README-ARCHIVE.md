# Archived flow package — Linux containment step 3 (Landlock launch)

This is a **verbatim copy** of a flow package that was found untracked inside an
abandoned agent worktree (`.claude/worktrees/agent-a112bffce9abf2573`) on
2026-08-28, three weeks after it was written. It existed in exactly one place on
one disk and was one `rm -rf` away from being gone.

It is archived **here**, under `docs/analysis/`, and deliberately **not** under
`.metaproject/flows/`.

## Why not in `.metaproject/flows/`

Its `flow.json` claims **id 148**, and id 148 on `main` already belongs to a
different, unrelated flow (`148-2026-08-11-shared-agent-context-phase-2-fwk-read-pa`).
Dropping this package in as it stands would create a duplicate id — the exact
condition `keryx flow renumber` exists to repair. Task Manager is the only writer
of flow state, and hand-placing a package with a colliding id is not a way to
resume work, it is a way to corrupt the ledger.

**To resume this work**, do not copy this directory into `.metaproject/flows/`.
Run `keryx flow init` to get a fresh id, then transfer the criteria below through
`keryx flow ac update`.

## What it specifies

Landlock as a second Linux containment layer, alongside the bubblewrap launcher
that `main` already has. This matters because bubblewrap must be installed:
`keryx sandbox status` reports "requires bubblewrap (bwrap); launcher not
installed" on a host without it. Landlock is in the kernel and requires nothing
installed.

Eleven frozen acceptance criteria, including the syscall order
(`landlock_create_ruleset` → `landlock_add_rule` → `prctl(PR_SET_NO_NEW_PRIVS)`
→ `landlock_restrict_self`), fail-closed on exit 125, a requirement that the FFI
mechanism never leak into the pure modules, and an explicit "macOS is untouched".

Flow status when abandoned: `initializing`. It never started.

## Its other half

The implementation this package specifies is the `landlock.ts` on this branch's
tip — also recovered on 2026-08-28, also from an abandoned worktree, also never
committed. See that commit's message for what it contains and what is unverified
about it. AC6 here ("grants read to the workspace, the session temp directory,
and the system roots; it does **not** grant `$HOME`") is what that file
implements.
