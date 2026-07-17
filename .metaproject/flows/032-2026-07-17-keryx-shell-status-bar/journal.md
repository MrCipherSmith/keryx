# Flow Journal

- 2026-07-17T11:40:16.287Z - flow created
- 2026-07-17T11:42:12.199Z - frozen: 5 criteria; checksum recorded
- 2026-07-17T11:42:12.283Z - started
- 2026-07-17T11:42:12.374Z - task-done: T1: Collect remaining context

## T2 — implementation (branch `feature/032-keryx-shell-status-bar`, stacked on 031)

- `src/lib/statusbar.ts` (new, pure): `collapseHome`, `formatStatusBar({cwd,
  provider, model, columns})` (home-collapse + middle-truncate to fit width;
  plain when color off), and `scrollRegion(rows)` → `{ enter, drawAt, exit }`
  DECSTBM CSI builders. No terminal IO.
- `src/commands/shell.ts` wrapper: `createRichIo` now takes an optional
  `getStatus` source and owns the pinned bar — `enterBar` (set region 1..rows-1 +
  draw + SIGWINCH/SIGINT/exit handlers), `exitBar` (reset region `ESC[r` + show
  cursor + remove handlers, idempotent), `redrawBar` (called after each turn and
  on every provider creation). `shellCommand` wraps `makeProvider` in a tracking
  factory so the bar reflects the LIVE provider/model after `/model` `/provider`;
  `enterBar()` after the header, `exitBar()` in `finally`. Bar active ONLY when
  `colorEnabled() && stdout.isTTY && rows >= MIN_BAR_ROWS(4)`.

## T3 — tests

- `src/lib/statusbar.test.ts` (5): `collapseHome`; `formatStatusBar` NO_COLOR
  (plain, home-collapse, segments), overflow (middle-truncated, width ≤ columns),
  FORCE_COLOR (ANSI + text); `scrollRegion` (enter `[1;23r`, drawAt `[24;1H`+`[2K`,
  exit `[r`+`[?25h`).

## Verification

- `bunx tsc --noEmit`: clean.
- `bun test`: **1369 pass / 3 skip / 0 fail** (baseline 1364; +5). Offline/pure.
- Non-TTY safe-degradation smoke (`printf 'hi\n/exit\n' | bun src/cli.ts shell
  --provider fake --model test`): header + `❯` render, provider error routed
  cleanly, and **0 scroll-region escapes emitted** (grep count 0) — plain
  flow-031 behavior preserved.
- PENDING (user, real TTY): bar pinned to bottom while a reply streams above it,
  live update on `/model`, redraw on window resize, and terminal FULLY restored
  after `/exit` and `Ctrl-C` (AC3 + AC4 cleanup + AC5 live-smoke portion).
- 2026-07-17T11:48:42.322Z - task-done: T2: Implement per plan
- 2026-07-17T11:48:42.538Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-17T11:48:42.624Z - ac-confirmed: AC1: formatStatusBar tests: NO_COLOR plain+home-collapse, overflow truncation width<=columns, FORCE_COLOR ANSI (statusbar.test.ts)
- 2026-07-17T11:48:42.712Z - ac-confirmed: AC2: scrollRegion tests: enter [1;23r, drawAt [24;1H+[2K, exit [r+[?25h (statusbar.test.ts)
- 2026-07-17T11:48:42.822Z - ac-confirmed: AC4: safe degradation verified: non-TTY smoke emits 0 scroll-region escapes; deps still {}. Ctrl-C/exit terminal-restore pending user real-TTY smoke
- 2026-07-17T11:49:54.232Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/35
- 2026-07-17T11:49:54.340Z - task-done: T4: Self-review and prepare draft PR
