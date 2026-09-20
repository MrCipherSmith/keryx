# Managed Review — Flow 278 (shell god-file split, P2b)

PR #631, squash-merged to main as `7fbfa861979e8da04c3b393581cfb76c38aacdbf`.
The PR's own head commit (what `gh` reports, and what this ingest targets per
`manifest.target.head`) is `c7b50ceda331b58e5935095ebc9932d341c35ab8` — the
squash commit sha is a different, GitHub-synthesized commit and is not what
the completion gate checks against.

## Scope reviewed

- Full commit diff (`keryx ctx run -- git show --stat 7fbfa861`), then the
  complete diff of every PRODUCTION file the commit touches, read directly
  (not summarized from the commit message):
  `src/commands/serve.ts` (1 hunk), `src/commands/shell-approval.ts` (1 hunk),
  `src/commands/shell.ts` (3 hunks), `src/tui/bus-wake.ts` (1 hunk, new
  export), `src/tui/boot-animation.ts` (1 hunk, new exports), `src/tui/tui-shell.ts`
  (8 hunks), and the new file `src/tui/bus-join.ts` (125 lines, in full).
  Confirmed via `git show --stat -- src/lib/` that `src/lib/` has zero diff.
- AC2 (the one deliberate behaviour change, given priority per the review
  brief): read the whole `runServe` teardown closure
  (`src/commands/serve.ts:262-287`), not just the diff hunk. `finish()` sets
  `draining = true` as its very first statement after the `if (draining)
  return;` guard, before any `console.log`/`listener.drain()` work runs. The
  guard is therefore already armed before the first signal's async work
  (`listener.drain().then(...)`) has a chance to yield, so a second
  `SIGINT`/`SIGTERM` delivered to the now-`process.on`-registered `finish`
  hits the guard and returns immediately — it cannot re-enter the drain or
  double-resolve the promise. **AC2 holds.**
- AC5 (the getter claim, given priority per the review brief): read
  `src/tui/bus-join.ts` in full. Every field of `BusJoinCallbackDeps` is a
  function type (`isDestroyed`, `onSystemLine`, `pushToInbox`,
  `markDelivered`, `setFleetPeers`, `paintFleet`, `onInboxSizeObserved`,
  `paintHoldBanner`, `onLeaseHoldPoll`, `onBusWakePoll`, `getDelivered`,
  `resetDelivered`) — confirmed by reading the interface, not the doc
  comment. Then read the call site, `tui-shell.ts:4691-4710`: `onLeaseHoldPoll:
  () => leaseHoldController?.onPoll()` and `onBusWakePoll: (delivered) =>
  busWakeController?.onPoll(delivered)` are arrow-function thunks closing over
  the outer `let busWakeController`/`let leaseHoldController` (declared at
  `tui-shell.ts:3138` and `:3143`, assigned only at `:7028` and `:7058` —
  ~2,337 and ~2,367 lines after the callback build). Because JS closures bind
  variables, not values, these thunks read the CURRENT value at call time,
  not `undefined` captured at build time — the getter interface is actually
  exercised correctly at the one call site that matters, not just declared in
  the type. `paintFleet`/`paintHoldBanner` are passed as bare references, not
  wrapped — checked that both are `const`, defined at `:3380`/`:3533` (before
  the callback build, never reassigned), so passing them directly is safe and
  is not the same hazard the getter fields guard against. **AC5 holds.**
- AC7: confirmed `git show --stat -- src/lib/` for this commit is empty (no
  output), and that `allowShellPattern(pattern: string, dir?: string)` at
  `src/lib/shell-permissions.ts:328` already had the `dir` parameter before
  this diff (it is not part of the diff). `rememberExactShellGrant`'s new
  `options?.dir` is a straight pass-through: `allowShellPattern(exact,
  options?.dir)`. The production call site in `shell.ts:1963` uses
  `...(configDir !== undefined ? { dir: configDir } : {})` (a spread, not
  `dir: configDir`) specifically so an explicit `undefined` is never sent
  under `exactOptionalPropertyTypes` — confirmed this matters because
  `configDir` here is `runAgentRepl`'s own pre-existing `configDir?: string`
  parameter (already present before this flow, per its own doc comment
  referencing flow 268 T26), fed from `runtime.cacheDir` at `shell.ts:4069`,
  undefined by default in production. **AC7 holds**, and nothing new reaches
  the operator's real permissions file by default.
