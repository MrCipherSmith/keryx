# T34 implementation report — repair per-file coverage rows and the non-recursive scan outcome

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned files
only: `src/security/path-scan.ts`, `src/commands/security.ts`,
`src/commands/security-recursive-scan.test.ts`. No other file was touched;
`src/security/service.ts` (owned by a concurrent worker fixing F-001/F-002)
was read for context only.

## Repair 1 — per-file rows keyed on the encountered entry, not the canonical target (F-004)

- `src/security/path-scan.ts:172` (duplicate-by-canonical-identity skip row)
  and `:241`/`:242` (`scanned` row + the parallel `contents.push`) now key on
  `displayPath` — the path actually walked to reach this entry — instead of
  `relativePath(ownerRoot, canonical)`. The `visited` Set keyed on
  `identityFor(metadata)` (dev:ino) is untouched, so a cycle or a duplicate
  name is still scanned exactly once; only the *reported row's name* changed.
- Before: probe fixture with `corpus/a/b/c/creds.env` plus a symlink
  `corpus/dup-creds.env` pointing at it produced `corpus/a/b/c/creds.env`
  **twice** (once `scanned`, once `skipped`) and `corpus/dup-creds.env`
  **zero** times. Raw `.metaproject/data/gdctx/raw/2026-09-06T13-44-40-374Z_run.log`
  lines 24-68 (`credsEnvEntries`).
- After: `corpus/a/b/c/creds.env` appears once (`scanned`);
  `corpus/dup-creds.env` appears once (`skipped: canonical identity already
  visited`). Raw `.metaproject/data/gdctx/raw/2026-09-06T13-47-43-026Z_run.log`
  lines 24-69 (`credsEnvEntries`).
- Own regression: `security-recursive-scan.test.ts` — "T34 F-004: per-file
  rows key on the encountered entry, not the canonical target" — asserts one
  row per path with a single status, `corpus/dup-creds.env` gets its own
  row, and the directory that was genuinely visited first (`corpus/x` in the
  mutual-cycle fixture) never itself carries a duplicate-skip row.

## Repair 2 — non-recursive directory scan never reads as a clean pass (F-003)

- `src/security/path-scan.ts:198-205`: the `!scope.recursive` branch (a
  directory target with recursion disabled) now calls
  `incomplete("recursive traversal disabled")` alongside the existing
  `skipped` row for the target, before returning without descending.
- `runScanPath` in `src/security/service.ts:172-175` (unmodified, and
  previously confirmed correct by the T28 review) already promotes
  `computed.gate === "pass" && traversal.coverage.status === "incomplete"`
  to `"incomplete"` — so marking coverage incomplete here is sufficient to
  turn the prior false `pass` into `incomplete` without touching that file.
- The branch is otherwise unchanged: the non-recursive path is kept (root's
  explicit direction), and nothing forces recursion on when it is not
  requested.
- Own regression: `security-recursive-scan.test.ts` — "T34 F-003: a
  non-recursive directory scan never reports a clean pass over unscanned
  content" — a directory holding a detectable secret, scanned with
  `--no-recursive`, produces `coverage.status: "incomplete"`,
  `gate !== "pass"`, zero `scanned` files, and a `skipped: recursive
  traversal disabled` row for the target.
- This defect predates the T28 probe's own coverage (`T28-scan-probe.ts` has
  no non-recursive-directory case), so there is no "before" run of that
  specific probe file to diff; the fix and its regression were verified
  directly against the exact `path-scan.ts:194-197` code path the T28
  review's separate gate probe identified (`T28-review.md` F-003, evidence
  section "non-recursive directory scan").

## Repair 3 — `--recursive` / `--no-recursive` mean what they say (F-005)

- `src/commands/security.ts`: added `recursiveScanFlag(args)` — `
  --no-recursive` present → `false`; `--recursive` present (and not
  `--no-recursive`) → `true`; neither → `undefined`, so `scanContainedPath`'s
  own default (`true`) applies exactly as before. `handleScan` now forwards
  this into the `runScanPath` call the same way `exclusions`/limits are
  conditionally spread.
- `scanPathArgument` now also skips `--no-recursive` (it already skipped
  `--recursive`) so neither flag is mistaken for the positional target path.
- Usage strings (`security.ts:197`, `:963`) and the help option table
  (`security.ts:982-985`) updated to advertise `--no-recursive`.
- Before: `T28-scan-probe.ts` "P5 flags" showed `withFlagFiles` (`--recursive`)
  and `withoutFlagFiles` (no flag) byte-identical, both `scope.recursive:
  true` — expected and unchanged after the fix, since neither run asked for
  `--no-recursive`. Raw `2026-09-06T13-44-40-374Z_run.log` lines 214-269
  (before) and `2026-09-06T13-47-43-026Z_run.log` lines 214-269 (after) — both
  runs are identical in this section, confirming no regression to the
  existing `--recursive`/default-true behavior.
