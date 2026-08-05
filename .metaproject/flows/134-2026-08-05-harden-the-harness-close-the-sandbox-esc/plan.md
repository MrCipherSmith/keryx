# Implementation Plan

Status: approved (user confirmed the ordering 2026-08-05)

Branch: `fix/harness-hardening`

## Approach

Five independent changes, ordered by risk rather than by cost. The sandbox item
is first because it is the only one with a live security consequence; the
scanner is second because a jammed-open safety catch is worse than a missing
one; the rest are cheap and make finished code reachable.

Each item lands as its own commit with its own tests, so any single one can be
reverted without unpicking the others. One branch, one PR.

Rejected alternative for item 1: keep the escape hatch as-is and print a warning
to stderr. Rejected because nobody reads stderr in an agent run, and the
limitations table would still be false.

Rejected alternative for item 5: build real replay now. Rejected as out of scope
— see description.md. The cheap half (making `validate-log` reachable) is in.

## Steps

### S1 — Sandbox: split the two failure modes (AC1, AC2)

`failClosed = profile.required || (failIfUnavailable ?? true)` at
`adapter.ts:57`. The escape hatch reaches the restricted case only because
`required` is never set. Set `required: true` whenever the resolved profile's
network posture is `restricted`, so the env variable cannot reach it, and leave
the missing-launcher path alone.

Touch: `src/harness/process/sandbox/profile.ts` (and `network-run.ts` if it
builds a profile of its own). Test both halves — refuse the restricted case,
still allow the missing-launcher case — so the fix cannot be satisfied by
blanket refusal.

### S2 — Wire the mutation scanner (AC3, AC4)

`scanAvailable: true` at `harness.ts:787` pins a fail-closed signal open. Derive
it from whether the security scanner is actually reachable, and call the real
seam (`guardOutput`/`redactRaw` from `src/security/guard.ts`) on the harness
mutation path the way memory/wiki/ctx already do.

Check first whether `redactForPersistence` in `run.ts:401` is the same seam —
if the agent path already scans and only `harness exec` does not, the change is
narrower than it looks.

### S3 — Feed the completion gate (AC5)

`run.ts:428` hardcodes `requiredEvidenceRefs: []` and `requiredGates: []`.
Thread them through `runOffline`'s input so a caller with frozen acceptance
criteria can state its requirements. Keep the default empty — an ad-hoc run
with no flow behind it must not start failing.

### S4 — Surface branching (AC6)

`forkBranch` is complete and tested. Add the CLI verb and set `parentSessionId`
on the forked session so ancestry survives. Merge stays out of scope.

### S5 — Surface replay-fixture validation (AC7)

Add the entry point that builds a fixture from a recorded run and validates it,
reporting the typed mismatch on tamper. Do not rename the module or widen what
it claims — it validates a log, and the CLI help should say exactly that.

### S6 — Gate and PR (AC8, AC9)

`bun run check` green. Re-read the README against every claim these changes make
true again, and name in the PR anything restored.

## Risks

- **S1 could over-refuse.** If `required: true` leaks onto profiles that are not
  actually restricted, ordinary runs start failing on hosts without a launcher.
  AC2 exists to catch exactly this.
- **S2 could double-scan or double-redact.** `run.ts:401` already redacts tool
  results for persistence; adding a second pass on the same bytes would be waste
  at best and a behaviour change at worst. Establish which seam covers which
  path before writing code.
- **S3 could break existing callers.** Anything already calling `runOffline`
  must keep working with no requirements supplied.
- **S5 invites scope creep** toward real replay. It is explicitly out of scope;
  if the seam turns out to need re-execution to be useful at all, stop and say
  so rather than building it here.
