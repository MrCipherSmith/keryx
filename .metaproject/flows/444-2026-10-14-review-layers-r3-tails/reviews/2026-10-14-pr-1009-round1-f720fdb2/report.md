# PR 1009 — review round 1

**Verdict: mergeable once R1-01 is fixed or accepted by the operator; nothing blocks the design.** No blockers. One major by judgement (R1-01: an explicit refresh inside the retry window silently returns the cached failure) and one finding that `severity-audit` raises to major by rule (R1-02: the surviving mutant `ac2-unreadable-page-dropped`, filed as minor here). Both have small fixes. The signal handling, the retry clock and the persistence of `failedAt` held up.

## Summary

Head `f720fdb2be39671e82ff806a01fa41d620129b77`, merge base `060701ca`. Review id `2026-10-14-pr-1009-round1-f720fdb2`, mode all, scope A+B, flow 444 (groups A and B, the round-3 tails of PR 1006), worktree `/home/altsay/keryx-f444`, branch `flow-444-review-layers-r3-tails`.

Findings: 10 filed before the audit: 0 blocker, 1 major, 5 minor, 4 info. After `severity-audit` R1-02 is expected to become major, so 2 major, 4 minor, 4 info.

The focused test command passes (101 pass, 0 fail, 6 files). The author's own mutation run (flow evidence, `mutation/survivors.md`) killed 21 of 22 mutants. This round re-ran the surviving one and added three mutants for the retry window.

Mutation pass (focused command `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts`, baseline green, exit 0): 4 mutants, 3 killed, 1 survived.

| Mutant | Where | Result |
|---|---|---|
| ac2-unreadable-page-dropped | src/review/layers-payload.ts:176 | survived |
| r1-failedat-ignored | src/review/layers.ts:193 | killed |
| r1-failedat-not-persisted | src/review/layers.ts:427 | killed |
| r1-window-never-expires | src/review/layers.ts:194 | killed |

The survivor backs R1-02.

### Focus questions, answered

1. **`ac2-unreadable-page-dropped`: dead guard or real race?** A real guard, not dead code. `collectPages` (`src/wiki/collect.ts:46`) already throws `WikiCollectionError` for a page it cannot read, and `WikiPage` carries no content, so `wikiFor` reads each page again. That second `readFile` can fail only when a page disappears or changes mode between the two reads. A test cannot reach that state without a reader seam, which is why the mutant survives. Filed as R1-02.
2. **Signal re-raise and cleanup ordering in `refreshLayers`.** The re-raise is correct. The handlers are removed first, the registered cleanups run in parallel, the lock is removed, then `process.kill(process.pid, signal)` ends the process by the signal; a second signal during the cleanup meets the default handler. One ordering gap: `withDetachedWorktree` calls `unregister()` before `await cleanup()` (R1-03). An executed probe (SIGTERM while the post-build `git worktree remove` was running) left two registered worktrees and a `keryx-layers-*` directory. The next refresh's `sweepStaleWorktrees` reaps them after `WORKTREE_SWEEP_AGE_MS`. A hung cleanup is not bounded (R1-06).
3. **Failed-head retry window.** The clock is `deps.now()`, injected and used both to write `failedAt` and to read it. `failedAt` is persisted in `layers.json`, and a reused failed record keeps its first value, so the window does not slide. `--force` and a new head bypass it. Mutation confirms the three parts are pinned. The weak point is not the clock but the way out: R1-01.

## Findings by severity

- Major: R1-01.
- Minor: R1-02 (raised to major by the audit), R1-03, R1-04, R1-05, R1-06.
- Info: R1-07, R1-08, R1-09, R1-10.

### R1-01 — major — `src/review/layers.ts:581` — an explicit refresh inside the window returns the cached failure with no hint

Locator: derived, exact. Quote: `} else if (input.force !== true && sameHead && failedRecently(existing as LayersFile, deps.now())) {`

**Problem.** `refreshLayers` skips the build when `force` is not set, the head is the same and `failedRecently` holds. Three callers cannot pass `force`, and no message gives a way out:

