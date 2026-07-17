# Flow Journal

- 2026-07-17T19:07:38.321Z - flow created
- 2026-07-17T19:08:39.205Z - frozen: 3 criteria; checksum recorded
- 2026-07-17T19:08:39.482Z - started
- 2026-07-17T19:08:39.645Z - task-done: T1: Collect remaining context

## T2/T3 — implementation + tests (branch feature/034-keryx-shell-ui-fixes)

- `src/lib/statusbar.ts`: `scrollRegion(rows).enter` now `ESC7 + CSI 1;{rows-1}r
  + ESC8` (was `CSI 1;{rows-1}r + CSI {rows-1};1H`) — DECSC/DECRC preserve the
  cursor instead of jumping to the bottom row, removing the header/prompt gap.
- `src/commands/shell.ts` `printHeader`: adds one blank line for breathing room.
- `src/lib/statusbar.test.ts`: enter asserts region `[1;23r` + `ESC7`/`ESC8` +
  NO `[23;1H` bottom jump; drawAt/exit unchanged.

## Verification
- `bunx tsc --noEmit` clean; `bun test` 1381 pass / 3 skip / 0 fail (= baseline).
- Live visual smoke (prompt directly under header, no gap, bar pinned, terminal
  restored on exit) — deterministic terminal-control change; best confirmed in a
  real TTY by the user.
- 2026-07-17T19:11:38.679Z - task-done: T2: Implement per plan
- 2026-07-17T19:11:38.971Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-17T19:11:39.117Z - ac-confirmed: AC1: statusbar.test.ts: enter has [1;23r + ESC7/ESC8, no [23;1H bottom-jump; drawAt/exit unchanged
- 2026-07-17T19:11:39.276Z - ac-confirmed: AC2: printHeader emits a blank line before the prompt (out('\n')); confined to the header renderer
- 2026-07-17T19:11:39.448Z - ac-confirmed: AC3: tsc clean; bun test 1381 pass/0 fail (= baseline); chat+agent logic unchanged; deps {}. Visual no-gap is a deterministic terminal-control fix; live TTY confirmation is the smoke.
- 2026-07-17T19:11:54.471Z - task-done: T4: Self-review and prepare draft PR
- 2026-07-17T19:12:40.049Z - completing: merged commit: 1b24732e0693c877274f442f07065e5b3d7648a0
- 2026-07-17T19:12:40.112Z - done: all gates passed
