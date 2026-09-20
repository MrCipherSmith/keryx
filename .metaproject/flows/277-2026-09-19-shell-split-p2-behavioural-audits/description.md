# Shell god-files P2: convert the source-text audits into behavioural tests, with seams where behaviour is not observable

Status: formalized
Source: user description, 2026-09-19

## Problem

P1 (flow 276, PR #623) inventoried every test that reads
`src/tui/tui-shell.ts` or `src/commands/shell.ts` as **text**: 17 files, 51
read sites of exact substrings, `indexOf` offset comparisons, occurrence counts
and fixed character windows.

Those assertions are coupled to the physical layout of the files rather than to
their behaviour, so a mechanical, behaviour-preserving move fails a large
number of tests, and the failures cannot distinguish "you moved the code" from
"you broke the wiring". That is the signal P3 and P4 need, and it is the signal
these tests destroy.

This flow converts them, so the split has a net that catches real regressions
and ignores movement.

## Expected Outcome

Every converted audit is replaced by a test of the behaviour it actually
protected, and where that behaviour was not observable, by a seam — an
exported function, an injected dependency, or an extracted module — that makes
it so. The pattern is `src/tui/bus-wake.ts` and `src/tui/bus-command.ts` from
flow 274.

Audits that are genuinely about **source structure** ("this file must never
import the Track B wrap-up composer") are not converted. They stay text audits
and are rewritten to scan the module's whole directory, so P3 widens their
coverage instead of breaking them.

Zero production behaviour change throughout. Seams are added, code is moved
behind them, and nothing a user can observe differs.

`src/shell-source-audits.test.ts` (from P1) keeps the inventory honest: it
re-derives the scan and fails when the manifest disagrees, so the count is a
progress signal rather than a claim.

## Out of Scope

- The splits themselves: `src/tui/shell/` (P3) and `src/commands/shell/` (P4).
- Converting every remaining audit. The work is sequenced by seam, and the
  largest seam — an injection point for `launchTuiAgentShell`'s ~4,700-line
  closure — is a flow of its own. What this flow does not reach is recorded in
  the inventory with the seam each blocked audit is waiting on.

## What actually landed

Partial, and stopped deliberately rather than at a natural boundary — the
user halted the programme once and then asked to finish with what was done.

Seams:

- `runAgentRepl` exported, and its writer injectable via `rich.write`
  (`src/commands/shell.ts`). Its own doc comment said "NOT unit-tested", and a
  dozen `describe` blocks cited that as the reason they read the file's text.
- `src/tui/shell-exit.ts` — `leaveBusThenRelease` and `performSlateExit`,
  replacing four hand-maintained copies of the exit sequence.
- `buildNextStepPrompt` in `src/tui/next-step-suggestion.ts`, so AC12's
  "the advisor never sees reasoning" is a property of a function rather than
  the absence of a substring in a region of a file.

Converted: `/goal`, `/plan`, `/reasoning` (and its configDir threading), the
flow-173 F-003 deny-list tests, the §5.4 exit ordering (pinned in three
separate files), and the AC12 reasoning guard.

Made split-survivable: eight structural audits across five files now scan
`src/tui/**` instead of one file.

Count: **51 read sites across 17 files → 42 across 13.**