- `ensurePackageLayers` has no `force` option (`src/commands/review-layers.ts:66-84`), and `layers block` calls it (`:136`).
- The TUI refresh runs `layers refresh --package <dir> --json` with no `--force` (`src/tui/review-layers-actions.ts:25`).
- The error is `the package graph is failed: <error>` (`src/review/layers.ts:629`), and the detail view prints `graph: failed — <error>` (`src/review/layers-view.ts:37`). Neither says the failure is cached, from when, or that `--force` retries.

**Impact.** Trigger: a transient build failure (disk full, a git lock, a network share); the operator fixes the cause and presses refresh in the TUI or runs `layers block`. Outcome: for up to five minutes the old error comes back with no retry and no hint why. Only the CLI help documents the window, and only the CLI `refresh` can pass `--force`.

**Suggested fix.**
- Pass `force: true` from the TUI refresh argv, because an operator pressing refresh means it.
- Add the window and `--force` to the `PackageGraphError` message and to the `graph:` line (`failed at <time>; retried automatically after 5 minutes, or run refresh --force`).
- Let `ensurePackageLayers` take a `force` option for callers that mean it.

**class_scope.**
- sites: `src/review/layers.ts:581`, `src/review/layers.ts:629`, `src/commands/review-layers.ts:66`, `src/commands/review-layers.ts:136`, `src/tui/review-layers-actions.ts:25`, `src/review/layers-view.ts:37`
- enumeration_method: `keryx ctx rg -n "failedRecently|ensurePackageLayers|layersRefreshArgv|PackageGraphError" src --glob '!*.test.ts'`; every caller of `refreshLayers` read.

**Evidence.** Traced by reading the three call paths. The tests pin `ensurePackageLayers` inside the window and `--force` only. Not executed.

### R1-02 — minor, raised to major by the audit — `src/review/layers-payload.ts:176` — the unreadable-page guard is not pinned

Locator: derived, exact. Quote: `unreadable.push(page.relativePath);`

**Problem.** The per-page guard in `wikiFor` that records an unreadable wiki page is not pinned: deleting it leaves the focused suite green. The guard is real (see focus question 1), but no test can reach that state without a reader seam.

**Impact.** Trigger: a page disappears or loses its mode between `collectPages` and the second `readFile`. Outcome: with the guard gone the page is dropped without a word and the section is reported as read with fewer items. This is the silent-empty case AC2 exists to prevent, and no test would notice a regression.

**Suggested fix.** Either give `wikiFor` a `readPage` seam defaulting to `readFile` and pin the message `N of M wiki page(s) could not be read — <pages>`, or have `collectPages` return the content it already read, so the second read and the guard disappear together.

**class_scope.**
- sites: `src/review/layers-payload.ts:176`, `src/review/layers-payload.ts:184`
- enumeration_method: `keryx ctx rg -n "readFile|unreadable" src/review/layers-payload.ts`; the only per-item read that follows a collection step.

**Evidence.** `mutant:ac2-unreadable-page-dropped` survived a recorded run on `src/review/layers-payload.ts` (`research-evidence/mutation-1.md`, exit 0). The author accepted it in `survivors.md` ("can only fail if a page disappears or changes mode between collectPages and the read … Accepted, not pinned").

### R1-03 — minor — `src/review/layers.ts:409` — the worktree is unregistered before its removal runs

Locator: derived, exact. Quote: `unregister();`

**Problem.** `withDetachedWorktree` ends with `unregister(); await cleanup();` (`:409-410`). A signal that arrives while the awaited `git worktree remove` runs finds no registered cleanup, so the handler removes the lock and re-raises while the removal is cut off.

**Impact.** Trigger: SIGTERM or SIGINT during the post-build worktree removal. Outcome: the worktree registration and the `keryx-layers-*` temp directory stay until the next refresh sweeps them after the sweep age. Bounded.

**Suggested fix.** Await `cleanup()` first and unregister in a nested `finally`, so the registered cleanup stays visible to the handler while it runs. The cleanup is idempotent.

**Evidence.** Executed probe (`order-probe.test.ts`): `git worktree remove` held for 400 ms, SIGTERM sent while it ran. Afterwards 2 registered worktrees and a leftover `keryx-layers-*` directory.

### R1-04 — minor — `src/review/layers-payload.ts:353` — the text block does not use the format AC2 states

