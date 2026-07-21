# O-4: prove the readline fallback — no-TTY, missing optional dep, renderer init failure, and escape-free output parity

Status: formalized
Source: open item O-4, `docs/requirements/keryx-opentui-shell/specification.md` §10

## Problem

PRD F5/G5 states a success criterion: "`keryx shell` with no TTY / on an
unsupported platform falls back to the readline shell with **byte-identical plain
output**". The mechanism exists but the claim is believed, not demonstrated.

## Premise corrections (verified against the code before freezing)

The task as handed over carried three stale facts. Correcting them narrows the
work substantially and is recorded here so the flow is not sized against fiction.

1. **"`isTTY` occurs exactly once across the entire test surface, in that
   guard" — no longer accurate, in both directions.** `keryx ctx rg 'isTTY'
   --glob 'src/**/*.test.ts'` returns **zero** matches: no test touches
   `process.stdout.isTTY` at all. But flow 112 extracted the launch decision into
   a pure `chooseShellSurface(flags, isTty)` (`src/commands/shell.ts:1174`) and
   `src/commands/shell-launch.test.ts` already pins agent / chat / `--no-tui` /
   no-TTY at the **decision** level. So request item 1 — "drive the fallback path
   with no TTY and assert the readline renderer runs" — is already covered where
   the decision is made. What is *not* covered is the layer below it.
2. **Line references are stale.** The no-TTY guard is `src/tui/tui-shell.ts:657`,
   not `:708`. The renderer-init-failure catch is no longer at `:2291-2292` —
   flow 112's extraction took the file from 2301 to 1951 lines. There is now a
   **second** guard to cover: `src/tui/chat-shell.ts:493`, since chat also
   reaches the TUI.
3. **The stated baseline is stale.** `bun test` is at **2072 pass / 11 skip /
   0 fail** on this branch, not 2014 — flows 109 and 112 landed in between.

## What is genuinely untested

- That `launchTuiAgentShell` and `launchTuiChatShell` **return `false`** on
  `!process.stdout.isTTY`, and that `shellCommand` therefore falls through.
- The other two fallback triggers the guard advertises: the optional dependency
  being absent, and renderer initialisation throwing.
- **The escape-free half of the criterion** — nothing asserts the readline
  output carries no ANSI under `NO_COLOR`. This is the substantive gap.

## Expected outcome

Each fallback trigger is proven by a test that fails if the trigger stops
working, and the plain-output claim is asserted on raw bytes rather than assumed.
Where the criterion cannot honestly be tested in CI, the specification says so
instead of leaving the claim unqualified.

## Out of Scope

- Changing fallback behaviour. This flow proves what exists; a defect found is a
  finding to report, and only then to fix.
- O-3 (platform coverage) and O-5 (cold-start latency).
- Any rework of `runShell`, `createRichIo` or the TUI shells beyond what making
  a trigger observable strictly requires.
