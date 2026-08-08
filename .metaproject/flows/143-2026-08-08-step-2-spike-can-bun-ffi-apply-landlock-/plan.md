# Plan

## Approach

A spike is a decision with evidence attached. The deliverable is a written
finding; the code exists only to make the finding checkable by someone who does
not trust it.

1. Reach syscall 444 from `bun:ffi` at all. This is the cheap kill-switch: if
   `dlopen`/`syscall` cannot carry it, everything after is moot.
2. Build the minimum binding — `landlock-ffi.ts` — with the struct layouts and
   ABI clamping the kernel actually requires.
3. Build the §4.2 child shape — `landlock-exec.ts` — that restricts itself and
   then runs the real command.
4. Prove enforcement and inheritance with an executable script, `verify.sh`,
   where every denial has a matching positive control.
5. Measure overhead with ADR-0010's method, all mechanisms in one run.
6. Cost the compiled-helper alternative by building it, so the trade is a
   number rather than an assertion.
7. Write the finding.

## Trade-offs

**Evidence over ergonomics.** `verify.sh` is a shell script with paired
assertions rather than a `bun test` file, because the thing being proved is
about process trees and kernel enforcement, and a reviewer must be able to read
exactly what was run without trusting a test harness.

**Positive controls are mandatory.** A denial on its own proves nothing — the
command could have failed for any reason. Every "denied" assertion is paired
with an equivalent "allowed" one that differs only in the ruleset. This is the
same discipline ADR-0010 demands of `probe.ts`, and the spike hit the failure
first-hand: the initial TCP test passed on `ECONNREFUSED`, which is what an
absent listener returns whether or not Landlock is involved.

**Build the alternative rather than estimate it.** `alternative-helper.c` exists
only so the compiled-helper option carries a measured cost. It is explicitly
labelled as not the proposal.

**Not wired into `src/`.** The spike answers a question; a launcher is Step 3's
job under Step 3's acceptance criteria. Shipping a half-built launcher inside a
spike would create exactly the unverified security boundary this package exists
to remove. The spike carries its own `tsconfig.json` so it can be typechecked
without entering the repo's `src/**` project.

## Risks

- **Single-kernel evidence.** Only ABI 4 on 6.8.0-136 was exercised. ABI 1
  behaviour is inferred from headers. Recorded in the finding as risk inherited
  by Step 3, not silently omitted.
- **A positive result that is too positive.** The mechanism working is not the
  same as the delivery shape being a good idea; the overhead measurement is what
  keeps the finding honest, and it is the part most likely to be skimmed.