Locator: derived, exact. Quote: ``for (const gap of block.unavailable) lines.push(`  unavailable ${gap.section}: ${gap.reason}`);``

**Problem.** AC2 says the text block prints `<source>: unavailable (<reason>)`. The code prints `  unavailable <section>: <reason>`. The JSON side matches.

**Impact.** The operator confirms AC2 against wording the code does not produce; a reader or script keyed to the AC text does not match.

**Suggested fix.** Change the line to `  <section>: unavailable (<reason>)` and update the test, or amend AC2 with `keryx flow ac update` before it is confirmed.

**Evidence.** `layers-payload.ts:353` against `acceptance-criteria.md` AC2. Not executed.

### R1-05 — minor — `src/review/layers-signal.test.ts:20` — the signal test covers four of the five phases AC1 names

Locator: derived, exact. Quote: `const PHASES: Record<string, string> = {`

**Problem.** AC1 lists recover, build, wiki, memory and the `layers.json` write, and says each. `PHASES` has the sweep that follows the lock, the build, the wiki and the memory. No phase stops inside `recoverGraphDirectory` or at the `layers.json` write.

**Impact.** A regression that narrows the handler scope to the build-side phases, or that leaves the lock when the signal lands during the final write, passes the suite. In those two phases no worktree exists, so the handler is the only guard on the lock.

**Suggested fix.** Add a phase for the `layers.json` write (a `writeFileAtomic` seam or a hook in deps) and one for recover, or reword AC1 to the four phases tested.

**Evidence.** `layers-signal.test.ts:20-24` against AC1; `layers.ts:573` and `:605`. Not executed.

### R1-06 — minor — `src/review/layers.ts:362` — a hung cleanup delays death by signal with no bound

Locator: derived, exact. Quote: `void Promise.all([...cleanups].map((cleanup) => cleanup().catch(() => {})))`

**Problem.** The handler awaits every registered cleanup with no timeout.

**Impact.** Trigger: SIGTERM while `git worktree remove` blocks. Outcome: the process does not die by the signal until git returns. A second signal (the handlers were removed first) or SIGKILL still ends it, so this is a delay, not a leak.

**Suggested fix.** Race the cleanups against a short timer (a few seconds) before the lock removal and the re-raise.

**Evidence.** `layers.ts:358-366`. Not executed.

### R1-07 — info — `src/review/layers.ts:193` — the legacy fallback `failedAt ?? refreshedAt` lengthens the window

Locator: derived, exact. Quote: `const age = now.getTime() - Date.parse(existing.graph.failedAt ?? existing.refreshedAt);`

**Problem.** For a `layers.json` written before this change there is no `failedAt`, and `refreshedAt` follows the failure by the wiki and memory time.

**Impact.** The window is a little longer for such a file. Bounded and one-off.

**Suggested fix.** None.

**Evidence.** `layers.ts:193`. Mutant `r1-failedat-ignored` was killed, so the primary path is pinned.

### R1-08 — info — `src/review/layers-round3.test.ts:16` — round ids remain in test names beyond the file AC6 names

Locator: derived, exact. Quote: `describe("the throwaway checkout is made without the operator's hooks or fsmonitor (R3-21)", () => {`

**Problem.** `layers-round3.test.ts`, `(R1-01)` to `(R1-19)` in `layers-isolation.test.ts` and `layers-payload.test.ts`, `(R3-03)` in `layers-usage.test.ts` and "round 1" in `layers.test.ts:23`.

**Impact.** AC6 names only `layers-round2.test.ts`, so it is met as written; the other names stay unreadable without the review packages.

**Suggested fix.** Rename after behaviour in a follow-up.

**Evidence.** `layers-round3.test.ts:16`; `layers-isolation.test.ts:32, :53, :135, :173`; `layers-payload.test.ts:108, :124, :131`; `layers-usage.test.ts:29, :37, :44`.

### R1-09 — info — `src/tui/review-layers-actions.ts:53` — `killed` is also true for a `maxBuffer` overflow

Locator: derived, exact. Quote: `if (error?.killed === true) {`

**Problem.** `execFile` sets `killed` when it kills the child for a `maxBuffer` overflow as well as for the timeout, and the message then says the refresh "did not finish within Ns".

