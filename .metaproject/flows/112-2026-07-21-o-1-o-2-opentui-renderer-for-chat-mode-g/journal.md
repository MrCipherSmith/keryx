# Flow Journal

- 2026-07-21T19:17:37.552Z - flow created
- 2026-07-21T19:33:56.309Z - task-added: T5: S4 — mode-aware shared command registry, readline surfaces included
- 2026-07-21T19:33:56.376Z - task-added: T6: S3 — chat driver + --chat launch path
- 2026-07-21T19:33:56.443Z - task-added: T7: Verify, review, update the docpack and journal
- 2026-07-21T19:33:56.508Z - frozen: 17 criteria; checksum recorded
- 2026-07-21T19:33:56.574Z - started
- 2026-07-21T19:33:56.642Z - task-done: T1: Collect remaining context
- 2026-07-21T19:44:04.304Z - task-done: T2: Implement per plan
- 2026-07-21T19:56:46.786Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-21T20:11:24.899Z - task-done: T4: Self-review and prepare draft PR
- 2026-07-21T20:21:26.304Z - task-done: T5: S4 — mode-aware shared command registry, readline surfaces included
- 2026-07-21T20:36:23.017Z - task-done: T6: S3 — chat driver + --chat launch path
- 2026-07-21T20:46:39.242Z - task-added: T8: Fix review findings: helper duplication, menu focus/menuNav desync, tautological AC12 test, dead pendingApproval
- 2026-07-21T21:01:03.771Z - task-done: T8: Fix review findings: helper duplication, menu focus/menuNav desync, tautological AC12 test, dead pendingApproval

## Notes

### The fork the flow opened with

The task arrived as "build a chat renderer". The context pass found that framing
too small: `ShellIO` differs from `AgentIO` not by having fewer hooks but by
**direction** — `lines: AsyncIterable<string>` means `runShell` owns the loop
while a TUI composer pushes — and `launchTuiAgentShell` was 1610 lines with one
caller and **zero tests**. Three paths were sized against the code and put to the
user rather than picked silently:

- **A** shared core — restructure ~900 lines, 1300-1800 moved;
- **B** a second chat shell — 900-1200 new lines, recreating the drift D-6 exists
  to prevent;
- **C** chat as a tool-free agent — 150-250 lines, no restructuring.

The user first chose C, then switched to A after asking whether A was the more
complete implementation. It is, for a specific reason: under A both chat surfaces
run **the same driver**, so TUI chat and readline chat are identical in system
instruction, budget and turn semantics by construction. Under C they would have
been two engines behind one flag.

One correction to the context pass's sizing was made before freezing: it claimed
C would make `runShell` dead code. It would not — readline remains the mandatory
fallback and `runShell` is its chat implementation, so its ~600 lines of tests
stay meaningful either way.

### Sequencing was the risk control

D-A4 in the plan: T2 (chrome mount tests) → T3 (extract) → T4 (re-land the agent)
landed and were verified **before** any chat code was written. Refactoring and
adding a feature in one pass is how the default UI gets quietly broken.

The T2 worker validated its own tests were not vacuous by prototyping the
implementation, getting 8 pass with a clean typecheck, then deleting the
prototype — the discipline this project keeps having to relearn.

### Results by task

| Task | Outcome |
|---|---|
| T2 | 8 headless chrome tests, RED. The first tests this shell's chrome has ever had. |
| T3 | `shell-chrome.ts`, 764 lines. All four forward-declared bindings resolved by construction order; two genuine cycles became explicit registration points (`addOverlaySource`, `setFooterOverride`). |
| T4 | Closure 1610 → 1254 lines, −452. `src/tui` kept **exactly** 630 expect() calls — no assertion lost. Seven behavioural differences self-reported. |
| T5 | Registry mode-aware, consumers 1 → 3. Found and fixed a live bug: agent `/help` was printing the *chat* description of `/connect`. |
| T6 | `chat-shell.ts` + `chooseShellSurface`. O-1 closed. |
| T8 | All 10 review findings fixed. |

### Review dispositions (AC16)

