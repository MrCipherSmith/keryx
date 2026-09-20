# Keryx Shell Split

Make `src/tui/tui-shell.ts` and `src/commands/shell.ts` maintainable.

**Status:** P1 in progress (flow 276). P2-P4 not started.

## The problem is not the line count

| file | lines | shape |
|---|---:|---|
| `src/tui/tui-shell.ts` | 6,853 | `:1`-`:2909` separable helpers, wizards and pickers; `launchTuiAgentShell` (`:2910`-end) is one ~3,940-line closure over ~two dozen mutable locals, almost all of it inside a single `try` from `:3095`. |
| `src/commands/shell.ts` | 3,919 | `runShell` (`:601`-`:1051`), `runAgentRepl` (`:1432`-`:2627`), flag parsing (`:2702`-`:2964`), `shellCommand` (`:3021`-end). |

Size is why the split is wanted. It is not why the split has not happened.

The blocker is that **16 test files read these two as text** — 46 read sites —
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
| **P1** | 276 | [The inventory](source-text-audit-inventory.md) — every audit, and the behaviour it actually protects — plus `src/shell-source-audits.test.ts`, which re-derives the scan so the document cannot silently rot. No production code touched. |
| **P2** | — | Each audit converted to a behavioural test, with a seam added where the behaviour is not observable today. Green, with **zero production behaviour change**. |
| **P3** | — | `src/tui/tui-shell.ts` split into `src/tui/shell/`, with `tui-shell.ts` kept as the public entry point so no caller changes. Pure movement. |
| **P4** | — | `src/commands/shell.ts` split the same way. Pure movement. |

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