**Impact.** A misleading message in a rare case; the output is `--json` of bounded size.

**Suggested fix.** Check `error.signal` and the elapsed time, or name both causes in the message.

**Evidence.** `review-layers-actions.ts:53`. Not executed.

### R1-10 — info — `src/gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json:263` — the `unavailable` enum lists sections never produced, and the project-local schema copy diverges

Locator: derived, exact. Quote: `"unavailable": {`

**Problem.** The enum lists `symbols` and `relatedTests`, but `buildLayersBlock` emits only `affected`, `wiki` and `memory`. `relatedTests` is derived from `affected` and is empty, with no flag of its own, when `affected` fails. The project-local copy `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-input.schema.json` was not changed and diverges from the bundled one.

**Impact.** A consumer may wait for sections that never appear; the two copies drift.

**Suggested fix.** Trim the enum to `affected`, `wiki` and `memory`, or emit the other two. Sync the project-local copy through the usual projection step.

**Evidence.** Schema diff `@@ -259,6 +259,19 @@`; `layers-payload.ts:263-265`.

## Scope, omissions and residuals

- Scope A is the PR diff against `060701ca` (`scope.json`, from `keryx review scope --ref 060701ca --json`). Scope B is the blast radius (`blast-radius.json`).
- The blast radius is partial. 13 of 53 candidate files were not reviewed (cap `blast_radius_max_files=40`), a known residual, not filed. 14 changed files are absent from the code graph (Markdown, JSON, CHANGELOG, the schema), so their dependents are unknown, not empty.
- Not run: the full `bun run check` (the same checks run on GitHub); the nine-reviewer dispatch and the Wave C verifier (see below).
- No comment was posted on GitHub; this package records the round only.
- Known residuals taken from the flow, not filed: the scope-B cap, and flow-444 groups C and D, which come later.

## How this review was run

- Pipeline: the review-orchestrator pipeline of `vantage-review` (Keryx projection `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md`), mode all, scope A+B, run inside one worker fork.
- **Reviewers and verifier were inline, not dispatched.** The fork has no Agent tool. One reviewer read the diff through five lenses (logic, testing-practices, highload, style, architecture); the `reviewer` field of each finding names the lens that produced it. The other lenses of mode all (clean-code, performance, regression, security-code) were not run as separate passes, and no independent Wave C verifier tried to delete a finding. This is a weaker round than a dispatched one. The findings that matter were checked by execution or by mutation instead.
- Evidence: the focused command passed (101 pass, 0 fail). The ordering probe behind R1-03 was executed. Mutation: `keryx review mutate` with the full focused command, 4 mutants, 3 killed, 1 survived, evidence in `research-evidence/mutation-1.json` and `mutation-1.md`. R1-01 was traced by reading, not executed.
- Routing audit: graph_used yes (blast radius), wiki_used not-relevant, ctx_used yes, raw_rg_used no (bounded `awk` and `git grep` with a stated raw marker only for exact quote lines).

Evidence level: static plus the mutation run (focused command, 4 mutants). One finding (R1-03) was reproduced by an executed probe. No verifier wave.

## Findings

