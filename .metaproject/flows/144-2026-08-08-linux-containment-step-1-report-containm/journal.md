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

## Round 2 review — 0 blockers, 1 major, 12 minors, 7 info

Two reviewers over the fix delta (`c0fc950d..HEAD`), because a fix round is
where regressions come from: logic + security, and testing + architecture. Both
verified the seven round-1 fixes are correct rather than merely present, and
both independently found the same major.

**The major.** The round-1 fix moved the trial *argv* onto `wrapWithSandbox` but
left the layer *label* derived from the platform string — a second, independent
platform-to-layer decision. The label is what `sandbox status` prints, what
`--json` publishes, and what the bubblewrap AppArmor remediation is keyed on, so
at step 3 a Landlock trial would be labelled `bwrap` and its failure handed a
remediation for a launcher that never ran. The fix's own stated rationale
applied verbatim to the thing it had not fixed.

Resolved by reading the layer off the dispatcher's output (`argv[0]`, the
launcher name by convention) instead of re-deriving it. An unrecognised launcher
is a probe **failure**, not a guess — so when step 3 adds a branch and forgets
this function, the probe says "cannot identify the layer" instead of quietly
mislabelling. `wrap.ts` is untouched: the alternative fix (adding a `layer`
field to `WrapResult`) would modify a launcher, which the implementation plan
puts out of scope for step 1 and which frozen AC14 asserts is unmodified.

**Regressions the fix round introduced, all fixed.**

| Finding | Fix |
|---|---|
| `mktemp` under `set -e` — an unwritable TMPDIR aborted the installer *after* it printed "keryx installed", turning the report into the gate it must not be | `mktemp \|\| true`, empty means no capture |
| `sanitizeDetail`'s control-character class skipped U+000D, letting **CR** through — enough to redraw the line and impersonate keryx's own `Remediation:` output from launcher stderr | class widened to cover U+000B through U+001F |
| Bare `unshare` / `userns` markers matched `Unknown option --unshare-pid` and `spawnSync /usr/bin/unshare ENOENT` — round-1's misdiagnosis returning through the classifier that fixed it | whole diagnostic phrases only; `classifyFailure` gated on `layer === "bwrap"` |
| `definedOnly` dropped `launcherName`, which the interface declared required | declared optional |
| The `probe === undefined` branch asserted "a trial contained command was run" where none had | its own sentence |

**Other fixes:** installer output bounded and stripped in shell too (the TS
sanitizer is not on that path — the process producing it has already failed);
`linuxKernelFacilityPhrase("none")` no longer renders "refused the no kernel
facility…"; `defaultSpawn` exported with an injectable `spawnSync` and tested,
having been the one production code path that starts a process and was covered
nowhere; `PROBE_TIMEOUT_MS` asserted to be a bound, not just forwarded (it was
compared against itself); the `unprobed` finding documented in the runbook, which
had shipped a user-visible sentence no document described; the installer's `bun`
shim pinned to an absolute path (a relative `exec bun` would re-resolve through
the shimmed PATH and re-enter itself forever — a 240s timeout, not a failure).

`purity.test.ts` was rewritten twice: it now matches *import statements* rather
than substrings (a doc comment mentioning `node:child_process` would have failed
it, and the positive case would have passed on a comment alone), and checks
transitive reach — the route the barrel opened. Writing it also produced a
finding of its own: the first version asserted `probe.ts` was the only module in
the package that spawns, and the test immediately failed because `tls-ca.ts`
shells out to openssl. The spawning set is now computed from source rather than
hand-maintained.

### Verified by execution, not by reading

- **`report_sandbox_status` against three fakes**: `mktemp` failing (no abort,
  report still runs), a noisy failing keryx (CR and ESC stripped, line capped at
  500 chars, output capped at 50 lines), and success (indented). Zero leaked
  temp files on every path.
- The round-1 doc-sync mutation, re-run by the reviewer: **12 pass / 1 fail** —
  now caught.

### Round 2 — accepted and NOT fixed

- **`WrapResult` gaining a `layer` field** (the reviewers' preferred fix for the
  major). It modifies `wrap.ts`, which step 1 is scoped out of and AC14 asserts
  is unmodified. The chosen fix removes the same risk from inside `probe.ts`.
- **The `wrapped === false` branch being unreachable** — now reachable and
  tested via the injected dispatcher seam, so this resolved itself.
- Coverage gaps listed as remaining: `printHelp`, the darwin installer path
  (`linuxGuardedTest` skips it everywhere), and install.sh's "keryx exits 0 but
  prints nothing" branch. All low value; recorded, not closed.

