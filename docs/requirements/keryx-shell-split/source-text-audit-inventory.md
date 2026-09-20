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
[audits-tui-other.md](audits-tui-other.md). **17 test files, 51 read sites.**

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
commands/shell-task-registry-wiring.test.ts | commands/shell.ts | 1
commands/shell.test.ts | commands/shell.ts | 14
mcp-servers/approval-wiring.test.ts | commands/shell.ts, tui/tui-shell.ts | 3
mcp-servers/invariants.test.ts | commands/shell.ts | 2
tui/boot-animation.test.ts | tui/tui-shell.ts | 1
tui/next-step-suggestion.reasoning-guard.test.ts | tui/tui-shell.ts | 1
tui/session-info.test.ts | tui/tui-shell.ts | 1
tui/shell-fallback.test.ts | tui/tui-shell.ts | 1
tui/subagent-inspector.test.ts | tui/tui-shell.ts | 1
tui/theme-picker.test.ts | tui/tui-shell.ts | 1
tui/tui-bus.test.ts | tui/tui-shell.ts | 1
tui/tui-hold.test.ts | tui/tui-shell.ts | 1
tui/tui-session-lease.test.ts | tui/tui-shell.ts | 3
tui/tui-shell.test.ts | tui/tui-shell.ts | 14
```
