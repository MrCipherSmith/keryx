# Source-text audits of the two shell god-files

Every test that reads `src/tui/tui-shell.ts` or `src/commands/shell.ts` as
**text**, what behaviour each assertion actually protects, and what it should
become.

This is the working specification for P2 (see [README](README.md) for the
four-PR shape). It is not a summary: P2's job is to turn each row in the detail
files into a behavioural test, and where the behaviour is not observable, to
add the seam that makes it observable.

Scanned at flow 276, against `origin/main` at `398acb4a`: 16 test files, 46
read sites. Rescanned at flow 275 (agent bus P4), against the
`feat/agent-bus-p4-pause-leases` branch, after P4's T8 held-turn wiring added
four audit blocks to `commands/shell.test.ts` and its own
`tui/tui-hold.test.ts` — see [audits-commands.md](audits-commands.md) and
[audits-tui-other.md](audits-tui-other.md). 17 test files, 51 read sites.

**P2 is converting these. Current: 15 test files, 38 read sites** — flow 303
(keryx help) added four new source-text sites while its own review round was
still open: `commands/shell-starting-line.test.ts` (pins the pre-renderer
"keryx: starting…" print's `chooseShellSurface` gate), `tui/busy-dispatch.test.ts`
(pins that the busy-branch "help" case opens the help modal rather than a
static notice), `tui/help-first-run.test.ts` (pins that `resolveFirstRunHelp`
is dispatched as a background task, never awaited inline), and a second site
in `tui/boot-animation.test.ts` (pins that `opts.makeAgentDeps`/
`createShellChrome` are wrapped in try/finally around the startup indicator).
All four are genuinely structural at the moment they were written — none of
the three properties above has an exported seam yet — the
manifest at the bottom is the live count, checked by
`src/shell-source-audits.test.ts`, and it is the progress signal. Converted so
far: `/goal`, `/plan` and `/reasoning` (including T26's configDir threading)
now drive the real `runAgentRepl`; the flow-173 F-003 deny-list tests import
the exported Set; and `theme-picker`, `subagent-inspector` and `session-info`
have dropped to zero read sites because their structural audits now scan
`src/tui/**` instead of one file, which is what lets them survive P3 rather
than be broken by it.

Flow 304 (`/connect`'s Test/Disconnect row buttons) added one more site:
`tui/connect-provider-buttons.test.ts` pins that the `/connect` command
handler's `onDisconnected` callback compares the disconnected provider's name
against the session's own `currentSel.provider` and prints the operator-facing
line, rather than forcing a provider switch — that comparison lives inside
`launchTuiAgentShell`'s closure with no exported seam, the same reason the
other rows in this table exist. The row-list step's OWN contract (`onDisconnected`
fires with the right name, exactly once, only on a confirmed disconnect) is
proven behaviourally in the same file, driving the real `selectProviderModelInTui`
— only the closure-internal session comparison needed a text audit.

### What the count does and does not measure

The manifest counts **files coupled to the two paths**, not assertions coupled
to their text. Those are different, and the exit-sequence work (flow 277) is
the case that shows it.

Extracting `performSlateExit` / `leaveBusThenRelease`
(`src/tui/shell-exit.ts`) moved six audits across three files off character
offsets and multi-line sequences and onto a single symbol, and moved the
property they stood for — the order the steps actually run in, and that each
async step is awaited — into `shell-exit.test.ts`, where it runs against the
real function. The count did not move at all: those files still open
`tui-shell.ts`, they just ask it something far more stable.

So read the count as "how much is still pinned to this file", and the detail
files for whether what remains is a sequence, an offset comparison, or one
symbol. A split breaks the first two; the third survives it.

## The detail

| file | covers |
|---|---|
| [audits-tui-shell.md](audits-tui-shell.md) | `src/tui/tui-shell.test.ts` — 14 audit blocks, ~75 tests. The bulk of the work. |
| [audits-tui-other.md](audits-tui-other.md) | The other seven TUI test files: session lease, bus, next-step suggestion, boot animation, theme picker, subagent inspector, session info. |
| [audits-commands.md](audits-commands.md) | The five `src/commands/` test files that read `shell.ts`. |
| [audits-cross-cutting.md](audits-cross-cutting.md) | `mcp-servers/approval-wiring.test.ts` and `mcp-servers/invariants.test.ts`, which reach both files through a helper — plus the coverage sweep for path-coupled tests and non-test references. |

Every row carries six things: the technique, the exact literal or window, the
behaviour it protects stated as what a user would see go wrong, whether that
behaviour is observable today, the concrete conversion, and the cosmetic edit
that breaks the audit as written.

Each audit is one of three kinds. A row's kind is read from its columns rather
than carried as a separate label: **observable today = `yes`** is behavioural,
**`no — needs seam`** or **`partial`** is a seam and the conversion column names
it, and the **structural** ones are listed by name in each detail file's Notes
because they are the exception — they are not converted at all.

- **behavioural** — the behaviour is reachable now through an exported function
  or an injected dependency; the audit can be replaced outright.
- **seam** — the behaviour is real but buried in a closure; P2 extracts the
  named module first, following `src/tui/bus-wake.ts` and
  `src/tui/bus-command.ts`.
- **structural** — a genuine statement about source structure ("this file must
  never import the Track B wrap-up composer"). These stay text audits. P2
  rewrites them to assert over the *module folder* rather than one file, so
  they survive P3 instead of being deleted by it.

## What P2 must not miss

Six findings cut across the detail files. They are the reason this inventory
exists rather than a list of line numbers.

### Most of `shell.test.ts` asserts over the wrong region

Nearly every audit block in `shell.test.ts` and `shell-bus.test.ts` narrows the
source to the REPL before asserting:

```js
const replBody = shellSource.slice(
  shellSource.indexOf("async function runAgentRepl("),
  shellSource.indexOf("if (agentMode) {"),
);
```

`runAgentRepl` starts at `shell.ts:1432` and its closing brace is at `:2625`.
`if (agentMode) {` is at `:3705`. So `replBody` is about **1,080 lines wider
than the function it claims to be** — it also contains `resolveTuiStartup`,
`parseShellCliFlags`, `chooseShellSurface`, and the whole TUI branch of
`shellCommand`, including `makeAgentDeps` at `:3187`.

This is not fragility, it is a correctness defect in the tests. An assertion
that reads "`runAgentRepl` wires X" passes when the *TUI branch* wires X and
the REPL does not. And it is the direct explanation of the agent-bus breakage
the split was blocked on: a count of `makeAgentDeps` call sites "inside
`runAgentRepl`" was really counting call sites in a region `runAgentRepl` does
not occupy.

One block gets it right — flow 268 T26 (`shell.test.ts:1696`) bounds the window
at the `TuiStartup` doc comment instead. P2 should not fix the window; it
should remove the need for one.

### `runAgentRepl` is unexported, and that is the whole blocker

`runShell` (`shell.ts:601`) is exported and already driven behaviourally by
`shell-bus.test.ts` and `shell-lease.test.ts` with fake `lines` and fake
`deps`. `runAgentRepl` takes essentially the same injection shape — `lines`,
`rich`, `deps: AgentDeps`, `sessionOpts`, `slateSessionBox`, `events`,
`configDir`, `orient` — and every dependency the audits want to observe arrives
through it.

The only thing standing between those audits and real behavioural tests is the
missing `export` keyword. That one change converts the large majority of the
`shell.ts` rows, using a pattern already proven in the same directory.

Two caveats for P2: `loadShellPermissions()` / `shellPermissionsFingerprint()`
read the real on-disk permissions file with no directory parameter, and the
spinner consults TTY state. None of the audits touch that logic, but a
hermetic test that strays into it needs a second seam.

### One audit fails silently instead of loudly

`mcp-servers/invariants.test.ts:114` asserts that no production file registers
a teardown handler with `process.once`, because a `once` handler lets a second
Ctrl-C during teardown fall through to Node's default disposition and kill the
parent mid-teardown, orphaning the child. It scans `src/mcp-servers/*.ts` plus
a **hardcoded** two-entry list that includes `../commands/shell.ts`.

`shell.ts` registers those handlers at `:3588` and `:3593`. If P4 moves them
into a submodule, this test does not fail — the new file is not in its list, so
it quietly stops covering them, and a later `once` regression there ships
undetected.

Every other audit in this inventory breaks loudly. This one goes quiet, which
is worse. It has to be converted before P4 moves anything.

### The ordering assertions stand for something real

`approval-wiring.test.ts:45` compares character offsets:
`"if (isMcpToolCall(tool)) {"` must appear before `"evaluateShellApproval({"`,
in **both** files. A comparison of character offsets is meaningless once the
two anchors live in different modules — and it is tempting to read that as "the
assertion is worthless".

It is not. Traced through the code: the MCP branch at `shell.ts:1722` returns
before the evaluator at `:1756`, and the only write to the operator's on-disk
permission file is `rememberExactShellGrant` at `:1801`, reachable only through
the evaluator's `always && approved` branch. So the property is real and worth
a test:

> An MCP tool call can never write a model-supplied grant pattern into the
> operator's permission store.

That is the F-032 defect, and it is testable with a spy on the store and no
character offsets at all. The approval callback is buried inside `runAgentRepl`,
so this one needs a seam.

`approval-wiring.test.ts:93` is a second ordering assertion, and note it checks
`commands/shell.ts` only — the TUI surface is not scanned by it.

### The same decision is tested twice, one way each

`consecutiveAutoWakes` is a bare `let` at `tui-shell.ts:5735`, reset at `:5753`,
and incremented from two places:

- `:6801` — the **bus** wake. Extracted into `src/tui/bus-wake.ts` during flow
  274 and covered by more than twenty real tests driving an injected counter
  and cap.
- `:6776` — the **task-completion** wake. Still inline, and pinned only as text
  by `tui-shell.test.ts:3303`.

Same decision, same counter, same cap; one half properly tested, the other half
asserted as a string. Generalising the existing controller covers both and
removes a duplicated decision. This is the cheapest real win in the inventory.

### Four hand-maintained copies of the exit sequence

`tui-shell.ts` leaves the bus, releases the session lease and sweeps background
jobs at four separate exit paths: `onDestroy` (`:3107`, sweep at `:3133`), the
busy-menu `case "exit"` (`:5804`-`:5807`), the `/exit` branch
(`:6018`-`:6020`), and the outer `finally` (`:6844`-`:6845`).

All four correctly leave the bus before releasing the lease (specification
§5.4). The *sweep* placement differs, and legitimately so — `onDestroy` is a
synchronous callback that cannot await, so its sweep is deferred, which the
code explains at `:3114`-`:3129`. That is exactly the kind of "same sequence,
one justified difference" a substring audit cannot express, and it is why six
tests across two files each pin their own copy.

Both the `tui-shell.test.ts` and the `tui-session-lease.test.ts` audits
converge on the same fix: one extracted exit helper, parameterised by whether
the caller can await, collapses six audits into one unit test plus trivial
call-site checks.

## Loose ends that are not tests

- **`src/commands/shell-task-tools.test.ts:385`** does
  `await import("../tui/tui-shell")` to read the exported
  `SIDE_WORKER_DENIED_TOOL_NAMES`. A real behavioural test, coupled to the
  module *path*, not to source text — so the manifest below does not list it. A
  compatibility entry point at `tui-shell.ts` keeps it working; without one it
  needs a one-line change.
- **`src/tui/shell-fallback.test.ts`** *is* in the manifest, but it is also
  path-coupled rather than text-coupled: it embeds the path in a generated
  launcher script and runs it in a real child process. The scan catches it
  because the file both reads files and names the path. A benign over-catch,
  recorded so P2 does not go looking for an assertion to convert.
- **`src/session/store.callers.test.ts`** is not in the manifest — it names
  both paths but reads the tree through a live `Glob("**/*.ts")` scan
  (`src/lib/config-dir.scan.ts`). Its core guard is filename-agnostic and needs
  no change for either split. Three hardcoded canary literals (`:140`, `:151`,
  `:153`) do.
- **`src/gdskills/bundled/rules/core/cli-interface-design.mdc:166`** cites
  `src/commands/shell.ts:1797-1798` in prose. It is a bundled rule shipped to
  agents, so unlike the many stale line references in older requirement
  packages, this one is worth re-pointing after P4.
- **No line-count or file-size budget exists** for either file anywhere in the
  repo. `eslint.config.mjs` is present and `bun run lint` runs it, but it
  configures no `max-lines`, `max-statements` or `complexity` rule, and
  `keryx health`'s LOC collector (`src/health/source-analysis.ts:33`) reports
  the number without asserting on it. A split has no budget to update in
  either direction.

## Corrections to earlier readings

Recorded because they were believed during this flow and are wrong:

- `subagent-inspector.test.ts:150` was flagged as checking its `hostImport`
  regex against the wrong file. It is not: `expect(tui).toMatch(hostImport)`
  reads the `tui-shell.ts` source, which is correct. No bug there.

## What P2 left, and the seam each one waits on

Flow 277 converted what its seams reached and stopped there. This is the list
the next flow starts from, so nobody has to re-read the files to rebuild it.

### Done in flow 277

| seam | where | unlocked |
|---|---|---|
| `export runAgentRepl` + `rich.write` | `src/commands/shell.ts` | `/goal`, `/plan`, `/reasoning`, configDir threading |
| `leaveBusThenRelease`, `performSlateExit` | `src/tui/shell-exit.ts` | the §5.4 exit ordering, pinned in three separate files |
| `buildNextStepPrompt` | `src/tui/next-step-suggestion.ts` | flow 268 AC12 (reasoning never reaches the advisor) |

### Still needed

The big one first, because most of the rest hangs off it.

**An injection point for `launchTuiAgentShell`.** It is one ~4,700-line
closure over roughly two dozen mutable locals, and nothing inside it is
reachable from a test. Every per-command audit in `tui-shell.test.ts` — the
`/goal`, `/plan`, `/reasoning`, `/think` and `/search-connect` wiring blocks —
waits on this, as does the `boot-animation` splash lifecycle. This is a flow of
its own, not a step in one.

Named, self-contained seams (from the flow 277 sweep of `tui-bus.test.ts`,
where two `describe` blocks hold ~28 tests):

| seam | shape | unlocks |
|---|---|---|
| `decideJoinAdoption({ destroyed, disabled })` | pure, mirrors `decideBusWake` | 1 test: a destroyed join leaves rather than adopting. **This row originally claimed four.** The other three — client resync, `busInbox`/`busAck` merged only on success, `selAtJoin` capture — need the separate `buildBusJoinOptions`/`attemptBusJoin` seam listed below, not this one. Corrected in flow 278 after the extraction showed what it actually reached. |
| `buildBusJoinCallbacks(deps)` → `{ onEvent, onPeers, onError }` | factory | 3 tests: bail-out when destroyed, inbox push, poll delivery reported to the wake controller |
| `buildBusJoinOptions(deps)` + `attemptBusJoin(deps)` | pure + async | 2 tests: join passes `surface: "tui"`, a join error never escapes |
| `buildBusWakeOptions(deps)` | pure over the closure's locals | 2 tests: the wake controller shares the idle test, and never treats a destroyed session as idle |
| `applySessionOpen(opened, { liveBus })` | shared helper | 3 tests: `applyOpened`, `startNewSession` and `resumeSessionInteractive` all sync `presence.sessionId` |
| `BUS_WAKE_CAPPED_NOTICE` exported constant | constant in `bus-wake.ts` | 1 test, outright — it stops reading `tui-shell.ts` at all |
| `buildDestroyHandler({ setDestroyed, … })` | factory | 1 test: `onDestroy` sets the destroyed flag |
| `onTurnSettled(next, deps)` | extracted | 1 test: turn settle triggers `onSettle` |
| `createBusClientRef(getLiveBus)` | one-line factory | 1 test: the ref is a live getter, not a captured value |
| `createSplashLifecycle` | `boot-animation.ts` | the splash mount/removal audit |
| `isToolAvailableToSideWorker(tool)` | pure predicate | the fourth flow-173 F-003 test (the other three are converted) |

### Two that need deciding, not just extracting

- **`mcp-servers/invariants.test.ts:114`** bans `process.once` for teardown
  handlers across a **hardcoded** file list naming `../commands/shell.ts`.
  Moving the registration at `:3588`/`:3593` into a submodule does not fail it
  — it silently stops covering it. Give it the directory-scan treatment the
  other structural audits got (`listSourceFiles`), and it stops being a
  hazard. **This one must land before P4 moves anything.**
- **`approval-wiring.test.ts:45`** compares character offsets in *both*
  files. The property is real — an MCP tool call must never reach
  `rememberExactShellGrant` and write a model-supplied grant pattern to the
  operator's permission file — but the approval callback lives inside
  `runAgentRepl`, so proving it needs a fake permission store injected there.

### Added by the DuckDuckGo rate-limit work (0.2.130)

One audit landed here rather than being counted silently, because the rule
above is that a new one has to be written down.

`harness/search/connection-message.test.ts` reads both god-files to count how
many call sites route a failed search through `describeConnectionFailure`: the
`/search-provider` wizard and the args-given branch in `tui-shell.ts`, and the
agent REPL in `commands/shell.ts`. The behaviour it protects is that a provider
rate limit is never reported as a generic "connection validation failed" on any
operator surface — the failure mode that sent an operator to retry the one
thing retrying cannot clear.

The `tui-shell.ts` half is ALSO covered behaviourally: `tui-shell.test.ts`
drives the real wizard and asserts the rate-limited frame, so that half can go
when the `launchTuiAgentShell` seam this document already names lands. The
`commands/shell.ts` half cannot — the REPL's `/search-provider` output has no
injection point, which is the same missing seam.

### Added by the persistent execution-plan panel

`tui/execution-plan-panel.test.ts` reads `tui-shell.ts` once to protect the
layout contract that the conditional Plan panel is mounted immediately before
Background Jobs. The projection itself is covered behaviorally in the same
test file; this source audit only pins the integration order until the shell
layout has an injectable or queryable composition seam.

## Manifest

Checked by `src/shell-source-audits.test.ts`, which re-runs the scan this
document was built from and fails when the two disagree. Columns: the test
file (relative to `src/`), the god-files it reads, and how many lines in it
name one of those paths outside a comment.

Line numbers are deliberately absent. Pinning them here would reproduce, in
the guard against fragile text assertions, the exact fragility it guards
against. They live in the detail files, which assert nothing.

```text
commands/shell-bus.test.ts | commands/shell.ts | 2
commands/shell-grant-refresh.test.ts | commands/shell.ts | 1
commands/shell-lease.test.ts | commands/shell.ts, tui/tui-shell.ts | 3
commands/shell-starting-line.test.ts | commands/shell.ts | 1
commands/shell-task-registry-wiring.test.ts | commands/shell.ts | 1
commands/shell.test.ts | commands/shell.ts | 5
harness/search/connection-message.test.ts | commands/shell.ts, tui/tui-shell.ts | 2
mcp-servers/approval-wiring.test.ts | commands/shell.ts, tui/tui-shell.ts | 3
tui/boot-animation.test.ts | tui/tui-shell.ts | 2
tui/busy-dispatch.test.ts | tui/tui-shell.ts | 1
tui/connect-provider-buttons.test.ts | tui/tui-shell.ts | 1
tui/execution-plan-panel.test.ts | tui/tui-shell.ts | 1
tui/help-first-run.test.ts | tui/tui-shell.ts | 1
tui/provider-catalog-startup.test.ts | tui/tui-shell.ts | 1
tui/routing-classifier-shell-wiring.test.ts | tui/tui-shell.ts | 1
tui/shell-fallback.test.ts | tui/tui-shell.ts | 1
tui/tui-bus.test.ts | tui/tui-shell.ts | 1
tui/tui-hold.test.ts | tui/tui-shell.ts | 1
tui/tui-session-lease.test.ts | tui/tui-shell.ts | 3
tui/tui-shell.test.ts | tui/tui-shell.ts | 12
tui/turn-guard-shell-wiring.test.ts | tui/tui-shell.ts | 1
```
