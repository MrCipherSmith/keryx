# O-3/O-5 + O-4's install clause: platform matrix, global-install smoke, cold-start measurement

Status: formalized
Source: the three remaining open items in `docs/requirements/keryx-opentui-shell/specification.md` §10

## Problem

Three claims in the package are still unevidenced.

**O-3 — platform coverage.** PRD N1 requires "prebuilt native binaries cover
keryx's target platforms (darwin-arm64, darwin-x64, linux-x64, linux-arm64 at
minimum); the install path pulls them; no Zig toolchain required at end-user
install." Only darwin-arm64 has ever been exercised — ADR-0005 says so itself —
and `.github/workflows/ci.yml` runs `ubuntu-latest` only.

**O-5 — cold-start latency.** "Measure cold-start of the TUI vs the current
instant readline shell" was a Phase 0 exit criterion (R5). No number exists in
the specification, in ADR-0005, or in any flow package. The gate passed on the
other four criteria.

**O-4's install clause.** Flow 113 closed O-4's fallback body and split the
remaining claim in two: "the global install produces a working CLI" is testable
and was deliberately deferred as an installer concern; "...launches the TUI" is
not testable without an allocated pty. This flow takes the testable half.

## What makes this closable now

The repository is **public**, so GitHub's free arm64 runners are available. All
four N1 targets are reachable as hosted runners, which turns O-3 from a
documentation problem into a CI problem:

| N1 target | Runner |
|---|---|
| linux-x64 | `ubuntu-latest` |
| linux-arm64 | `ubuntu-24.04-arm` |
| darwin-arm64 | `macos-latest` |
| darwin-x64 | `macos-13` |

Runner labels must be **verified against GitHub's current offering** during the
flow, not trusted from this table — availability has changed more than once.

`install.sh` already honours `KERYX_REPO_URL`, `KERYX_REF`, `KERYX_HOME` and
`KERYX_BIN_DIR`, so a global install can be driven into a temp directory from the
checkout itself, with no network fetch of the published repo.

## Expected Outcome

- **O-3**: each target runner installs dependencies with **no Zig**, resolves the
  `@opentui/core` native binary, and runs the OpenTUI-dependent tests with **zero
  skips** — a skip would mean the binary did not resolve, and the evidence would
  be vacuous rather than positive.
- **O-4 install clause**: a test drives `install.sh --global` into a temp prefix
  and proves the produced wrapper actually runs the CLI.
- **O-5**: a recorded, reproducible number comparing readline start-up with the
  cost the TUI adds, with the measurement's limits stated rather than implied.

## Honest limits, fixed before starting

- **O-5 cannot measure a full interactive TUI cold start.** `createCliRenderer`
  needs a controlling terminal and CI has none — the same constraint that makes
  O-4's second clause untestable. What is measurable is the dominant term:
  process start plus module graph plus the `@opentui/core` native import, against
  the readline path. That is what R5 was asking about, but the record must say so
  instead of implying a rendered first frame.
- **O-3 evidences the dependency and the suite, not the rendered UI.** For the
  same reason no runner can prove a frame was drawn. N1's wording — binaries
  cover the platforms, the install path pulls them, no Zig — is fully covered;
  "the TUI launches there" is not, and stays attributed to the pty gap.
- **Adding four runners changes CI cost and wall-clock for every future PR.**
  That is an ongoing consequence, not a one-off, and belongs in the record.

## Out of Scope

- A pty harness — it would close the remaining halves of O-3 and O-4, but it is a
  larger decision than this flow.
- Publishing to npm, or installing from a published package rather than a git ref.
- Performance *optimisation*. O-5 asks for a measurement; acting on it is separate
  work.