A read-only `review-orchestrator` pass ran with the reviewer told to treat the
refactor as unreviewed code. It confirmed the extraction faithful line-by-line
against the base (layout order, ids, flex properties, keyBindings, menu colours,
`MENU_HEIGHT`, `SPINNER_MS`, `TOAST_MS`, `refilter`/`closeMenu` semantics, agent
menu order) and raised 5 MEDIUM + 6 LOW. All fixed in T8:

| # | Finding | Disposition |
|---|---|---|
| F1 | `composerHeightForLines` duplicated — the **tested** copy had no production callers while the **live** copy in the chrome was untested | Fixed: single exported copy in `shell-chrome.ts`, test repointed. |
| F2 | A settling chat turn stole focus from an open `/` menu, so Enter submitted the filter text instead of selecting the highlighted command | Fixed: guarded on `chrome.menuActive()`. |
| F3 | Five sites wrote `chrome.menu.visible = false` directly, leaving the chrome's `menuNav` stuck true — reopening `/` gave a visible but unfocused menu | Fixed: `hideMenu()` added and all five routed through it; `closeMenu()` delegates to it so the pair cannot drift. |
| F4 | **AC12's central claim rested on a tautology** — the test asserted `wantTui === true` for `--chat`, which was already true before the fix, so the dispatch was uncovered | Fixed: `chooseShellSurface` extracted and tested; the new test was **falsified against the old guard** (`--chat` → `"readline"`). |
| F5 | `pendingApproval` was dead in the pre-flow base, and the extraction added comments asserting it was live | Fixed: dead wiring deleted. `isShellApproved` kept — it is exported and tested. |
| F6 | Optional-dep guards reported **pass**, not skip, so the refactor's only safety net could evaporate to 10 green no-op tests | Fixed: `skipIf`. |
| F7 | The `"\n\n"` swallow rule dropped a reply whose *first* chunk was the separator | Fixed, but **not** as prescribed — setting `streaming` in `onTurnStart` would have regressed the no-output-turn case. The ambiguous leading separator is held and flushed only if more output follows. |
| F8 | The context estimate never reset on `/new` | Fixed. |
| F9 | `stopBusy()` removed from the wiki-enrich `finally` | Restored — idempotent, and it protected a path nobody had traced. |
| F10 | Comment claimed the agent menu was reproduced "exactly" when four descriptions had changed | Fixed. |

Every new T8 test was falsified against the pre-fix code before being accepted.

### Health

`keryx health run` → gate **WARN**, score 92, regression 3 vs baseline — the same
pre-existing warning flow 109 investigated, against the stale 2026-07-06 baseline
in `.metaproject/health/baselines/scores.json`. Neither `shell-chrome.ts` nor
`chat-shell.ts` appears in the findings; the only flow-related entry is
`src/tui/tui-shell.ts`'s long-standing churn×complexity hotspot, whose complexity
this flow *reduced* (1610 → 1254 lines).

### Deferred, deliberately

- **D-A3** — assistant replies stay segment views in chat, so `Ctrl+O` and
  `/copy` remain agent-only. Making them blocks touches D-3, D-5 and the AC11
  layout guard.
- **D-A2** — no `onUsage` on `ShellIO`; chat's counter is an estimate.
- No `/resume` picker in TUI chat: `runShell` owns chat sessions and has no
  resume UI. `-c` and `-r <id>` are threaded through; `-r` with no id still
  degrades to the latest session, as before.
- `addOverlaySource` now has no production consumer (F5 removed the only one).
  Kept as the documented registration point for caller-owned overlays and
  exercised by the chrome tests — but it is genuinely unused in production.
- **O-3, O-4, O-5** remain open in the docpack.
- Path A's larger prize — retiring the readline path (Phase 5's second half) — is
  unblocked but not attempted. Readline stays the mandatory fallback.

### What is still unverified

`launchTuiAgentShell` and `launchTuiChatShell` early-return on `!isTTY`, so
neither is reachable from the headless harness. Mouse copy-on-select, real
terminal resize, alternate-screen enter/restore and live spinner repaint under
the 120 ms interval remain verified by reading and by the chrome's mount tests,
not end to end. This flow narrowed that gap — the chrome now has 8 mount tests
where the shell had none — but did not close it.
