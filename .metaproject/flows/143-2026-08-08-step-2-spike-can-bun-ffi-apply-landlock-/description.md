# Description

## Problem

`docs/requirements/keryx-linux-containment/specification.md` §4.2 rests on one
unproven assumption: that a Bun process can issue the Landlock syscalls through
`bun:ffi`, and that the resulting restriction survives into an exec'd child and
its descendants. Nothing else in the package depends on the answer, and Step 3
(the Landlock launcher) cannot be planned until it is known.

If the assumption fails, Step 3 gains a compiled per-architecture helper and the
distribution cost ADR-0005 exists to limit.

## Expected outcome

A decision, not a feature:

- a minimal self-contained proof-of-concept under
  `docs/requirements/keryx-linux-containment/spike/`;
- a committed written finding stating plainly whether `bun:ffi` carries it, the
  measured per-command overhead, what surprised us, and what Step 3's
  implementer must know;
- if the answer is no, the compiled-helper alternative costed honestly.

## Out of scope

- Any change under `src/harness/process/sandbox/`. The spike is deliberately not
  wired into the launcher; a half-built launcher is worse than none.
- Steps 1, 3, 4 and 5 of the implementation plan.
- Making Landlock serve `network: "off"` — spec §4.3 forbids it until a seccomp
  filter exists, and this spike must not contradict that.
