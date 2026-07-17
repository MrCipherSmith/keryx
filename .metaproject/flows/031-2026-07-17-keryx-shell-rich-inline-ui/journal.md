# Flow Journal

- 2026-07-17T11:08:05.757Z - flow created
- 2026-07-17T11:11:29.522Z - frozen: 5 criteria; checksum recorded
- 2026-07-17T11:11:29.609Z - started
- 2026-07-17T11:11:29.692Z - task-done: T1: Collect remaining context

## T2 — implementation (branch `feature/031-keryx-shell-rich-inline-ui`)

- `src/commands/shell.ts`: added OPTIONAL `ShellIO` hooks `onTurnStart?`,
  `onTurnEnd?`, `onSystem?`; `runShell` now calls `onTurnStart` before the stream
  loop, `onTurnEnd(accumulated)` after any turn with content, and routes every
  non-token write (error / `/help` / `/connect` / unknown-command / "not
  available") through `system(t) = io.onSystem?.(t) ?? io.write(t)`. Token deltas
  and the `"\n\n"` separator are unchanged.
- `src/commands/shell.ts` wrapper: new `createRichIo()` (not-unit-tested) — styled
  header (`banner`), colored `❯ ` prompt marker, `assistant` role label + Braille
  spinner on turn start (timer confined to the wrapper; core stays timer-free),
  live raw streaming, in-place markdown re-render on turn end (TTY-guarded row
  math, falls back to leaving raw when not a TTY / nothing to restyle), and
  red/dim `onSystem` styling. Anthropic-no-key notice now routed through the same
  styled system path.
- `src/lib/ui.ts`: added pure `renderMarkdown(md)` (headings, bold, inline code,
  fenced code blocks, bullet lists; returns input unchanged when color disabled)
  and `roleLabel(role)`.

## T3 — tests

- `src/lib/ui.test.ts`: 6 new tests — `renderMarkdown` under FORCE_COLOR
  (heading, inline bold+code, bullet list, fenced code block) and NO_COLOR
  (byte-identical passthrough, no ESC), plus `roleLabel`.
- `src/commands/shell.test.ts`: 3 new tests — hooks fire in order
  (`onTurnStart` before first token, `onTurnEnd:<full>`, `/help` → `onSystem`
  not `write`); **byte-identical** hook-less regression (`writes.join("")` ===
  `"Hello\n\n"`); `provider_error` routed to `onSystem`.

## Verification

- `bunx tsc --noEmit`: clean (exit 0).
- `bun test`: **1364 pass / 3 skip / 0 fail** (baseline 1355 pass; +9 new). Whole
  suite offline/deterministic.
- Live smoke (piped, non-TTY → plain path) `bun src/cli.ts shell --provider ollama
  --model gemma4:e4b`: header + `❯` prompt render; a provider `[error]` line is
  routed and printed without crashing, with a clean re-prompt. A SUCCESSFUL
  stream + spinner + markdown re-render requires a real TTY with a reachable
  Ollama (server was down / loopback blocked from the tool process) — to be run
  by the user in their terminal (AC3 + AC5 live-smoke portion).
- 2026-07-17T11:26:46.317Z - task-done: T2: Implement per plan
- 2026-07-17T11:26:46.418Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-17T11:26:46.506Z - ac-confirmed: AC1: byte-identical hook-less regression + hook-order tests green (shell.test.ts flow-031 block)
- 2026-07-17T11:26:46.600Z - ac-confirmed: AC2: renderMarkdown pure tests: FORCE_COLOR heading/bold/code/list/fence + NO_COLOR passthrough (ui.test.ts)
- 2026-07-17T11:26:46.720Z - ac-confirmed: AC4: additive edits only (shell.ts/ui.ts/tests); deps still {}; tsc clean; reuse of select.ts/providers unchanged
- 2026-07-17T11:35:26.402Z - ac-confirmed: AC3: live TTY render confirmed via user screenshot: cyan headings, • bullets, bold, dimmed fenced code block, blockquote from 'bun src/cli.ts shell'
- 2026-07-17T11:35:26.492Z - ac-confirmed: AC5: tsc clean; bun test 1364 pass/0 fail (baseline 1355); live render shown in real terminal; piped non-TTY path plain (no corruption)
