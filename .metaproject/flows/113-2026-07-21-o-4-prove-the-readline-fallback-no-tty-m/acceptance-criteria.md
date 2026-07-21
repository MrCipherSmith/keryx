# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A test proves `launchTuiAgentShell` returns `false` when `process.stdout.isTTY` is falsy, and the same for `launchTuiChatShell` — the second guard that flow 112 introduced at `src/tui/chat-shell.ts:493`. Both tests fail if their guard is removed, demonstrated by running them against a build with the guard stripped.
- AC2: A test proves the fallback is actually taken end to end: with no TTY, `shellCommand` runs the readline shell and never mounts a TUI renderer. It asserts on an observable effect, not on `chooseShellSurface`'s return value alone — that decision layer is already pinned by `src/commands/shell-launch.test.ts` and re-asserting it would not extend coverage.
- AC3: The optional-dependency-absent trigger is proven: with `@opentui/core` unresolvable, the launch function returns `false` rather than throwing, and the caller falls through to readline.
- AC4: The renderer-init-failure trigger is proven: when `createCliRenderer` throws, the launch function returns `false` rather than propagating, and the caller falls through to readline.
- AC5: The escape-free half of the criterion is asserted on raw bytes: readline-shell output produced under `NO_COLOR` contains no ANSI escape sequences, checked with the `forceColor()` / raw-escape-substring idiom already used in `src/lib/ui.test.ts` (for example `expect(out).not.toContain("\\x1b[")`). A test that only checks rendered text without inspecting bytes does not satisfy this.
- AC6: Every new test is proven falsifiable — each is run against code with the behaviour it pins deliberately broken, and the failure is recorded in the flow journal. A test that passes both before and after does not count as coverage.
- AC7: The `scripts/install.sh --global` half of the success criterion is investigated and answered in `docs/requirements/keryx-opentui-shell/specification.md`: either it is covered by a test, or the specification states plainly that it is not testable in CI and why, so the claim is no longer unqualified.
- AC8: `bun run typecheck` is clean and `bun test` passes with no fewer tests than the 2072-pass / 11-skip / 0-fail baseline on this branch. Tests that depend on `@opentui/core` genuinely execute rather than silently skipping — `bun test src/tui` reports 0 skips.
- AC9: No production behaviour is changed except where making a trigger observable strictly requires it; any such change is justified in the journal, and any defect found while proving the fallback is reported rather than silently fixed.
- AC10: O-4 is closed in `specification.md` §10 with evidence, keeping the original finding above the resolution as O-1 and O-2 do, and the remaining open items (O-3, O-5) stay listed.
