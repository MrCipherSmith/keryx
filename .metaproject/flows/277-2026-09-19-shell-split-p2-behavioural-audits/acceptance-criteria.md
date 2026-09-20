# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: No production behaviour changes. Every production edit in this flow is one of: an `export` keyword, an optional injected dependency whose default reproduces the previous behaviour, code moved unchanged behind a new function, or a comment; proven by the full terminal CI leg staying green with no test asserting a changed output.
- AC2: `runAgentRepl` is exported from `src/commands/shell.ts` and takes its writer through `rich.write`, defaulting to `process.stdout` when the caller omits it, so the production call site is unchanged; proven by tests that drive it over fake input lines and capture what it renders.
- AC3: `/goal`, `/plan` and `/reasoning` are exercised through the real `runAgentRepl` rather than by reading `shell.ts`, and each replacement asserts something the substring could not: two arguments producing two different parser refusals, toggle state read back on a later line, and the persisted level read back out of the configDir the session was handed.
- AC4: The behavioural harness passes an isolated `configDir` on every run, never `undefined` — which resolves to the operator's own `~/.local/share/keryx/auth.json`; the reason is stated in the harness, and the real file is verified unmodified.
- AC5: `src/tui/shell-exit.ts` exports `leaveBusThenRelease` and `performSlateExit`, all four TUI exit paths go through one of them, and the specification §5.4 ordering plus the await-per-step property are asserted against the real functions in `shell-exit.test.ts`.
- AC6: `buildNextStepPrompt` in `src/tui/next-step-suggestion.ts` reads only `role` and `content`, and flow 268 AC12 is proven by passing history messages that DO carry reasoning and checking the built prompt, not by asserting a substring is absent from a region of `tui-shell.ts`.
- AC7: Structural audits — genuine statements about source structure — are kept as text audits and rewritten to scan every non-test file under the module directory, so P3 widens their coverage rather than breaking them; at least the wrap-up-composer ban, the SIGINT/SIGTERM precondition, the modal-host boundary checks and the import-boundary checks.
- AC8: `src/shell-source-audits.test.ts` is green and its manifest is regenerated from the live scan, showing 13 test files and 42 read sites, down from 17 and 51 at the start of this flow.
- AC9: The inventory states what the count does and does not measure — that it counts files coupled to the path, not assertions coupled to the text — and names the case that showed the difference.
- AC10: Every audit left unconverted is recorded with the seam it is waiting on, so the next flow starts from a list rather than a re-reading.
- AC11: typecheck, lint and the full test suite are green in CI on the PR head.
