# Keryx Shell Split

Make `src/tui/tui-shell.ts` and `src/commands/shell.ts` maintainable.

**Status:** P1, P2 and P2b merged (flows 276, 277, 278 — PRs #623, #625, #631).
P3 and P4 not started. **51 source-text read sites across 17 files → 34 across
12.** [Where it stands and what is next](#where-it-stands) is at the bottom;
the [inventory](source-text-audit-inventory.md) is the live worklist.

## The problem is not the line count

| file | lines | shape |
|---|---:|---|
| `src/tui/tui-shell.ts` | 7,110 | separable helpers, wizards and pickers up front; `launchTuiAgentShell` is one ~4,700-line closure over ~two dozen mutable locals, almost all inside a single `try`. |
| `src/commands/shell.ts` | 4,131 | `runShell`, `runAgentRepl`, flag parsing, `shellCommand`. |

Those counts are **larger** than when this package opened (6,853 and 3,919).
Three PRs of seam work have not shrunk either file and were never going to:
a seam adds a parameter and a paragraph explaining why it exists. What they
bought is that the code can now be *moved* with a test suite that notices
breakage rather than movement. The shrinking is P3 and P4.

Size is why the split is wanted. It is not why the split has not happened.

The blocker was that **17 test files read these two as text** — 51 read sites —
asserting on exact substrings, `indexOf` offset comparisons, occurrence counts
and fixed character windows (`source.slice(idx, idx + 500)`), in order to check
that production code is *wired* a particular way.

Assertions of that shape are coupled to the physical layout of the file, not to
its behaviour, so they fail in both directions:

- **They fail on edits nothing can observe.** During the agent-bus flows
  (271-275) these audits broke twice — once on a function signature wrapped
  onto two lines, once on one extra `makeAgentDeps` call site. CI was the only
  thing that caught either.
- **They pass while the behaviour breaks.** A substring assertion records a
  string, and a string survives in a comment or a dead branch.
  `mcp-servers/approval-wiring.test.ts:102` documents this happening to itself:
  its first version matched `tool !== "shell_exec"` in prose above the branch
  it meant to pin, and "failed for that reason rather than for a real one".
- **And one whole family of them is aimed at the wrong code.** Most audits in
  `shell.test.ts` bound their search to `slice(indexOf("async function
  runAgentRepl("), indexOf("if (agentMode) {"))`. `runAgentRepl` ends at
  `shell.ts:2625`; that window runs to `:3705`. Every such assertion has been
  reading ~1,080 lines of unrelated code — including `makeAgentDeps` at
  `:3187` — as though it were the REPL body. That is the breakage the
  agent-bus work actually hit.

So a mechanical, behaviour-preserving move of either file fails a large number
of tests, and the failures cannot distinguish *you moved the code* from *you
broke the wiring*. That is precisely the signal a refactor of this size needs,
and it is the signal these tests destroy.

The sharpest case is the ordering audits. `approval-wiring.test.ts:45` asserts
that `"if (isMcpToolCall(tool)) {"` occurs at a lower character offset than
`"evaluateShellApproval({"` in **both** files. A comparison of character
offsets has no meaning once the two anchors live in different modules — and the
property it stands in for (an MCP tool call must never reach the shell
permission store) is real, and deserves a test that says so.

## Four PRs, in order

| PR | Flow | What lands |
|----|------|---|
| **P1** ✅ | 276 | [The inventory](source-text-audit-inventory.md) — every audit, and the behaviour it actually protects — plus `src/shell-source-audits.test.ts`, which re-derives the scan so the document cannot silently rot. No production code touched. |
| **P2** ✅ | 277, 278 | Audits converted to behavioural tests, with seams where the behaviour was not observable. Split across two PRs; the second also fixed a real `process.once` bug the widened scan found, which is the one deliberate behaviour change in the programme. Partial — the remaining 34 sites are listed in the inventory with the seam each waits on. |
| **P3** | not started | `src/tui/tui-shell.ts` split into `src/tui/shell/`, with `tui-shell.ts` kept as the public entry point so no caller changes. Pure movement. |
| **P4** | not started | `src/commands/shell.ts` split the same way. Pure movement. |

Flow packages for P2-P4 are created when each starts, not up front: ids are
minted on `main`, and one created early inside an open PR branch collides with
another session's.

### The seam pattern

Flow 274 already did this twice, for the same reason. `src/tui/bus-wake.ts`
(197 lines) and `src/tui/bus-command.ts` (71 lines) were lifted out of
`tui-shell.ts` so the bus-wake decision could be unit-tested without a
renderer. `bus-wake.ts`'s own header names what it replaced: logic that "used
to live only in `tui-shell.ts` itself and was pinned by source-text audits
(`tui-bus.test.ts`) and a reimplemented copy of the loop
(`delivery.integration.test.ts`) rather than being exercised directly."

That is the shape P2 follows: a small module with a pure decision function or
a small stateful controller, injected at the call site, tested directly.

### What P3 can and cannot do by moving

`src/commands/shell.ts` decomposes along the lines its top-level functions
already draw: flag parsing, the readline chat loop, the agent loop, approval,
bus and lease wiring.

`src/tui/tui-shell.ts` does not, entirely. Its first 2,909 lines move cleanly.
`launchTuiAgentShell` is one closure whose parts communicate through shared
mutable locals; relocating it into its own module is movement, but breaking it
apart is not, and P3 is scoped as movement. Decomposing that closure is
follow-on work, and it is only safe once P2's behavioural tests exist.

## Out of scope

`src/tui/chat-shell.ts`, the third shell surface, has source-text audits of its
own. It is recorded where it is adjacent to these two and otherwise left alone.

## Where it stands

### Done

| PR | flow | what landed |
|---|---|---|
| [#623](https://github.com/MrCipherSmith/keryx/pull/623) | 276 | The inventory, and `src/shell-source-audits.test.ts` — a guard that re-derives the scan and fails when the manifest disagrees, so the document cannot rot. Registered in `test:core`: a root-level test matched by neither CI gate runs in **no** job, which `src/core-package.test.ts` proves. |
| [#625](https://github.com/MrCipherSmith/keryx/pull/625) | 277 | Seams: `export runAgentRepl` + `rich.write`, `src/tui/shell-exit.ts`, `buildNextStepPrompt`. Zero production behaviour change. |
| [#631](https://github.com/MrCipherSmith/keryx/pull/631) | 278 | Seams: `src/tui/bus-join.ts`, `createSplashLifecycle`, `isToolAvailableToSideWorker`, `BUS_WAKE_CAPPED_NOTICE`, a `dir` pass-through on `rememberExactShellGrant`. **Not** zero behaviour change — see below. |

### What the work actually found

Three things worth carrying forward, because none of them is visible from the
line count.

**Moving code with no behaviour change failed five audits across three files.**
That happened the first time a duplicated sequence was extracted, and it is the
thesis of this package demonstrated: the tests could not tell a move from a
break, which is precisely why the split was blocked.

**An audit that fails silently is worse than one that fails loudly.**
`mcp-servers/invariants.test.ts` bans `process.once` for teardown handlers and
scanned a hardcoded two-file list. This inventory recorded that as a *future*
hazard — "P4 moves the handler and it stops covering it". It was not future.
Widening the scan to whole directories found `src/commands/serve.ts:275`
registering exactly the banned pattern, so a second Ctrl-C while `keryx serve`
drained killed it before `stopped` printed. The guard existed; it was not
looking there.

**Estimates made by reading are unreliable, including the ones in this
document.** One row claimed a seam unlocked four tests; extraction showed one.
The correction is recorded in place. Treat the seam table as hypotheses.

### What is next, in order

1. **The readline half of `approval-wiring.test.ts`.** Unblocked now: the
   `dir` pass-through means a test can drive an MCP `use_tool` approval into a
   throwaway directory and assert no grant file appeared — the real property,
   instead of comparing character offsets. The TUI half stays a text audit
   until item 3 exists, because `tui-shell.ts` calls `allowShellPattern`
   without a directory. Converting half and saying so beats converting
   neither.
2. **`mcp-servers/invariants.test.ts`'s sibling risk.** Its scan is fixed for
   `src/commands/` and `src/mcp-servers/`, but the same hardcoded-list shape
   should be looked for elsewhere before P3/P4 move anything.
3. **An injection point for `launchTuiAgentShell`.** Most of the remaining 34
   sites wait on this one thing: a ~4,700-line closure over roughly two dozen
   mutable locals, none of it reachable from a test. It is a flow of its own,
   not a step in one. Note the constraint the existing seams observe — its
   locals are assigned thousands of lines after most closures are built, so a
   seam must take **getters**, not captured values; a captured value reads
   `undefined` forever and no test says so.
4. **P3** — split `tui-shell.ts` into `src/tui/shell/`, keeping `tui-shell.ts`
   as the entry point. **P4** — the same for `commands/shell.ts`.

### How to read the count

The manifest counts **files coupled to the path**, not assertions coupled to
the text. The exit-sequence extraction moved six audits off character offsets
onto a single symbol and did not move the count at all. A low count is the
goal; a *stable* audit is the point.