- Own regression: `security-recursive-scan.test.ts` — "T34 F-005:
  --recursive and --no-recursive change scope.recursive and actual scan
  behaviour" — `--recursive` explicit and omitted agree (both scan the same
  files); `--no-recursive` actually changes behavior (`coverage.status:
  "incomplete"`, zero scanned files) relative to the same target scanned
  without the flag.

## Acceptance evidence

| Criterion | Status | Evidence |
|---|---|---|
| AC6 (AFC-17): nested folder gives no EISDIR; symlink cycle does not loop; inaccessible entries and exhausted limits are reflected; a found violation and incomplete coverage are visible simultaneously. | met (re-verified, unmodified by this task) | `T28-scan-probe.ts` after-run: `stderrHasEISDIR: false` (P1), cycle fixture completes in 26ms with skip rows (P1), `--max-files`/`--max-bytes` limits reflected with findings retained (P3), `gate: "fail"` + `coverage: "incomplete"` simultaneously (P2/P3). Raw `.metaproject/data/gdctx/raw/2026-09-06T13-47-43-026Z_run.log`. |
| Policy (policies.md, security scan): per-file scanned/skipped/failed outcomes with reasons match what actually happened to each encountered entry, no contradictory duplicate rows, no closed name exposed; findings preserved independently of coverage. | met | Repair 1 evidence above (no duplicate/contradictory rows, every encountered entry gets its own row); leak-safety re-verified negative (`leaksOutsideFileName/DirName/NestedName/TmpAbsolutePath/Content: false` in both before and after runs, P2); findings retained under `--max-files` truncation (P3, `findingCount: 1`). |
| A directory target scanned without recursion never reports a clean pass over zero scanned files; the CLI flag and the exported API agree on what recursion means; the three existing recursive-scan tests and the focused security selection stay green. | met | Repair 2 (own regression test, `coverage: incomplete`, `gate !== pass`, 0 scanned) and Repair 3 (CLI `--no-recursive` forwards `recursive: false` to `runScanPath`/`scanContainedPath`, matching the API's own option). `bun test src/commands/security-recursive-scan.test.ts`: 6 pass / 0 fail / 46 expect() — the original 3 T20 tests plus 3 new T34 tests, all green. Raw `.metaproject/data/gdctx/raw/2026-09-06T13-47-16-786Z_run.log`. |

## Verification

- `T28-scan-probe.ts` before: exit 0, raw `.metaproject/data/gdctx/raw/2026-09-06T13-44-40-374Z_run.log`.
- `T28-scan-probe.ts` after: exit 0, raw `.metaproject/data/gdctx/raw/2026-09-06T13-47-43-026Z_run.log`. Diff confined to the `files[]` rows named in Repair 1 (F-004); every other section (EISDIR, leak checks, limits, fail+incomplete fold, P5 flag parity, single-file target) is byte-for-byte identical before/after.
- `bun src/cli.ts ctx run -- bun test src/commands/security-recursive-scan.test.ts`: 6 passed, 0 failed, 46 expect() calls. Raw `.metaproject/data/gdctx/raw/2026-09-06T13-47-16-786Z_run.log`.
- `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts src/security/persistence-sinks.test.ts src/commands/security-recursive-scan.test.ts`: 40 passed, 0 failed, 130 expect() calls. Raw `.metaproject/data/gdctx/raw/2026-09-06T13-47-21-425Z_run.log`.
- `bun src/cli.ts ctx run -- bun run typecheck`: pass (`tsc --noEmit`, no errors). Raw `.metaproject/data/gdctx/raw/2026-09-06T13-47-33-986Z_run.log`.
- `bun src/cli.ts ctx run -- bunx eslint src/security/path-scan.ts src/commands/security.ts src/commands/security-recursive-scan.test.ts`: pass, no output. Raw `.metaproject/data/gdctx/raw/2026-09-06T13-47-38-670Z_run.log`.
- `bun src/cli.ts ctx rg "recursive:\s*false|recursive: false|no-recursive" src`: confirmed no other production or test code depends on `recursive: false`/`scanContainedPath` behavior beyond the files this task owns — no collateral surface. Raw `.metaproject/data/gdctx/raw/2026-09-06T13-47-59-682Z_rg.log`.

No git state changes, no network, no model calls, no dependency/lockfile changes. Synthetic fixtures only, all under `mkdtemp`, removed in `finally` blocks. `src/security/service.ts` was read (to confirm the `pass -> incomplete` fold Repair 2 relies on) but not modified.

## Changed files

- `src/security/path-scan.ts`: F-004 (per-file rows keyed on `displayPath`) and F-003 (`incomplete()` on a non-recursive directory skip).
- `src/commands/security.ts`: F-005 (`--no-recursive` parsing/forwarding, `recursiveScanFlag`, updated usage/help text).
- `src/commands/security-recursive-scan.test.ts`: three new regression tests, one per repair.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file set and lines; no blast-radius question arose); wiki_used: no (not-relevant — the normative source is policies.md and acceptance-criteria.md, both supplied directly as context_refs); ctx_used: yes (every search via `ctx rg`, every command via `ctx run`, all raw logs referenced above); raw_rg_used: no.`
