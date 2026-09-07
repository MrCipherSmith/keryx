# T34 spec — repair per-file coverage rows and the non-recursive scan outcome

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`).

This is a regression-first repair of three defects the independent T28 review
reproduced with an executable probe (`T28-scan-probe.ts`) against the T20
recursive security scanner. Baseline probe run captured before any change:
raw `.metaproject/data/gdctx/raw/2026-09-06T13-44-40-374Z_run.log`.

Baseline confirms, byte for byte:
- F-004: `corpus/a/b/c/creds.env` appears twice in `files[]` (once `scanned`,
  once `skipped: canonical identity already visited`); `corpus/dup-creds.env`
  (the symlink that produced the second encounter) has no row at all;
  `corpus/x` is reported `skipped` even though it was the directory that was
  fully traversed (the entry actually skipped was `corpus/y/toX`).
- F-005: `withFlagFiles`/`withFlagRecursive` and `withoutFlagFiles`/
  `withoutFlagRecursive` are byte-identical — `--recursive` has no effect and
  there is no way to ask for non-recursive from the CLI.
- F-003 (not exercised by this probe; confirmed via the T28 review's separate
  gate probe and re-derived by reading `path-scan.ts:194-197`): a
  `recursive: false` directory scan pushes one `skipped` row for the target
  and returns without calling `incomplete()`, so `coverage.status` stays
  `"complete"` and (per `service.ts:172-175`, untouched by this task)
  `gate` stays whatever `computeGate([])` returns for zero findings — `pass`.

## Repairs (all confined to `src/security/path-scan.ts` and
`src/commands/security.ts`; `src/security/service.ts` is not touched — a
different worker owns it and its `runGate`/`readLatestReport` defects are a
separate task)

### 1. Per-file rows keyed on the encountered entry (path-scan.ts:168, 227-231)

`visit()` already computes `displayPath = relativePath(ownerRoot, candidate)`
at entry — the path actually walked to reach this entry, before any
canonical resolution. Twelve of fourteen `files.push` call sites already key
on `displayPath`. Two do not:

- line 168 (duplicate-by-canonical-identity skip row) keys on
  `relativePath(ownerRoot, canonical)` — the *target* identity, not the path
  that produced the second encounter.
- line 227-231 (`scanned` row, and the parallel `contents.push`) keys on
  `safePath = relativePath(ownerRoot, canonical)` for the same reason.

Fix: both sites switch to `displayPath`. The `visited` Set keyed on
`identityFor(metadata)` (dev:ino) is untouched — it still stops cycles and
duplicate scanning; only the *reported row* changes to name the entry that
was encountered. `contents[].path` must stay equal to the `scanned` row's
`path` (service.ts's `runScanPath` correlates `files` and `contents` by
`path` at `service.ts:160` to attach `security analysis unavailable` on an
`analyze()` failure) — so the `contents.push` gets the same `displayPath`
value, not a second independent one.

Expected after-fix shape for the P1 fixture: `corpus/a/b/c/creds.env` appears
once (`scanned`); `corpus/dup-creds.env` appears once (`skipped: canonical
identity already visited`); the directory alias row keys on whichever
directory entry was the second encounter (`corpus/y/toX` in the mutual-cycle
fixture), not on the canonical target.

### 2. Non-recursive directory scan must not read as a clean pass
(path-scan.ts:194-197)

Add an `incomplete("recursive traversal disabled")` call alongside the
existing `skipped` row when `!scope.recursive` and the target is a
directory. `runScanPath` in `service.ts:172-175` (untouched, already
verified correct by the T28 review) already promotes `computed.gate ===
"pass" && traversal.coverage.status === "incomplete"` to `"incomplete"` — so
marking coverage incomplete here is sufficient to flip the false `pass` to
`incomplete` without touching `service.ts`. This is the conservative repair
root specified: the non-recursive path is kept (not deleted), and recursion
is not silently forced on — a `recursive: false` directory target still
scans nothing below the top entry, but now says so truthfully.

### 3. `--recursive` / `--no-recursive` in the CLI (security.ts:194-291, help
text ~963/982)

- `scanPathArgument` (security.ts:277-291) already treats `--recursive` as a
  flag to skip past when hunting for the positional path argument; add
  `--no-recursive` to that skip set so it is not mistaken for the target
  path either.
- `handleScan` never read `--recursive` or forwarded a `recursive` value to
  `runScanPath` (`scanContainedPath` therefore always saw
  `input.recursive === undefined` and defaulted to `true`). Add a small
  parser: `--no-recursive` present -> `recursive: false`; else `--recursive`
  present -> `recursive: true`; else `undefined` (default stays `true`,
  matching today's behavior when neither flag is given — no silent forcing
  in either direction). Forward it into the `runScanPath` call the same way
  `exclusions`/`maxFiles`/`maxBytes` are conditionally spread in today.
- Update the two usage strings (security.ts:197, 963) and the help option
  table (security.ts:982) to mention `--no-recursive` so the CLI and the
  underlying `SecurityScanOptions.recursive` agree on what is expressible.

## Regression tests (own file: `security-recursive-scan.test.ts`)

Three new tests, one per repair, using the same `mkdtemp` + `securityCommand`
harness already in the file:

1. Mutual-symlink or alias-plus-duplicate fixture asserting every row's
   `path` is one of the entries actually encountered (no row names an
   identity that was never the argument to `visit`), no path is duplicated
   with two different statuses, and every encountered alias has its own row.
2. `--no-recursive` (explicit) over a directory holding a detectable secret:
   assert `coverage.status === "incomplete"`, `gate !== "pass"`, and
   `findings.length === 0` (nothing below the top was opened) — a check that
   never ran must not read as clean.
3. CLI flag parity: `--recursive` explicit vs. omitted are byte-identical
   (both default `true`); `--no-recursive` changes `scope.recursive` to
   `false` and actually changes scan behavior (fewer/no files scanned)
   relative to the same target scanned without the flag.

## Non-goals / guardrails

- Do not touch `src/security/service.ts` (`runGate`, `readLatestReport`,
  `runReport`, `computeGate` wiring) — owned by a concurrent worker fixing
  F-001/F-002.
- Do not touch `guard.ts`, `config.ts`, `output-validation.ts`, `detect/*`,
  `src/mcp/*`, `src/commands/agent.ts`.
- Do not force recursion on for `recursive: false`; do not delete the
  non-recursive branch.
- Re-verify (do not re-implement) what T28 confirmed clean: no EISDIR,
  cycle termination by device:inode, containment/leak-safety, findings
  surviving limit truncation, fail-with-incomplete fold.
- Synthetic fixtures under `mkdtemp` only, removed in `finally`; no real
  credentials, no network, no git state changes.