```json keryx:findings
[
{"id":"R1-01","reviewer":"review-logic","severity":"major","problem":"An explicit refresh inside the five-minute failed-head window is served from the cached failure, and nothing tells the operator. refreshLayers skips the build when force is not set, the head is the same and failedRecently() holds. ensurePackageLayers has no force option, the TUI refresh argv has no --force, and both the PackageGraphError message and the detail view print only the old error, with no mention of the window or of --force.","impact":"Trigger: a transient build failure (disk full, git lock, network share), the operator fixes the cause and presses refresh in the TUI or runs layers block. Outcome: for up to five minutes the old error comes back with no retry and no hint why; only the CLI help documents the window, and only the CLI refresh can pass --force.","suggested_fix":"Pass force: true from the TUI refresh argv; add the window and --force to the PackageGraphError message and to the graph: line of the detail view (failed at <time>, retried automatically after 5 minutes, or run refresh --force); let ensurePackageLayers take a force option for callers that mean it.","evidence":"Traced by reading: layers.ts:581 and :629; review-layers.ts:66-84, :107 and :136; review-layers-actions.ts:25; layers-view.ts:37. The tests pin ensurePackageLayers inside the window and --force only. Not executed.","confidence":"high","file":"src/review/layers.ts","line":581,"quote":"} else if (input.force !== true && sameHead && failedRecently(existing as LayersFile, deps.now())) {","locator":{"state":"derived","method":"exact","reported_line":null},"class_scope":{"sites":["src/review/layers.ts:581","src/review/layers.ts:629","src/commands/review-layers.ts:66","src/commands/review-layers.ts:136","src/tui/review-layers-actions.ts:25","src/review/layers-view.ts:37"],"enumeration_method":"keryx ctx rg -n \"failedRecently|ensurePackageLayers|layersRefreshArgv|PackageGraphError\" src --glob '!*.test.ts'; every caller of refreshLayers read"}},
{"id":"R1-02","reviewer":"review-testing-practices","severity":"minor","problem":"The per-page guard in wikiFor that records an unreadable wiki page is not pinned: deleting it leaves the focused suite green. The guard is real (collectPages already read every page, so only a page removed or chmod-ed between the two reads reaches it) but no test can reach that state without a reader seam.","impact":"Trigger: a page disappears or loses its mode between collectPages and the second readFile. Outcome: with the guard gone the page is dropped without a word and the section is reported as read with fewer items, the exact silent-empty case AC2 exists to prevent, and no test would notice a regression.","suggested_fix":"Give wikiFor a readPage seam defaulting to readFile and pin the message 'N of M wiki page(s) could not be read', or have collectPages return the content it read so the second read and the guard disappear together.","evidence":"mutant:ac2-unreadable-page-dropped survived a recorded run on src/review/layers-payload.ts (research-evidence/mutation-1.md, exit 0); the author accepted it in survivors.md as not pinned.","confidence":"high","file":"src/review/layers-payload.ts","line":176,"quote":"unreadable.push(page.relativePath);","locator":{"state":"derived","method":"exact","reported_line":null},"class_scope":{"sites":["src/review/layers-payload.ts:176","src/review/layers-payload.ts:184"],"enumeration_method":"keryx ctx rg -n \"readFile|unreadable\" src/review/layers-payload.ts; the only per-item read after a collection step"}},
{"id":"R1-03","reviewer":"review-highload","severity":"minor","problem":"withDetachedWorktree unregisters its cleanup before awaiting it. A signal that arrives while the awaited git worktree remove runs finds no registered cleanup, so the handler removes the lock and re-raises while the removal is cut off.","impact":"Trigger: SIGTERM or SIGINT during the post-build worktree removal. Outcome: the worktree registration and the keryx-layers temp directory are left behind until the next refresh sweeps them after the sweep age.","suggested_fix":"Await cleanup() first and unregister in a nested finally, so the registered cleanup stays visible to the handler for as long as it runs; the cleanup is idempotent.","evidence":"Executed probe (order-probe.test.ts): git remove held for 400 ms, SIGTERM sent while it ran; afterwards 2 registered worktrees and a leftover keryx-layers-* directory. layers.ts:409-410.","confidence":"high","file":"src/review/layers.ts","line":409,"quote":"unregister();","locator":{"state":"derived","method":"exact","reported_line":null}},
{"id":"R1-04","reviewer":"review-logic","severity":"minor","problem":"The text block prints '  unavailable <section>: <reason>' while AC2 states the format '<source>: unavailable (<reason>)'.","impact":"The operator confirms AC2 against wording the code does not produce; a reader or script keyed to the AC text does not match.","suggested_fix":"Change the line to '  <section>: unavailable (<reason>)' and update the test, or amend AC2 with keryx flow ac update before it is confirmed.","evidence":"layers-payload.ts:353 against acceptance-criteria.md AC2. Not executed.","confidence":"high","file":"src/review/layers-payload.ts","line":353,"quote":"for (const gap of block.unavailable) lines.push(`  unavailable ${gap.section}: ${gap.reason}`);","locator":{"state":"derived","method":"exact","reported_line":null}},
{"id":"R1-05","reviewer":"review-testing-practices","severity":"minor","problem":"layers-signal.test.ts stops the child in four places (sweep after the lock, build, wiki, memory); AC1 names five phases and says each. No phase stops in recoverGraphDirectory or at the layers.json write.","impact":"A regression that narrows the handler scope to the build-side phases, or that leaves the lock when the signal lands during the final write, passes the suite.","suggested_fix":"Add a phase for the layers.json write (a writeFileAtomic seam or a hook in deps) and one for recover, or reword AC1 to the four phases tested.","evidence":"layers-signal.test.ts:20-24 against AC1; layers.ts:573 and :605. Not executed.","confidence":"medium","file":"src/review/layers-signal.test.ts","line":20,"quote":"const PHASES: Record<string, string> = {","locator":{"state":"derived","method":"exact","reported_line":null}},
{"id":"R1-06","reviewer":"review-highload","severity":"minor","problem":"The signal handler awaits every registered cleanup with no bound, so a hung git worktree remove keeps the process alive after SIGTERM.","impact":"Trigger: SIGTERM while git blocks. Outcome: the process does not die by the signal until git returns; a second signal or SIGKILL still ends it, so nothing leaks.","suggested_fix":"Race the cleanups against a short timer (a few seconds) before the lock removal and the re-raise.","evidence":"layers.ts:358-366. Not executed.","confidence":"medium","file":"src/review/layers.ts","line":362,"quote":"void Promise.all([...cleanups].map((cleanup) => cleanup().catch(() => {})))","locator":{"state":"derived","method":"exact","reported_line":null}},
{"id":"R1-07","reviewer":"review-logic","severity":"info","problem":"The legacy fallback failedAt ?? refreshedAt makes the window a little longer for a layers.json written before this change, because refreshedAt follows the failure by the wiki and memory time.","impact":"Bounded and one-off; no action needed.","suggested_fix":"None.","evidence":"layers.ts:193. Mutant r1-failedat-ignored was killed.","confidence":"high","file":"src/review/layers.ts","line":193,"quote":"const age = now.getTime() - Date.parse(existing.graph.failedAt ?? existing.refreshedAt);","locator":{"state":"derived","method":"exact","reported_line":null}},
{"id":"R1-08","reviewer":"review-style","severity":"info","problem":"Round ids remain in test names beyond the file AC6 names: layers-round3.test.ts, R1-nn in layers-isolation and layers-payload tests, R3-03 in layers-usage.test.ts.","impact":"AC6 is met as written (layers-round2 only); the other names stay unreadable without the review packages.","suggested_fix":"Rename after behaviour in a follow-up.","evidence":"layers-round3.test.ts:16; layers-isolation.test.ts:32, :53, :135, :173; layers-payload.test.ts:108, :124, :131; layers-usage.test.ts:29, :37, :44.","confidence":"high","file":"src/review/layers-round3.test.ts","line":16,"quote":"describe(\"the throwaway checkout is made without the operator's hooks or fsmonitor (R3-21)\", () => {","locator":{"state":"derived","method":"exact","reported_line":null}},
{"id":"R1-09","reviewer":"review-logic","severity":"info","problem":"error.killed is also true when execFile kills the child for a maxBuffer overflow, and the message then reports a timeout.","impact":"Rare; a misleading message only.","suggested_fix":"Check error.signal and the elapsed time, or name both causes in the message.","evidence":"review-layers-actions.ts:53. Not executed.","confidence":"medium","file":"src/tui/review-layers-actions.ts","line":53,"quote":"if (error?.killed === true) {","locator":{"state":"derived","method":"exact","reported_line":null}},
{"id":"R1-10","reviewer":"review-architecture","severity":"info","problem":"The bundled reviewer-input schema lists unavailable sections (symbols, relatedTests) that buildLayersBlock never emits, relatedTests is empty without a flag when affected fails, and the project-local copy of the schema was not updated and diverges from the bundled one.","impact":"A consumer may wait for sections that never appear; the two schema copies drift.","suggested_fix":"Trim the enum to affected, wiki and memory, or emit the other two; sync the project-local copy through the usual projection step.","evidence":"reviewer-input.schema.json diff at 263-275; layers-payload.ts:263-265.","confidence":"medium","file":"src/gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json","line":263,"quote":"\"unavailable\": {","locator":{"state":"derived","method":"exact","reported_line":null}}
]
```
