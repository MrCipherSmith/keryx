# Shell god-files P1: inventory the source-text audits that pin tui-shell.ts and commands/shell.ts

Status: formalized
Source: user description, 2026-09-19

## Problem

`src/tui/tui-shell.ts` (6,853 lines) and `src/commands/shell.ts` (3,919 lines)
are the two largest hand-written files in the repository, and both are past the
point where a reader can hold them. `launchTuiAgentShell` alone is one closure
running from `tui-shell.ts:2910` to the end of the file — about 3,940 lines
sharing roughly two dozen mutable locals. `shell.ts` has the same shape at
smaller scale: `runAgentRepl` (`:1432`-`:2627`) and `shellCommand`
(`:3021`-end) are ~1,200 and ~900 lines.

Size is not the blocker. The blocker is that a large set of tests reads these
two files **as text** — exact substrings, `indexOf` offset comparisons,
occurrence counts, and fixed character windows (`source.slice(idx, idx + 500)`)
— to assert that production code is *wired* a particular way. Those assertions
are coupled to the formatting and the physical layout of the file, not to its
behaviour, so:

- they fail on edits that change nothing a user can observe, and
- they pass while the behaviour they name silently breaks, provided the pinned
  literal is still present somewhere in the file.

Both failure directions were observed during the agent-bus flows (271-275): the
audits broke twice for purely cosmetic reasons — once a multi-line function
signature, once one extra `makeAgentDeps` call site — and each time CI was the
only thing that caught it.

The consequence is that the two files cannot be split. Any split moves the
pinned literals into other modules, so a mechanical, behaviour-preserving move
fails a large number of tests, and the failures do not distinguish "you moved
the code" from "you broke the wiring". That is exactly the signal a refactor of
this size needs, and it is the signal the current tests destroy.

The `indexOf`-ordering audits are the sharpest case: several assert that one
anchor appears at a lower character offset than another
(`src/mcp-servers/approval-wiring.test.ts:45` compares
`"if (isMcpToolCall(tool)) {"` against `"evaluateShellApproval({"` in **both**
files). An ordering assertion over character offsets has no meaning once the
two anchors live in different modules, and the property it stands in for —
an MCP tool call never reaches the shell permission store — is a real property
that deserves a real test.

## Expected Outcome

A written, checked-in inventory that is the working specification for the three
PRs that follow it. For every test that reads either file as text, it records:

- the file and line, and the enclosing `describe`/`test`;
- the technique (substring, negated substring, `indexOf` ordering, occurrence
  count, character window, regex) and the exact literal or window;
- **the behaviour it actually protects** — what a user would see go wrong;
- whether that behaviour is observable today through an exported function or an
  injected dependency, or needs a seam;
- the concrete conversion (behavioural test, or the seam to extract);
- the cosmetic edit that would break the audit as written.

Plus a guard so the inventory cannot silently fall out of date: a test that
scans for source-text reads of the two files and fails when the set does not
match what the inventory records.

## Out of Scope

- Moving, renaming or reformatting any production code in
  `src/tui/tui-shell.ts` or `src/commands/shell.ts`. This flow writes a
  document and one guard test; it does not touch either god-file.
- Writing the replacement behavioural tests, or extracting any seam — that is
  P2, and it must land green with zero production behaviour change before any
  split begins.
- The split itself: `src/tui/shell/` (P3) and `src/commands/shell/` (P4).
- `src/tui/chat-shell.ts`, the third shell surface. It has source-text audits
  of its own (`src/tui/chat-shell.test.ts`, and
  `src/tui/session-info.test.ts:195` reads it alongside `tui-shell.ts`). It is
  recorded where it is adjacent, and otherwise left alone.
