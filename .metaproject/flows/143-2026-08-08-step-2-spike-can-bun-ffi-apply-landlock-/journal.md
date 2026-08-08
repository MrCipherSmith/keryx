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
- 2026-08-08T13:19:35.507Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-08T13:20:29.369Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/258
- 2026-08-08T13:20:37.252Z - ac-confirmed: AC1: verify.sh section 1: landlock_create_ruleset(NULL,0,VERSION) via bun:ffi returns ABI 4, matching ADR-0010's independently measured value.
- 2026-08-08T13:20:37.344Z - ac-confirmed: AC2: verify.sh section 2: create_ruleset + add_rule + prctl(PR_SET_NO_NEW_PRIVS) + restrict_self all succeed from Bun; section 5 reads NoNewPrivs=1 back from the contained child with an uncontained control showing 0.
- 2026-08-08T13:20:37.436Z - ac-confirmed: AC3: verify.sh section 3: read+write inside succeed, read+write outside denied EACCES, outside contents proven not to leak. Both dirs are mktemp -d siblings under /tmp with identical owner and mode, so DAC cannot explain the difference.
- 2026-08-08T13:20:45.956Z - ac-confirmed: AC4: verify.sh section 4: grandchild AND great-grandchild writes outside are denied EACCES, each paired with a same-depth positive control proving the nesting runs at all. The great-grandchild control was added after review found the assertion passed on file-absence alone.
- 2026-08-08T13:20:46.048Z - ac-confirmed: AC5: bench.sh, ADR-0010's method (wall clock over N runs of /bin/echo), N=30, all mechanisms in one run: none 2.1ms, bwrap 10.9ms, landlock bun:ffi 40.2ms, compiled C helper 2.3ms. Per-iteration timing with median and min-max; a row whose command did not succeed exits the script non-zero.
- 2026-08-08T13:20:46.138Z - ac-confirmed: AC6: verify.sh section 7: three-case TCP bind test with negative control (unhandled=BOUND, handled+no-rule=DENIED:EACCES, handled+allow-rule=BOUND). Reported as TCP-only throughout; spec 4.3 explicitly reaffirmed, flag named --handle-tcp not --net.
- 2026-08-08T13:20:55.810Z - ac-confirmed: AC7: docs/requirements/keryx-linux-containment/spike/README.md: verdict stated plainly (yes), measured overhead with caveats, five 'what surprised us' items including the four false greens the spike itself produced, explicit 'what Step 3 must know', and the compiled-helper alternative costed with a real measurement (2.3ms, 16472 bytes) plus its distribution cost.
- 2026-08-08T13:20:55.899Z - ac-confirmed: AC8: All files under docs/requirements/keryx-linux-containment/spike/; nothing under src/ or scripts/ changed on this branch. bun run typecheck clean; spike carries its own tsconfig and typechecks clean separately; check:doc-links 702 links 0 broken. bun test: 3234 pass, 2 pre-existing failures in scripts/install-global.test.ts diagnosed as unrelated (pathWithoutBwrap strips /usr/bin, hiding bash) and recorded in the flow journal.
- 2026-08-08T13:21:50.355Z - completing
- 2026-08-08T13:21:52.066Z - completion-failed: health: no report; run `keryx health run` first
- 2026-08-08T13:22:07.592Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/258
- 2026-08-08T13:22:07.681Z - completing
- 2026-08-08T13:22:09.395Z - done: all gates passed
