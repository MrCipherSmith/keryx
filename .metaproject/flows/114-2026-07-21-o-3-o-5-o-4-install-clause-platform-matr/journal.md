# Flow Journal

- 2026-07-21T21:42:58.491Z - flow created
- 2026-07-21T21:44:14.030Z - frozen: 12 criteria; checksum recorded
- 2026-07-21T21:44:14.099Z - started
- 2026-07-21T21:44:14.176Z - task-done: T1: Collect remaining context

## T2 — O-3 / O-5 / O-4 install clause (commit 7487234)

### Runner labels verified (2026-07-22)

Verified against docs.github.com "GitHub-hosted runners" and
actions/runner-images before wiring the matrix — the description's table was
trusted only where it still holds:

| N1 target | Label used | Status |
|---|---|---|
| linux-x64 | `ubuntu-latest` (→ ubuntu-24.04) | GA |
| linux-arm64 | `ubuntu-24.04-arm` | GA, free+unlimited on public repos |
| darwin-arm64 | `macos-latest` (→ macos-15) | GA |
| darwin-x64 | `macos-15-intel` | GA — **replaces the description's `macos-13`** |

`macos-13` from the description's proposed table is RETIRED (deprecation began
2025-09-22, fully unsupported 2025-12-04 — actions/runner-images#13046).
`macos-15-intel` is the current and LAST hosted x86_64 macOS image, available
through Aug 2027 (runner-images#13027/#13045). No target was dropped; the Intel
leg simply moved to the live label. All four are reachable, so O-3 has no
"unavailable label" caveat to record in the spec.

### AC2 positive native check

`scripts/verify-opentui-native.ts` — chosen over "no error" because the optional
dep is fallback-guarded: a missing binary degrades to readline silently, so
absence-of-error is exactly what an unsupported platform looks like. Positive
signals instead: (1) `@opentui/core-<platform>-<arch>` resolves to a real
>512KB shared library on disk; (2) `resolveRenderLib()` returns an `FFIRenderLib`
(the library dlopen'd); (3) a byte written by JS via `OptimizedBuffer.drawText`
comes back out of native memory (`getRealCharBytes`) — no stub/fallback can
forge that round trip. Also fails if `zig` is on PATH (N1: "no toolchain").
Local run (darwin-arm64): PROVEN, libopentui.dylib 3.60 MB, round-trip
"KERYX-NATIVE-ROUND-TRIP" recovered. Falsified by hiding
`@opentui/core-darwin-arm64`: exit 1, "@opentui/core-darwin-arm64 did not
resolve … the platform gap itself".

### AC3 zero-skip guard

`scripts/opentui-tests-no-skips.ts` reads bun's JUnit `<testsuites>` counts and
fails on skipped>0 OR tests==0 OR a missing report. Made it bite: the three
`tui-shell.test.ts` renderer tests used to `return` early when the dep was
absent (bun reports that as PASS) — now `test.skipIf(OTUI===undefined)`, so an
absent binary surfaces as a skip the guard converts to a hard failure.
Local: `src/tui` → 94 tests, 0 skipped, guard exit 0. Falsified against the
sandbox smoke suite (2 skipped under no flag) → exit 1 with the loud banner;
and against a non-existent path (0 matches) → exit 1.

### AC5 install-test falsification (exact output)

Broke install.sh's wrapper heredoc (replaced the `cat > "$BIN_DIR/keryx" <<EOF
… EOF` block with an echo), ran `--global` into a temp prefix from a local bare
clone. Recorded output:

```
Cloning into '…/prefix/keryx'... done.
flow114: wrapper step deliberately broken
chmod: …/bin/keryx: No such file or directory
installer exit: 1
--- wrapper present? ---            (bin dir empty)
--- try to run the (missing) wrapper ---
zsh: no such file or directory: …/bin/keryx
wrapper exit: 127
```

So the wrapper is absent and running it fails (spawn ENOENT / exit 127) — the
green AC4 assertions (`stat` exec bit + `keryx --version` → semver) are
load-bearing. Isolation: HOME/KERYX_HOME/KERYX_BIN_DIR redirected to the temp
prefix, KERYX_REPO_URL a local bare clone (no network to the published repo),
and the test asserts real `~/.keryx` / `~/.local/bin` are untouched.

### AC6/AC7 cold-start numbers

Machine: Apple M1 Pro x10, 16 GiB, macOS darwin-arm64, bun 1.3.12, commit
6c67985. 11 measured runs + 2 warm-ups discarded, medians:

| scenario | median | min | max |
|---|---|---|---|
| runtime-floor (empty module) | 12.0 ms | 11.5 | 12.5 |
| readline (`keryx shell --no-tui`, stdin EOF) | 61.2 ms | 59.8 | 62.9 |
| readline + TUI module graph + native dlopen | 170.7 ms | 169.4 | 173.1 |

The TUI load adds ~109.5 ms over readline (2.79x). AC7: this is NOT a rendered
first frame — `createCliRenderer` needs a controlling terminal neither the
script nor CI has, so the renderer is never constructed. It is the dominant
term of TUI start-up (process start + module graph + native import), which is
what R5 asked to compare, stated as such rather than implied as time-to-frame.

### AC8 / scope

No `src/` production behaviour changed — the only `src/` edit is
`tui-shell.test.ts` skip mechanics (a test file). AC12 ongoing-cost note lives
in the ci.yml job comment. AC11 (spec §10 close-out) left for the orchestrator.
Unverifiable locally: the matrix legs themselves — cannot run GitHub Actions
here; the YAML parses and the two evidence scripts pass on darwin-arm64, but the
three non-darwin-arm64 legs are unproven until the PR runs (AC10, orchestrator).
- 2026-07-21T22:02:11.385Z - task-done: T2: Implement per plan
- 2026-07-21T22:04:46.315Z - task-added: T5: Fix install-global smoke: green locally, red in CI (exitCode != 0) — surface stderr, find the CI-only cause, reprove on the PR
- 2026-07-21T22:05:50.288Z - task-done: T3: Add/adjust tests and make them pass

## Notes (orchestrator)

### The matrix paid for itself on its first run

The `opentui-native-matrix` legs all passed immediately — but the main `check`
job **failed**, on the very install smoke this flow added. Green locally, red in
CI: exactly the class of defect a platform matrix exists to surface, caught on
the first PR run rather than by a user.

Root cause, proved rather than guessed: `actions/checkout@v4` checks out a
**shallow** clone, and `git push` from a shallow clone is rejected with exit 128.
The test fixture pushed `HEAD` into a local bare origin **without checking that
push's exit code**, so on CI the push failed silently, the origin stayed empty,
and `install.sh`'s `git clone --depth 1 --branch …` then died with `fatal: Remote
branch … not found in upstream origin`. Two log facts pinned it before any code
changed: exit `128` (git's fatal code) and a 204 ms failure — far too fast to
have reached `bun install`, so it died at the clone.

**Fixed in the test, not in `install.sh`** (`git diff -- scripts/install.sh` is
empty, so AC8 holds). A real user clones full history, where the problem cannot
arise. The fixture now builds its origin from a `git archive` snapshot of HEAD's
tree, making shallow-vs-full irrelevant, and every fixture step goes through a
`runOk()` that throws with captured stderr instead of failing silently.

### The finding that mattered more than the fix

Before the repair, **AC5 was passing vacuously in CI**: it "passed" in 52 ms
because the clone never happened, so the wrapper was absent for the wrong reason.
The falsifiability guarantee this project keeps insisting on was itself broken —
in CI only, invisibly. After the fix AC4 takes 1300 ms and AC5 214 ms; both now
do real work. Worth carrying forward: *a falsification check can pass vacuously
in an environment you never ran it in.*

### Runner label correction

The flow description proposed `macos-13` for darwin-x64. Verification against
GitHub's current offering found it **retired on 2025-12-04**; the current and
last hosted x86_64 macOS image is `macos-15-intel`. No target was dropped, so
O-3 needed no "unavailable label" caveat — but the table would have been wrong
had it been trusted, which is why the AC required verifying rather than assuming.

### Verification

CI run `29873029000`: all six jobs pass, including the four matrix legs
(linux-x64, linux-arm64, darwin-arm64, darwin-x64) and the previously failing
`check`. Locally: `bun test` 2084 pass / 11 skip / 0 fail, `bun test src/tui`
0 skips, `bun run typecheck` clean, `keryx health run` gate **PASS**.

### What remains — one gap, now named

Flows 112-114 closed O-1..O-5. The single limitation left is that **no automated
check can evidence a rendered TUI frame**, because `createCliRenderer` needs a
controlling terminal that hosted runners lack. That one pty gap bounds the last
clause of O-3 ("the TUI launches there"), of O-4 ("...launches the TUI"), and the
rendered-frame half of O-5. Rather than leave it dissolved across three closed
items where it would be easy to lose, it is recorded as **O-6** in specification
§10, scoped as its own future flow — a pty harness is real test infrastructure
with its own flakiness surface, not a footnote.

### Cost accepted

Four hosted runners now run on every future PR. Stated in the `ci.yml` job
comment so whoever next edits CI sees the trade-off rather than discovering it in
a queue-time surprise.
- 2026-07-21T22:17:46.384Z - task-done: T4: Self-review and prepare draft PR
- 2026-07-21T22:17:46.451Z - task-done: T5: Fix install-global smoke: green locally, red in CI (exitCode != 0) — surface stderr, find the CI-only cause, reprove on the PR
- 2026-07-21T22:17:48.764Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/190
- 2026-07-21T22:17:48.850Z - ac-confirmed: AC1: ci.yml gains opentui-native-matrix over all four N1 targets. Labels verified against GitHub's current offering on 2026-07-22, not assumed - and one assumption was wrong: macos-13 retired 2025-12-04, so darwin-x64 uses macos-15-intel (the current and last hosted x86_64 macOS image). No target dropped, so no unavailable-label caveat was needed. Proven scheduled and green on CI run 29873029000.
- 2026-07-21T22:17:48.917Z - ac-confirmed: AC2: scripts/verify-opentui-native.ts is a POSITIVE check, chosen because the dependency is fallback-guarded so absence-of-error is exactly what an unsupported platform looks like: it resolves the platform dylib (>512KB), confirms resolveRenderLib() dlopens an FFIRenderLib, and round-trips a JS-written byte back out of Zig memory via drawText/getRealCharBytes - unforgeable by a stub or the readline fallback. It also fails if zig is on PATH, evidencing N1's no-Zig clause. Falsified by hiding the native package (exit 1).
- 2026-07-21T22:17:48.979Z - ac-confirmed: AC3: scripts/opentui-tests-no-skips.ts reads bun's JUnit counts and fails with a boxed banner on skipped>0, tests==0, or a missing report. It bit immediately: three tui-shell.test.ts renderer tests used early-return, which bun counts as PASS, and were moved to test.skipIf. Falsified against the sandbox smoke suite (2 skips to exit 1) and a zero-match path.
- 2026-07-21T22:17:49.042Z - ac-confirmed: AC4: scripts/install-global.test.ts drives install.sh --global into a temp prefix via KERYX_HOME/KERYX_BIN_DIR/KERYX_REPO_URL/KERYX_REF against a local bare origin - no network to the published repo - and asserts the wrapper is executable and runs the CLI, while asserting the real ~/.keryx and ~/.local/bin are untouched.
- 2026-07-21T22:17:49.106Z - ac-confirmed: AC5: Falsifiable and re-proven after the CI fix: neutering the wrapper heredoc yields ENOENT on stat of the wrapper and TEST_EXIT=1, after 2946ms - i.e. it got past the install exit-0 assertion having done real clone+install work. Critically, this AC was passing VACUOUSLY in CI before the fix (52ms, the clone never happened); it now does real work at 214ms. Recorded in the journal as the flow's most important finding.
- 2026-07-21T22:17:49.169Z - ac-confirmed: AC6: scripts/measure-cold-start.ts, median of 11 runs on an Apple M1 Pro (16 GiB, darwin-arm64, bun 1.3.12): runtime floor 12.0ms, readline 61.2ms, readline+@opentui/core native import 170.7ms - the TUI adds ~109.5ms (2.79x). Median not a single sample; machine recorded.
- 2026-07-21T22:17:49.232Z - ac-confirmed: AC7: Both the script's output and specification section 10 state plainly that this excludes a rendered first frame, because createCliRenderer needs a controlling terminal that CI lacks. R5 asked for cold start versus the instant readline shell, which is the term measured; the rendered-frame delta is attributed to the pty gap now tracked as O-6.
- 2026-07-21T22:17:49.298Z - ac-confirmed: AC8: No production behaviour changed. git diff on scripts/install.sh is empty - the CI failure was a fragile test fixture (shallow-clone push), not a user-facing installer defect, and that distinction was established by reproduction rather than assumed. The only src/ edit is three tui-shell.test.ts tests moving from early-return to test.skipIf, which AC3 required.
- 2026-07-21T22:17:49.362Z - ac-confirmed: AC9: bun run typecheck clean; bun test 2084 pass / 11 skip / 0 fail (baseline 2081/11/0 plus the new install and script tests); bun test src/tui 94 pass with 0 skips locally.
- 2026-07-21T22:17:49.425Z - ac-confirmed: AC10: CI run 29873029000 on PR #190: all six jobs pass, including all four matrix legs (linux-x64, linux-arm64, darwin-arm64, darwin-x64) and the check job that had failed on the first run. The matrix legs were scheduled and executed, not skipped - the first run's failure and the second run's pass are both observable evidence that the job actually runs.
- 2026-07-21T22:17:49.489Z - ac-confirmed: AC11: specification section 10: O-3 closed for the native layer, O-5 marked MEASURED with the table, and O-4's install clause closed - each keeping the original finding above its resolution. What remains unproven was NOT absorbed into the closed items: the shared rendered-frame gap is promoted to a new open item O-6 with its own scope (a pty harness), so it cannot be lost between three closed entries.
- 2026-07-21T22:17:49.553Z - ac-confirmed: AC12: The ongoing cost - four hosted runners on every future PR - is stated in the opentui-native-matrix job comment in ci.yml, and repeated in specification section 10's O-3 entry.
- 2026-07-21T22:17:49.616Z - completing
- 2026-07-21T22:17:51.857Z - done: all gates passed
