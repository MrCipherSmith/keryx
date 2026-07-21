# Flow Journal

- 2026-07-21T21:19:45.624Z - flow created
- 2026-07-21T21:20:38.873Z - frozen: 10 criteria; checksum recorded
- 2026-07-21T21:20:38.936Z - started
- 2026-07-21T21:20:39.001Z - task-done: T1: Collect remaining context
- 2026-07-21T21:33:00.000Z - T2/AC6 falsification: every test in `src/tui/shell-fallback.test.ts` was run against deliberately broken code; each failure below was observed, then the break reverted (`git checkout --`, working tree verified clean between runs).
- 2026-07-21T21:33:00.001Z - AC1 (agent): removed `if (!process.stdout.isTTY) return false;` from `src/tui/tui-shell.ts` → "AC1: launchTuiAgentShell declines without a TTY…" FAILED at `expect(result.probe.imported).toBe(false)`: "Expected: false / Received: true". Note the return value stayed `false` (the renderer probe throws and the catch swallows it), so `imported` is the assertion that carries the proof.
- 2026-07-21T21:33:00.002Z - AC1 (chat): same guard removed from `src/tui/chat-shell.ts` → "AC1: launchTuiChatShell declines without a TTY…" FAILED at `expect(result.probe.imported).toBe(false)`: "Expected: false / Received: true".
- 2026-07-21T21:33:00.003Z - AC3: replaced the try/catch around the optional-dependency import with a bare `await import(...)` in both shells → both AC3 tests FAILED at `expect(result.threw).toBeNull()`: `Received: "Cannot find module '@opentui/core'"`.
- 2026-07-21T21:33:00.004Z - AC4: changed the launch functions' outer `catch { return false; }` to `catch (error) { throw error; }` in both shells → both AC4 tests FAILED at `expect(result.threw).toBeNull()`: `Received: "renderer init failed (flow 113 probe)"`.
- 2026-07-21T21:33:00.005Z - AC2: removing only `chooseShellSurface`'s `isTty` term did NOT fail the AC2 test (the launch guard still declines) — it fails `src/commands/shell-launch.test.ts` instead ("Expected: readline / Received: tui-agent"). Removing the launch guard as well → "AC2: with no TTY, `keryx shell` runs the readline shell…" FAILED at `expect(run.probe.imported).toBe(false)`: "Expected: false / Received: true". The chain has two independent layers and each link is pinned by a different test.
- 2026-07-21T21:33:00.006Z - AC5 (plain): deleted the `NO_COLOR` branch from `colorEnabled()` in `src/lib/ui.ts` → "AC5: the readline fallback's bytes carry no ANSI escapes under NO_COLOR" FAILED at `expect(run.stdout).not.toContain("\x1b[")` on the forced-TTY run, received output containing `[36m◆[39m …`.
- 2026-07-21T21:33:00.007Z - AC5 (colour control): made `colorEnabled()` return `false` unconditionally → "AC5: the same run WITH colour does emit escapes" FAILED at `expect(coloured.stdout).toContain("\x1b[")`. Both directions fail, so the escape-free claim is a property of NO_COLOR and not of a code path that could never colour anything.
- 2026-07-21T21:33:00.008Z - T2 verification: `bun test src/tui` 94 pass / 0 fail / 0 skip; `bun test src/commands` 210 pass / 3 skip / 0 fail; `bun test` 2081 pass / 11 skip / 0 fail (baseline 2072/11/0 + 9 new); `bun run typecheck` clean. No production file changed.
- 2026-07-21T21:35:03.212Z - task-done: T2: Implement per plan
- 2026-07-21T21:36:50.798Z - task-done: T3: Add/adjust tests and make them pass

## Notes

### The task arrived with three stale premises

Corrected against the code before freezing, and recorded so the flow was not
sized against fiction:

1. *"`isTTY` occurs exactly once across the entire test surface."* Wrong in both
   directions. `keryx ctx rg 'isTTY' --glob 'src/**/*.test.ts'` returns **zero** —
   no test touched it at all. But flow 112 had already extracted the decision into
   the pure `chooseShellSurface(flags, isTty)`, which `shell-launch.test.ts`
   pins for agent / chat / `--no-tui` / no-TTY. So the hand-over's item 1 was
   already covered *at the decision layer*, and the real gap was everything below
   it. Re-proving the decision would have looked like progress without being any.
2. Line references were stale: the guard is `tui-shell.ts:657`, not `:708`, and
   the init-failure catch had moved (flow 112 took the file 2301 → 1951 lines).
   A second guard existed that the hand-over did not know about —
   `chat-shell.ts:493` — because flow 112 gave chat its own TUI.
3. The stated baseline (2014 pass) predated flows 109 and 112; the real one was
   2072.

### The finding that shaped the whole task

**Every failing path in both launch functions ends in `return false`, so the
return value cannot distinguish a working guard from a deleted one.** Strip the
no-TTY check and the renderer merely fails later and returns `false` anyway. A
test asserting `=== false` would have passed against broken code — precisely the
class of defect that put O-4 on the list in the first place.

The tests therefore run the real code in a child `bun` process whose `--preload`
plugin substitutes `@opentui/core` with a probe recording `imported` /
`mountAttempted`, and which can also fail to resolve or throw from
`createCliRenderer`. Assertions hang on the probe. The subprocess also keeps
`bun test`'s process-wide module registry unpoisoned and lets `isTTY` /
`NO_COLOR` / `FORCE_COLOR` vary per run.

The AC2 test's first draft demonstrated the risk directly: with only
`chooseShellSurface`'s `isTty` term removed it still **passed** (see the
falsification log above). It was sharpened until it failed.

### Install clause — answered, not papered over

`install.sh --global` clones, runs `bun install`, and writes a wrapper that
`exec`s `bun <dir>/src/cli.ts`. Split into two claims:

- *"produces a working CLI"* — **testable**, since the script honours
  `KERYX_REPO_URL` / `KERYX_REF` / `KERYX_HOME` / `KERYX_BIN_DIR`. Deliberately
  **not** done here: an installer concern, not a fallback one, and taking it
  would have been scope creep on an O-4 flow. Recommended follow-up.
- *"...launches the TUI"* — **not testable in CI as the repo stands.** A GitHub
  Actions step has no controlling terminal, so `process.stdout.isTTY` is falsy
  and the shell takes the readline fallback *by design* — the behaviour this flow
  just pinned. Proving otherwise needs an allocated pty; no such harness exists.
  `.github/workflows/ci.yml` is also `ubuntu-latest` only, so even a pty harness
  would evidence one platform, which is O-3.

Recorded in specification §10 rather than left as an unqualified claim.

### Review

No separate `review-orchestrator` pass was run, and that is a deliberate choice
worth stating rather than hiding. This flow changed **no production file** — the
diff is one new test file plus documentation — and every assertion in it was
falsified against deliberately broken code, which is the property a reviewer
would most want to check. Flows 109 and 112 each had a reviewer find real defects,
but both restructured shipped code; the risk profile here is not comparable. If a
reviewer pass is wanted anyway, the diff is small enough to be cheap.

### Still open

O-3 (platform coverage beyond darwin-arm64), O-5 (cold-start latency), and O-4's
install-produces-a-working-CLI clause. The tests prove the fallback *triggers* and
byte-level output parity; they do not prove the readline shell is functionally
equivalent to the TUI beyond what reaches stdout.
