# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Numbering follows `docs/requirements/keryx-linux-containment/specification.md`
§10, so AC4–AC8 here are the same criteria as there. AC12–AC14 are additional
criteria this flow adds for requirements the package states (R7, R8, N2/N3) but
does not attach a numbered criterion to.

## Criteria

- AC4: The probe reports failure with the launcher's verbatim stderr in `detail`, and reports success with no `detail`; proven by a unit test over a fake spawn.
- AC5: The probe runs at most once per process — a second call to the cached entry point spawns nothing; proven by a unit test counting fake-spawn invocations.
- AC6: `keryx sandbox status` reports no capability as available unless a probe confirmed it on this host, and a Linux `unavailable` row names the kernel release and the kernel facility as the reason rather than the platform string "linux"; proven by unit tests over the report/render functions with platform, launcher presence and probe outcome injected.
- AC7: The doc-sync test covers all three `CapabilityStatus` values, so `docs/verification/linux-sandbox-verification.md` and `capability-matrix.ts` cannot disagree about the third state; the test is falsifiable (a deliberate mismatch fails it).
- AC8: Fail-closed is unchanged — no probe outcome and no capability state causes an unsandboxed spawn, and `KERYX_DANGEROUSLY_DISABLE_SANDBOX` / `KERYX_SANDBOX_ALLOW_UNSANDBOXED` behave exactly as before; proven by the pre-existing fail-closed tests still passing without modification.
- AC12: `scripts/install.sh` derives its containment report from the installed keryx's probe rather than `command -v bwrap`; an installer run against a bwrap shim that reproduces `setting up uid map: Permission denied` prints that failure and does not claim containment, and an installer run against a shim that succeeds does claim it.
- AC13: No rendering path and no output string introduced by this flow names `kernel.apparmor_restrict_unprivileged_userns`; where a bubblewrap probe fails the remediation names the AppArmor profile for /usr/bin/bwrap instead. Enforced by a test, not by inspection. The name **may** appear in tests that assert its absence and in comments that explain why ADR-0010 rejected it — a ban whose reason is deleted is an invitation to undo it. (Amended 2026-08-08, owner-authorised. The original wording also forbade comments and test fixtures, which made it unsatisfiable: enforcement "by a test" requires a test containing the literal string. It also over-reached specification R8, which constrains what a *user is shown*, not source comments. Intent unchanged: the sysctl is never offered to a user as a remedy.)
- AC14: No new npm dependency, and the pure sandbox modules stay pure — `wrap.ts`, `bwrap.ts`, `seatbelt.ts`, `profile.ts` and `adapter.ts` are unmodified by this flow, and `probe.ts` performs no spawn when its spawn seam is injected.
