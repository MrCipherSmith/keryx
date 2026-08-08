# Description

## Problem

`keryx sandbox status` and `scripts/install.sh` decide whether OS containment
works from `command -v bwrap` — the presence of a binary on `PATH`. On Ubuntu
23.10 and newer, `kernel.apparmor_restrict_unprivileged_userns=1` withdraws the
unprivileged user namespaces bubblewrap builds its boundary from, so bubblewrap
installs cleanly and every contained run then dies with

```
bwrap: setting up uid map: Permission denied
```

while both surfaces print

```
Filesystem containment and network-off are available.
```

That is a false statement in a shipped product: a user is told they have a
boundary they do not have. It is measured, not predicted — see
`docs/decisions/keryx-harness/ADR-0010-linux-containment-without-privilege.md`.

## Expected outcome

Every containment claim keryx makes about *this host* is the result of a trial
contained run, on this host, at this moment.

- A new `sandbox/probe.ts` runs one trivial contained command per layer,
  injectable, at most once per process, cached.
- `CapabilityStatus` gains a third state, `unavailable` — implemented, but not
  functional here — carrying a `reason` and, where one exists, a `remediation`.
- `keryx sandbox status` renders the probe result and never reports a capability
  as available unless a probe confirmed it.
- `scripts/install.sh` prints the same report, from the same source, instead of
  a `PATH` lookup.
- A Linux `unavailable` reason names the **kernel** and the kernel facility that
  was withdrawn, not the platform string `"linux"`.
- The failure quotes the launcher's own stderr verbatim.
- The doc-sync test is extended to the third state so the verification runbook
  cannot drift from the matrix.

Delivers requirements **R4, R5, R6, R7, R8** and acceptance criteria
**AC4, AC5, AC6, AC7** of `docs/requirements/keryx-linux-containment/`.
**AC8** (fail-closed) must stay green, unchanged.

## Out of scope

- **Landlock (R1, R2, R3 / AC1, AC2, AC3, AC10).** That is step 3 of the
  implementation plan and depends on a separate `bun:ffi` spike (step 2). No
  file named `landlock*.ts` is created here.
- `wrap.ts`, `bwrap.ts`, `seatbelt.ts`, `profile.ts` — the launchers are not
  touched. The defect is a *claim*, not a launcher.
- `adapter.ts` fail-closed semantics. `KERYX_DANGEROUSLY_DISABLE_SANDBOX` and
  `KERYX_SANDBOX_ALLOW_UNSANDBOXED` keep their exact current behaviour.
- Domain allowlist and credential masking on Linux — still `not-implemented`,
  and this flow does not move them.
- The machine-wide `sysctl kernel.apparmor_restrict_unprivileged_userns=0`
  remediation. It was deliberately removed from the docs by ADR-0010 and must
  not reappear in code, output, tests or comments.
