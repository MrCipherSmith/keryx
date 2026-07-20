# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A pure `SandboxProfile` model maps from `PolicyProfile` with a v1 default of workspace-write + network-off; deterministic and unit-tested.
- AC2: macOS Seatbelt and Linux bwrap builders produce deterministic, unit-tested profiles/argv that deny writes outside workspace roots, deny secret reads, and deny network when off.
- AC3: `SandboxedProcessAdapter` wraps the executor `ProcessAdapter` port and fails closed on a missing launcher / unsupported platform; `runContainedProcess` and guard unchanged.
- AC4: `keryx harness exec` runs OS-contained by default with realpath'd roots and `KERYX_DANGEROUSLY_DISABLE_SANDBOX` / `KERYX_SANDBOX_ALLOW_UNSANDBOXED` escape hatches.
- AC5: A flag-gated live smoke proves on the real OS that a write outside the workspace is denied while a write inside succeeds; full suite green, `tsc` clean.