## Round 3 review — 1 major, 4 minors, 2 info

Run over the round-2 fix delta (`9f28a2b2..HEAD`), on the same reasoning as
round 2 and for the same reason: round 1's fixes introduced four defects, so
round 2's fixes were not to be trusted either.

**The major, and it is in the bash again.** The RETURN trap was installed as
`trap "rm -f '${status_error}'" RETURN` — eager expansion, pasting the path
into a single-quoted trap body. A `TMPDIR` containing an apostrophe therefore
made that body a syntax error, and **a failing RETURN trap is fatal under
`set -e`**, so the installer aborted with exit 2 *after* printing "keryx
installed globally". The report becoming a gate — the third distinct time this
function has done that, and the third distinct mechanism. The `shellcheck
disable=SC2064` comment justifying the eager form was simply wrong: a RETURN
trap fires while the function's locals are still in scope, so deferred
expansion is both safe and correct.

Reproduced and then falsified: reverting the quoting makes the new test fail
with `return trap: line 109: unexpected EOF while looking for matching '` and
exit 2, exactly as the reviewer described.

**The other findings.**

| Finding | Fix |
|---|---|
| `print_bounded_output` stripped only CR and ESC while claiming "control characters removed" — BEL, BACKSPACE, VT and FF passed through, and backspace erases the indent exactly as CR does | one class strip, matching `sanitizeDetail`'s |
| `importsSpawn` anchored on a line starting with `import`, so a wrapped multi-line import and `await import()` both evaded the AC14 purity guard | anchored on the specifier; six import forms pinned |
| "transitive" was one hop over direct spawners only, so a module reaching `probe.ts` through the barrel was not detected — the route the comment itself names | fixed point over relative imports; `index.ts` now in the closure, asserted |
| Two `USERNS_DENIAL_MARKERS` entries were dead by subsumption | removed, plus a test that no marker contains another |
| The round-2 bash had no regression coverage at all | two installer tests, both falsified by hand |

**The gap that mattered most was the last one.** Three bash regressions in three
rounds, each found by a human reading the diff and then fixed with nothing to
stop the next. `scripts/install-global.test.ts` now drives the real script
against a hostile `TMPDIR` (apostrophe + unwritable) and against a keryx that
dies emitting CR, ESC, BEL, backspace and 120 long lines — asserting on the
BYTES in the transcript, not on how they render.

### Falsification runs

| Reverted change | Result |
|---|---|
| trap quoting back to eager | **9 pass / 1 fail** — exit 2, `unexpected EOF` |
| control class back to CR+ESC only | **9 pass / 1 fail** — control bytes in the transcript |

Both restored; `bash -n` clean, suite back to 10 pass.

### Round 3 — accepted and NOT fixed

Nothing outstanding. The two `info` findings (dead markers, an indentation slip
in `defaultSpawn`) were folded in rather than deferred.

## Round 4 review — 0 blockers, 0 majors, 3 minors, 5 info

The first clean round: round 3 did not introduce a fourth regression. The
reviewer ran the adversarial cases rather than reasoning about bash, and
confirmed something the previous round had understated — **the pre-round-3
eager trap was a live command-injection sink**, not merely a quoting slip:
`TMPDIR=".../x'$(touch /tmp/kx-PWNED)'y"` executed the payload in the
installer's own shell. The deferred form is immune.

Findings fixed:

| # | Finding | Fix |
|---|---|---|
| F-002 | `$status_error` in the trap had no `:-` default, so a RETURN trap firing where the local is out of scope aborts under `set -u` | `${status_error:-}` |
| F-003 | The "hostile TMPDIR" test covered only the apostrophe; the unwritable case (round 2's regression) was asserted nowhere despite the comment and this journal claiming it | three cases now, table-driven, one per regression |
| F-004 | The util-linux marker phrases were invented — util-linux prints `unshare failed` / `write failed /proc/self/uid_map`, not what was listed | corrected against util-linux 2.39.3 |
| F-006 | `export { USERNS_DENIAL_MARKERS }` was inserted between a JSDoc block and the constant it documents | export moved onto the declaration |
| F-008 | the indenting loop's `line` was not `local` | declared |

### F-001 — the fix that was worse than the defect, and the reasoning that was wrong about why

Round 4 declined to strip C1 and wrote down a reason. Round 5 found the
reason was **factually wrong in two of its three claims**, and — worse — that
it pointed the next maintainer straight at a form that corrupts the
operator's evidence. A wrong rationale committed beside correct code is the
exact defect class this package exists to remove: an artefact stating
something nobody verified. So it was measured, and then rewritten to match.

**What was actually measured** (bash 5.2.21, both the C locale that
`install.sh` really runs under and en_US.UTF-8):

| Form | C locale | UTF-8 locale | Verdict |
|---|---|---|---|
| `[$'\u0080'-$'\u009f']` | destroys the diagnostic | harmless | unusable |
| `[$'\x80'-$'\x9f']` | ASCII-safe, non-ASCII gutted | same | unusable |
| exact two-byte substitutions | correct | correct | **adopted** |

1. **It is not collation.** `$'\u0080'` in the C locale is not a character at
   all: it degenerates to the six literal bytes `5c 75 30 30 38 30` — the text
   `\u0080` — which poisons the bracket class with a backslash, `u`, and the
   digits 0-9. In en_US.UTF-8 the same expression yields `c2 80` and is
   harmless, which is precisely why it would survive review on a developer's
   machine. Measured, the C-locale class turned
   `clean-marker: a;b[c]d<e>f=g?h@i&j and Remediation curl` into
   `clean-marker abc]defghi&j and emediation crl`.
2. **The `\u0085`-is-byte-0x85 claim was wrong too**, and in the direction
   that matters: the round-4 comment called the explicit-character variant a
   harmless no-op, when in the C locale it puts `\`, `u` and digits into the
   class and deletes them from the evidence.
3. **The byte range is the trap the old comment pointed at.**
   `[$'\x80'-$'\x9f']` is byte-accurate and ASCII-safe in *both* locales —
   and mangles every multi-byte character, because 0x80-0x9F are legal UTF-8
   continuation bytes. Measured: `err <em-dash> caf<e-acute> <cyrillic>`
   became `err ? caf? ????` in both locales.

**So the gap got closed, not just re-declined.** Exact two-byte substitutions
for the seven C1 sequence introducers (NEL, DCS, CSI, ST, OSC, PM, APC) are
measured correct in both locales: all text survives, ASCII and non-ASCII
alike, and only the introducer is removed. `install.sh` now does that.

**Accepted residual, stated rather than glossed:** a RAW `0x9b` byte (as
opposed to its UTF-8 encoding `c2 9b`) still passes through, and on a terminal
in an 8-bit or latin-1 mode that byte IS the control introducer. It is not
removable — `0x9b` is a legal UTF-8 continuation byte (U+06DB is `db 9b`), so
stripping it raw would corrupt real characters, the larger harm. On a UTF-8
terminal, the default everywhere this installs, a lone `0x9b` is invalid UTF-8
and is not acted on.

The test now pins the direction that catches all of this: **non-ASCII must
survive**. Falsified by swapping the surgical loop for the byte range — the
suite went to 11 pass / 1 fail, with `caf<e-acute> <cyrillic>` reduced to
mojibake and the introducers only half-removed, leaving dangling lead bytes.
### Falsification runs

| Reverted change | Result |
|---|---|
| C1 range re-added | **10 pass / 2 fail** — punctuation and letters destroyed in the transcript |

Restored; suite back to 12 pass.

### Round 4 — accepted and NOT fixed

- **F-005** (`importsSpawn` false positives on template literals, string
  constants and `import type`). Every one fails *closed* — an over-strict purity
  test shouts rather than goes quiet — and the `withoutComments` block-comment
  hole needs deliberately adversarial source. Left as documented "good enough".
- **F-007** — AC13's frozen wording says no *comment* may name the sysctl, and
  three comments introduced by this flow do, each while explaining the
  rejection. R8's actual requirement (nothing may *recommend* it) is met and
  enforced by four negative assertions. Recorded here and in the AC confirmation
  note rather than silently confirmed.

## Round 5 review — 0 blockers, 0 majors, verdict READY

Two minors, both about the same thing: the C1 decision was right and the
reasoning recorded for it was not. Corrected above, by measurement, and the
closable half of the gap closed.

Also fixed from this round:

- The `chmod 0500` hostile-TMPDIR case would silently stop reproducing round
  2's regression under a root CI runner, because root bypasses directory write
  permission. It now skips as root rather than passing for the wrong reason;
  the non-existent-path case reaches the same `mktemp` failure and is
  root-proof, so the mechanism stays covered either way.
- The `regression` field was destructured and then referenced only inside a
  `//` comment, where it is inert text. It is in the test title now, so a
  failure names which of the three mechanisms came back.

Accepted and not fixed: `importsSpawn`'s false positives on template literals
and `import type` (all fail *closed* — an over-strict purity test shouts
rather than goes quiet); `"unshare failed"` also matching util-linux's EINVAL
wording (a false positive, and unreachable — nothing here invokes unshare(1));
bubblewrap's setuid-only `unshare user ns` strings (that path needs a setuid
bwrap, which keryx never spawns); and AC13's literal "or comment" wording,
which three explaining comments breach while R8's actual requirement holds.

