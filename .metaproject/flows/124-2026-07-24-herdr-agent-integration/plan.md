# Implementation Plan

Status: formalized

## Approach

Add a small, dependency-free reporter module that speaks herdr's pane-socket
protocol (the same one herdr's own opencode plugin uses), and call it from the
one choke-point that already models the shell's lifecycle (`setMainAgent` in the
OpenTUI shell). Prefer socket reporting over a screen-detection manifest because
keryx owns its own state machine — it is exact, needs no fragile regexes, and
herdr already whitelists the `keryx` agent id.

## Steps

1. New module `src/tui/herdr-report.ts`:
   - `createHerdrReporter(clock?, connect?)` → `{ report(state), release() }`;
     no-op unless the herdr env gate is satisfied.
   - `herdrStateFor(status)` maps the TUI vocabulary onto herdr states.
   - Serialize writes on a single promise chain; per-write 500ms timeout; never
     throw into the shell. `node:net` only.
2. Co-located `src/tui/herdr-report.test.ts` (bun:test): env gate, no-op,
   identity/state payload, dedup, monotonic seq, release.
3. Wire `src/tui/tui-shell.ts`:
   - import; `const herdr = createHerdrReporter();` at function scope;
   - `herdr.report(herdrStateFor(status));` inside `setMainAgent`;
   - `await herdr.release();` in the `finally` teardown.
4. Verify: `bun test src/tui/herdr-report.test.ts`, `tsc --noEmit`, targeted
   TUI test, live socket smoke (already done in discovery).

## Risks

- **Method-name drift** — mitigated: `pane.report_agent`/`pane.release_agent`
  verified against the binary and live sockets.
- **Blocking the shell on a stalled socket** — mitigated: bounded 500ms timeout,
  fire-and-forget, errors swallowed.
- **Stale seq across a reused pane** — mitigated: seq seeded from wall-clock like
  herdr's own plugins.
- **`node:net` under Bun** — same API the codebase already relies on for other
  `node:` builtins; unix-socket client is standard.
