# Flow Journal

- 2026-08-08T12:07:50.883Z - flow created
- 2026-08-08T12:21:57.646Z - task-added: T5: Measure per-command overhead with ADR-0010 method, all mechanisms in one run
- 2026-08-08T12:21:57.869Z - task-added: T6: Cost the compiled-helper alternative by building and measuring it
- 2026-08-08T12:21:58.099Z - task-added: T7: Write the committed finding and link it from the package README and Step 2
- 2026-08-08T12:22:35.598Z - frozen: 8 criteria; checksum recorded
- 2026-08-08T12:22:35.817Z - started
- 2026-08-08T12:26:10.496Z - task-done: T1: Collect remaining context
- 2026-08-08T12:26:10.585Z - task-done: T2: Implement per plan
- 2026-08-08T12:26:10.677Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-08T12:26:10.766Z - task-done: T5: Measure per-command overhead with ADR-0010 method, all mechanisms in one run
- 2026-08-08T12:26:10.858Z - task-done: T6: Cost the compiled-helper alternative by building and measuring it
- 2026-08-08T12:26:10.946Z - task-done: T7: Write the committed finding and link it from the package README and Step 2

## Notes

### The spike reproduced the bug it was verifying

The first version of the TCP test (section 7) asserted a denial by connecting to
a dead port and checking that it failed. It "passed" — on `ECONNREFUSED`, which
is what an absent listener returns whether or not Landlock is involved. It
proved nothing while reporting success: the same false green ADR-0010 exists to
correct, reproduced inside the spike verifying it.

Replaced with a three-case bind test in which only the middle case changes:
net axis unhandled → `BOUND`; handled with no allow-rule → `DENIED:EACCES`;
handled with an allow-rule → `BOUND`. Recorded in the finding because it
generalises to Step 1: **a probe without a negative control is not evidence.**

### Pre-existing test failure, diagnosed but deliberately not fixed here

`bun test` on this branch: 3234 pass, 14 skip, **2 fail**. Both failures are in
`scripts/install-global.test.ts` (AC1 and its falsifiability twin) with
`Executable not found in $PATH: "bash"`.

Cause: `pathWithoutBwrap()` removes every `PATH` entry that resolves `bwrap`. On
this host `bwrap` is `/usr/bin/bwrap` and `bash` is `/usr/bin/bash`, so hiding
`bwrap` also hides `bash`, and `Bun.spawn(["bash", INSTALL_SH, ...])` fails
before the installer ever runs.

The test's own comment states the assertion should hold "regardless of whether
bubblewrap actually happens to be installed on the machine running the test
suite" — that intent is what breaks once `bwrap` lives in a system bindir. This
host acquired `bwrap` on 2026-08-08 to unblock benchmark case C4, which is why
it surfaces now and did not before.

Not this flow's code (that file belongs to flow 142 / Step 1 territory) and this
branch touches no file under `src/` or `scripts/`. The likely fix is to shadow
`bwrap` with a shim directory prepended to `PATH` rather than to subtract
directories from `PATH`. Handed to the owner of Step 1.