### The pre-existing installer failure, re-confirmed independently

The coordinator flagged `scripts/install-global.test.ts` at 3 pass / 2 fail.
Confirmed as the base-branch state and as the defect this flow already fixed
in round 1: `/usr/bin` holds **both** `bwrap` and `bash` on this host (checked
directly), so the old `pathWithoutBwrap` dropped `/usr/bin` to hide bubblewrap
and took the shell with it — `Executable not found in $PATH: "bash"`. The
shipped helper mirrors such a directory as symlinks minus `bwrap` instead of
subtracting it, which is the shadow-rather-than-subtract approach. On this
branch the suite is **12 pass / 0 fail**.
## Final gate (after round 5)

| Gate | Result |
|---|---|
| `keryx health run` | PASS — score 93, trend stable, 0 P0 / 0 P1 |
| `bun test` (full) | 3316 pass / 14 skip / 0 fail across 317 files |
| sandbox + commands suites | 231 pass / 5 skip / 0 fail (baseline 158 pass) |
| `scripts/install-global.test.ts` | 12 pass / 0 fail (baseline 3 pass / 2 fail on this host) |
| `bunx tsc --noEmit` | clean |
| `bash -n scripts/install.sh` | clean |
| `bun scripts/check-doc-links.ts` | 698 links / 0 broken |

The 14 skipped tests are pre-existing env-gated live smoke suites
(`KERYX_DUAL_AXIS_LIVE` and friends), untouched by this flow.

Note: `keryx health run` initially reported WARN (`required source unavailable:
typescript`) because this worktree had no `node_modules`. After `bun install
--frozen-lockfile` the gate is PASS. The WARN was environmental, not a
regression.
\u0085'` there is the single byte 0x85, which never matches the
two-byte UTF-8 sequence C2 85 that actually appears.

So C1 is deliberately **not** stripped on the shell side, the divergence from
the TypeScript sanitizer is documented with the measurement, and the reasoning
is recorded in `install.sh` rather than left to be rediscovered. Every control
that can actually erase the indent — CR, ESC, BEL, BACKSPACE, VT, FF, DEL — is
C0 or DEL and is covered; a UTF-8 terminal renders C2 9B as a character, not as
CSI.

The test now pins **both** directions: controls removed, and punctuation
preserved. That second assertion is the one that caught this.

### Falsification runs

| Reverted change | Result |
|---|---|
| C1 range re-added | **10 pass / 2 fail** — punctuation and letters destroyed in the transcript |

Restored; suite back to 12 pass.

### Round 4 — accepted and NOT fixed

- **F-005** (`importsSpawn` false positives on template literals, string
  constants and `import type`). Every one fails *closed* — an over-strict purity
  test shouts rather than goes quiet — and the `withoutComments` block-comment
  hole needs deliberately adversarial source. Left as documented "good enough".
- **F-007** — AC13's frozen wording says no *comment* may name the sysctl, and
  three comments introduced by this flow do, each while explaining the
  rejection. R8's actual requirement (nothing may *recommend* it) is met and
  enforced by four negative assertions. Recorded here and in the AC confirmation
  note rather than silently confirmed.

## Final gate (after round 4)

| Gate | Result |
|---|---|
| `keryx health run` | PASS — score 93, trend stable, 0 P0 / 0 P1 |
| `bun test` (full) | 3314 pass / 14 skip / 0 fail across 317 files |
| sandbox + commands suites | 229 pass / 5 skip / 0 fail (baseline 158 pass) |
| `scripts/install-global.test.ts` | 10 pass / 0 fail (baseline 3 pass / 2 fail on this host) |
| `bunx tsc --noEmit` | clean |
| `bash -n scripts/install.sh` | clean |
| `bun scripts/check-doc-links.ts` | 698 links / 0 broken |

The 14 skipped tests are pre-existing env-gated live smoke suites
(`KERYX_DUAL_AXIS_LIVE` and friends), untouched by this flow.

Note: `keryx health run` initially reported WARN (`required source unavailable:
typescript`) because this worktree had no `node_modules`. After `bun install
--frozen-lockfile` the gate is PASS. The WARN was environmental, not a
regression.
