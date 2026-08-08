# Journal

## Baseline (before any change)

- `bun test src/harness/process/sandbox src/commands/sandbox.test.ts` — 158 pass / 5 skip / 0 fail.
- `bun scripts/check-doc-links.ts` — 698 links / 0 broken.
- `bun test scripts/install-global.test.ts` — **3 pass / 2 fail** on this host.
  Pre-existing, and reproduced on `feat/linux-containment-landlock` before any
  edit: `pathWithoutBwrap` dropped every PATH directory containing `bwrap`,
  which on a host with bubblewrap in `/usr/bin` takes `bash`, `git` and `sed`
  with it, so `install.sh` could not be spawned at all
  (`Executable not found in $PATH: "bash"`). It passed on CI only because
  `ubuntu-latest` has no bubblewrap — exactly the host dependency the helper
  existed to remove. Fixed in this flow: the helper now mirrors such a directory
  as symlinks minus `bwrap` instead of discarding it.

## Round 1 — implementation

Commit `c0fc950d`. `probe.ts`, the third capability state, the probe-composed
report, `install.sh` delegating to the installed keryx, the runbook's
three-states section, and the doc-sync extension.

**Live verification on the measured host** (Ubuntu 24.04, kernel
6.8.0-136-generic). This machine has `/etc/apparmor.d/bwrap` installed, so
containment genuinely works here. The failing state was reproduced through the
probe's injectable seam — a `bwrap` shim on `PATH` — and **not** by removing
that profile, which the implementation plan's step 5 warns would false-pass
AC11 on a later flow.

- Working: `Containment probe: OK — a trial contained command ran under bwrap and was contained.`
- Failing: `Containment probe: FAILED`, the verbatim `bwrap: setting up uid map: Permission denied`, and the AppArmor remediation.

## Round 1 review — 5 reviewers, 0 blockers, 7 majors, ~15 minors

Dispatched via the review orchestrator: `review-logic`,
`review-security-code`, `review-architecture` + `review-core-boundaries`,
`review-testing-practices`, `review-clean-code` + `review-style`. All ran
through the `general-purpose` fallback — no native reviewer agent types exist in
this runtime. `review-greptile` was **not** run: the MCP call was denied.

Findings accepted and fixed (commit `596059fe` and follow-up):

| # | Finding | Fix |
|---|---|---|
| 1 | The probe re-implemented `wrap.ts`'s platform dispatch instead of going through `wrapWithSandbox`, so step 3's Landlock branch would have left it trialling bubblewrap on hosts that had moved | Trial now goes through the dispatcher |
| 2 | One clean seatbelt trial marked all four macOS rows "confirmed", including allowlist and masking, which the trial profile never exercises | `coveredByProbe` on the matrix; a fifth finding kind, `unprobed` |
| 3 | Every bwrap failure was diagnosed as a user-namespace denial and given the AppArmor remediation | `ProbeFailureCause`, classified from the launcher's own words; remediation attached to the cause, not the failure |
| 4 | `cacheProbe: boolean` was a test concern in a production type, and left the shipping (cached) branch untested | Injected `probe` runner + `DEFAULT_PROBE_RUNNER` identity test |
| 5 | Two doc-sync tests named "falsifiable" were tautologies (proven by the reviewer's mutation run) | Real inverse: doctor the parsed section, assert the same filter reports the state missing |
| 6 | `buildSandboxReport` was 78 lines over four abstraction levels | `describeCapability` + module-level row factory + one `definedOnly` helper |
| 7 | A comment cited `probe.sysctl.test.ts`, which does not exist (found independently by four reviewers) | Points at the real assertions |

Also fixed: control characters stripped and length capped on quoted launcher
output; the trial runs under the empty environment its profile describes;
`install.sh` surfaces the failure's stderr and indents in-shell instead of
through a `sed` pipeline under `pipefail`; one `BWRAP_INSTALL_HINT` constant
instead of two that had drifted; probe and matrix exported from the module
barrel; `detect.ts`'s "only impure module" header corrected.

New tests: `purity.test.ts` (N3/AC14 enforced rather than reviewed),
installer fail-safe branch, installer project-install delegation shape.

### Falsification checks run by hand

- **Installer fail-safe test**: reverted `install.sh`'s stderr surfacing in a
  scratch commit, re-ran the suite — **7 pass / 1 fail**, the failing test being
  the new one. Load-bearing. Scratch commit dropped.
- Confirmed while doing it that `install-global.test.ts` executes the
  **working-tree** `install.sh` while the cloned keryx source comes from the
  **committed** tree — which is why the first installer run needed a commit.

### Deliberately not fixed, with reasons

- **`serve-runner.ts` still gates required-fail-closed turns on launcher
  presence.** Real gap, and now commented at the call site. It is diagnostic,
  not a containment hole: the adapter still wraps the command and the launcher
  itself refuses, so nothing runs uncontained. Closing it needs either a spawn
  per turn (which the per-turn evaluation exists to avoid) or a cached probe
  with an invalidation policy — design work beyond step 1.
- **`SandboxLauncherInfo.available` → layer choice** (spec §2/§8). Step 3, per
  plan.md. A layer choice over one layer is a one-valued enum, and AC8 requires
  fail-closed to be unchanged.
- **Renaming `available` → `launcherPresent`.** Mechanical, but it touches
  `adapter.ts`, which AC14 asserts is unmodified. Step 3 replaces the field.
- **`SandboxLayer` hoisted out of the impure module.** Its natural home is
  `profile.ts`, which the specification's inventory marks "do not touch".
- **A negative control in the probe** (so a passthrough `bwrap` shim cannot
  produce a false green). The specification asks for a `/bin/true`-class trial
  and this implements exactly that; a containment *assertion* is strictly
  stronger and is recorded as follow-up rather than smuggled in here.

## Gate after round 1 fixes

| Gate | Result |
|---|---|
| `keryx health run` | PASS — score 93, trend stable, 0 P0 / 0 P1 |
| `bun test` (full) | 3291 pass / 14 skip / 0 fail across 317 files |
| sandbox + commands suites | 210 pass / 5 skip / 0 fail |
| `scripts/install-global.test.ts` | 8 pass / 0 fail |
| `bunx tsc --noEmit` | clean |
| `bun scripts/check-doc-links.ts` | 698 links / 0 broken |

Note: `keryx health run` initially reported WARN (`required source unavailable:
typescript`) because this worktree had no `node_modules`. After `bun install
--frozen-lockfile` the gate is PASS. The WARN was environmental, not a
regression.
