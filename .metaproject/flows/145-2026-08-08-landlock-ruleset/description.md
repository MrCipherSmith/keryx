# Description

## Problem

`docs/requirements/keryx-linux-containment` step 3 needs a pure translation from
`SandboxProfile` to a Landlock ruleset. The translation is the package's real
risk (PRD §7, row 1): Landlock restricts the calling process against the *real*
filesystem, while bubblewrap presents a re-rooted view. The two boundaries are
not expressible in the same terms, and an approximation would be reported as a
boundary that does not exist — the exact defect ADR-0010 was written to remove.

## Expected outcome

- `src/harness/process/sandbox/landlock.ts`: pure, deterministic, offline
  `SandboxProfile` + Landlock ABI → ruleset *description* (data only, no
  syscall, no FFI, no spawn, no filesystem). Mirrors `bwrap.ts` in spirit.
- `src/harness/process/sandbox/landlock-abi.ts`: an injectable interface for
  reading the kernel's Landlock ABI version, plus a per-process cache. No
  mechanism — the mechanism (`bun:ffi` or a compiled helper) is still the
  subject of step 2's spike and must be substitutable.
- Unit tests covering AC1 and AC2 of the specification.
- Public surface re-exported from `sandbox/index.ts`.

## Out of scope (owned by other flows / other agents)

- `detect.ts` — layer selection.
- `capability-matrix.ts`, `src/commands/sandbox.ts`, `scripts/install.sh`.
- `wrap.ts` — the Landlock branch needs the applied-rules mechanism.
- `landlock-exec.ts` / anything that *applies* rules to a process. Gated on the
  step 2 spike.
- `seatbelt.ts`, `profile.ts`, `bwrap.ts`, `adapter.ts`, proxy/TLS.