- AC3 (every other production edit is behaviour-neutral): read each file's
  diff and checked it against the four permitted forms:
  - `shell.ts`: JSDoc-only hunk, plus `loadShellPermissions(configDir)` /
    `shellPermissionsFingerprint(configDir)` / the `rememberExactShellGrant`
    spread — all threading a pre-existing optional parameter whose default
    (`undefined`) reproduces prior behaviour (verified `loadShellPermissions`/
    `shellPermissionsFingerprint` already took `dir?: string` in the
    unmodified `src/lib`).
  - `shell-approval.ts`: adds `dir?: string` to `rememberExactShellGrant`'s
    options and threads it to `allowShellPattern` — optional injected
    dependency, default preserves old behaviour (see AC7 above).
  - `tui-shell.ts`: (a) import-only changes (moving `BusPeer`/
    `formatBusEventLine` imports to where they're now used, in `bus-join.ts`);
    (b) `isToolAvailableToSideWorker` extraction — diffed the extracted
    function body (`tool.definition.risk === "read" &&
    !SIDE_WORKER_DENIED_TOOL_NAMES.has(tool.definition.name)`) character-for-
    character against the removed inline filter predicate — identical; (c)
    the `onEvent`/`onPeers` inline bodies replaced by
    `buildBusJoinCallbacks(...)` — diffed the removed inline bodies against
    `bus-join.ts`'s implementation line-for-line: same push/mark-delivered
    order in `onEvent`, same paint-fleet-before-report-delivery-before-reset
    order in `onPeers`; (d) `decideJoinAdoption({ destroyed, disabled: false
    })` replacing the inline `if (destroyed) {...leave...}` — `disabled:
    false` is correct because the `"disabled" in joined` branch above it
    already returned, so this line is only reached when `disabled` is false;
    the decision table (`if disabled return "off"; if destroyed return
    "leave"; return "adopt"`) returns `"leave"` under exactly the same
    condition the removed `if (destroyed)` did; (e) splash lifecycle —
    `createSplashLifecycle({ mount, initialHistoryLength })` mounts iff
    `initialHistoryLength === 0` (matches the removed `if (history.length ===
    0)`), and `removeIfShown()` is `remove?.(); remove = undefined;` — the
    same guarded-idempotent shape as the removed `removeSplash?.();
    removeSplash = undefined;`, verified at all three call sites
    (`applyOpened`'s early no-op-when-unset case, the unconditional
    post-assignment call in the `viewedReadOnly` branch, and `runLine`'s
    first-operator-line teardown); (f) `BUS_WAKE_CAPPED_NOTICE` replacing a
    hardcoded string — diffed the constant's value in `bus-wake.ts` against
    the removed inline string; character-identical.
  - `bus-wake.ts`: pure addition of an exported constant, no behaviour
    change to any existing export.
  - `boot-animation.ts`: pure addition (`createSplashLifecycle` and its
    types), no existing export touched.
  - `bus-join.ts`: new file, no prior behaviour to preserve or break; its
    contents are exactly the extracted logic checked against the old inline
    bodies above.
  **AC3 holds** for every production file the commit stat lists outside
  `serve.ts`.
- AC1 (non-vacuity of the widened scan): read the full diff of
  `src/mcp-servers/invariants.test.ts`. The scan is now
  `signalHandlerScanFiles()` = `listSourceFiles(HERE) +
  listSourceFiles(join(HERE, "..", "commands"))`, and `listSourceFiles`
  (`src/lib/import-policy.ts:322`) globs `**/*.{ts,tsx}` recursively,
  excluding `.test/.smoke/.bench.ts(x)` and `.d.ts` — so it is a real
  recursive directory scan, not a relist of the same two files under a new
  name; a future split into `src/commands/shell/*.ts` stays in scope. The
  non-vacuity test changed from asserting two named files have handlers to
  `expect(withHandlers.length).toBeGreaterThan(0)` over the same
  `signalHandlerScanFiles()` set — this WOULD fail if the scan found no
  `process.on("SIG...")` registrations anywhere, so it is a real check, not
  one that passes by construction. **AC1 holds.**
- AC4: read `bus-wake.ts`'s new `BUS_WAKE_CAPPED_NOTICE` export and its
  value; confirmed it is textually identical to the string it replaces at
  its `tui-shell.ts` call site. Read `tui-bus.test.ts`'s diff and confirmed
  the OLD `source.toContain(...)` text-scraping test for this wording was
  removed outright (not left as a second, redundant check) — the audit
  really does stop reading `tui-shell.ts` for this. **AC4 holds.**
- AC6: read `boot-animation.test.ts`'s diff — `createSplashLifecycle` is
  driven directly with a fake `mount` (three tests: mounts iff
  `initialHistoryLength === 0`, boundary for history.length > 0 never
  mounting, `removeIfShown` idempotent across two calls) — a real unit
  suite against the extracted function, not a source-text scrape. The
  remaining `tui-shell.ts` wiring check in the same file was narrowed to
  anchor on the call-site text (`"splash = createSplashLifecycle({"` and a
  count of `.removeIfShown()` occurrences `>= 3`), which is far more
  reformatting-resistant than the old multi-hundred-character window slice
  it replaced. Read `tui-shell.test.ts`'s diff — the fourth and last
  flow-173 F-003 test now calls `isToolAvailableToSideWorker(...)` directly
  with three cases (read+allowed, read+denied-by-name, non-read), instead of
  slicing `tui-shell.ts`'s source text for the filter predicate. **AC6
  holds.**
- AC8/AC9: recomputed the manifest table in
  `docs/requirements/keryx-shell-split/source-text-audit-inventory.md`
  myself rather than trusting the stated total — the 12 listed rows
  (`commands/shell-bus.test.ts` 2, `commands/shell-grant-refresh.test.ts` 1,
  `commands/shell-lease.test.ts` 3, `commands/shell-task-registry-wiring.test.ts`
  1, `commands/shell.test.ts` 5, `mcp-servers/approval-wiring.test.ts` 3,
  `tui/boot-animation.test.ts` 1, `tui/shell-fallback.test.ts` 1,
  `tui/tui-bus.test.ts` 1, `tui/tui-hold.test.ts` 1,
  `tui/tui-session-lease.test.ts` 3, `tui/tui-shell.test.ts` 12) sum to
  exactly 34, across exactly 12 files — matching AC8's "12 test files, 34
  read sites" and the doc's own updated summary line. `mcp-servers/
  invariants.test.ts` dropped off the manifest entirely (it moved from a
  source-text audit to the live directory scan AC1 covers) — consistent
  with the count drop. The `decideJoinAdoption` row was changed from "4
  tests" to "1 test: a destroyed join leaves rather than adopting", with an
  explicit correction note that the other three (client resync,
  `busInbox`/`busAck` merge-on-success, `selAtJoin` capture) need the
  separate `buildBusJoinOptions`/`attemptBusJoin` seam — this reads as an
  honest correction, not a rounding change, since the note names exactly
  which three tests it no longer claims. **AC8 and AC9 hold.**
- AC10: the "seam each one waits on" table in the same doc is still present
  for every unconverted audit (`approval-wiring.test.ts:45` and `:93`, the
  `consecutiveAutoWakes` double-tested decision, `buildBusJoinOptions`/
  `attemptBusJoin`, `buildBusWakeOptions`, etc.), each with a stated reason.
  The "single owner, not parallel agents" language for
  `approval-wiring.test.ts` is not in the requirements doc itself, but IS
  present, verbatim in substance, in the flow's own `description.md` ("Out
  of Scope": "`approval-wiring.test.ts`. Its seam has to reach into both
  god-files at once, which needs one owner rather than two working in
  parallel."). Read literally, AC10 is satisfied by the flow package
  recording it; noted here as a minor location ambiguity rather than a
  finding, since AC10 does not name a specific file. **AC10 holds** on that
  reading.
- AC11: `gh pr view 631` (via `GH_TOKEN=$(gh auth token --user
  MrCipherSmith)`, since the active `gh` account is read-only) shows every
  status check `SUCCESS` (`typecheck-and-tests`, all four client-matrix
  legs, `standard-baseline`, `standard-pr`, all four `opentui native` legs,
  both real-host/sandbox legs, `dependency-audit`, `metrics-contract`,
  `vscode-extension`, `mkdocs build --strict`, wiki validate) except `deploy
  to GitHub Pages`, which is `SKIPPED` (docs-deploy job, gated on branch,
  unrelated to this change). **AC11 holds.** Noted as a process gap, not a
  code finding: `flow.json`'s `acConfirmed` only recorded AC1-AC10 before
  this review — AC11 had never been confirmed via `keryx flow ac confirm`
  even though the flow was already `implemented`. Confirmed it during this
  review (`keryx flow ac confirm 278 AC11 --note "..."`) with the `gh`
  evidence above, since the completion gate requires every ACn confirmed
  and the underlying fact was independently verifiable and true.
- Did NOT deeply re-derive every assertion in the large test-file diffs
  (`src/commands/shell-agent-repl.test.ts` +718/-0, `src/commands/shell.test.ts`
  395 lines changed, `src/tui/tui-shell.test.ts`, `src/tui/tui-bus.test.ts`,
  `src/tui/tui-hold.test.ts`, `src/tui/bus-join.test.ts`,
  `src/tui/bus-wake.test.ts`) beyond the specific hunks cited above that
  bear directly on an AC. These are test-only changes, CI is green
  (AC11, independently verified via `gh`, not merely quoted from the PR),
  and the flow's own `shell-source-audits.test.ts` (unchanged by this
  commit) enforces the manifest/live-scan agreement that AC8/AC9 claim.
- Did NOT review the many `.metaproject/flows/275-*`,
  `.metaproject/flows/276-*` and `.metaproject/flows/277-*` review-package
  files this squash commit also carries (bundled in from earlier local
  commits on this branch) — they are historical flow bookkeeping, not part
  of flow 278's own change, and outside this review's ownership
  (`.metaproject/` review scope is flow 278's own package).

## Findings

None. Every production edit in this commit was read directly and matches
one of: the single stated behaviour fix (`serve.ts`, verified idempotent and
correctly guarded), an `export`, an optional injected dependency whose
default reproduces prior behaviour (verified against the unmodified
`src/lib` signatures it threads through to), or code moved unchanged behind
a new function (verified by diffing moved bodies against their extracted
functions, not by trusting the commit message). All eleven acceptance
criteria hold against the code and against independently-checked CI
evidence.

```json keryx:findings
[]
```
