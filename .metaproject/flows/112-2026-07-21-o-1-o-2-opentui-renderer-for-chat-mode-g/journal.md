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
- 2026-07-21T21:05:07.132Z - task-done: T7: Verify, review, update the docpack and journal
- 2026-07-21T21:10:19.906Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/188
- 2026-07-21T21:10:20.001Z - ac-confirmed: AC1: src/tui/shell-chrome.ts mounted by shell-chrome.test.ts:110-159 via the shipped createShellChrome; asserts row ORDERING of header/transcript/composer/footer plus textarea.focused. The T2 worker proved it non-vacuous by prototyping the implementation (8 pass, clean typecheck) then deleting it.
- 2026-07-21T21:10:20.066Z - ac-confirmed: AC2: All four forward-declared bindings resolved by construction order: toast slot built before the SELECTION handler that can call it; clearBusyTimer deleted as a binding and owned by destroy(); setBusyPhase real before the factory returns; nav controller now closes over chrome fields. Two genuine cycles are explicit registration points - addOverlaySource and setFooterOverride - each commented with why. Reviewer confirmed no placeholder is rebound.
- 2026-07-21T21:10:20.129Z - ac-confirmed: AC3: shell-chrome.test.ts:181-235 and :237-290 - / opens, printable keys filter, Esc closes and returns focus (via pressEscapeAndSettle for the 20ms bare-Esc timeout), and overlayActive() suppresses the router including proof it re-arms after release. Reviewer called this the strongest test in the set.
- 2026-07-21T21:10:20.193Z - ac-confirmed: AC4: shell-chrome.test.ts:292-317 toast render, replace and auto-clear; :319-360 asserts the footer ROW specifically for setBusyPhase and the idle-hint restore. Frame-based, not state-based.
- 2026-07-21T21:10:20.257Z - ac-confirmed: AC5: shell-chrome.test.ts:362-404 at four terminal sizes (90x24, 70x18, 120x30, 60x12) with 60 transcript lines and a draft preserved; transcript children are plain TextRenderables so the pinned scrollTop===2 overdraw defect cannot be depended on.
- 2026-07-21T21:10:20.318Z - ac-confirmed: AC6: launchTuiAgentShell 1610 to 1254 lines, keeping only the S2 agent set. src/tui kept EXACTLY 630 expect() calls across the extraction - no assertion lost. Seven behavioural differences were self-reported and all are recorded in journal.md rather than made silently; the reviewer diffed the chrome line-by-line against base 35f96c1 and confirmed layout order, ids, flex properties, keyBindings, menu colours, MENU_HEIGHT, SPINNER_MS, TOAST_MS and menu order faithful.
- 2026-07-21T21:10:40.087Z - ac-confirmed: AC7: AgentSlashCommand carries modes plus optional modeDescriptions; describeCommand/commandsForMode/filterCommands all require a mode, so the flattened option shape a menu needs is unobtainable without naming one. /expand /think /copy /resume agent-only; /models /provider chat-only. Three entries carry per-mode wording (/model argument vs picker, /connect guidance vs key entry, /exit). agent-commands.test.ts:42-103 pins per-mode descriptions and that agent order reproduces the pre-112 menu.
- 2026-07-21T21:10:40.153Z - ac-confirmed: AC8: shell.ts:355-359 plus shell-slash-registry.test.ts:155-171 - /expand /think /copy /resume in chat produce 'only available in agent mode' and 'this is chat mode', never 'Unknown command', and start no provider turn. A genuinely unknown token still gets the plain Unknown command. Symmetric guard added for /models and /provider in agent readline.
- 2026-07-21T21:10:40.220Z - ac-confirmed: AC9: Three production consumers where there was one: the TUI (tui-shell.ts), chat readline and agent readline (both in shell.ts, via renderCommandHelp and describeUnavailableCommand). shell-slash-registry.test.ts:74-117 iterates commandsForMode('chat') and asserts each description appears in real runShell output, so a hand-written literal fails the moment the registry is edited; :121-152 proves chat help carries chat wording and NOT agent wording for /model and /connect.
- 2026-07-21T21:10:40.284Z - ac-confirmed: AC10: chat-shell.test.ts:112-116 passes the real imported runShell (not a stub) with a fake provider; :146-151 asserts the streamed reply on captureCharFrame(). Also covers /help, the wrong-mode message and /exit teardown.
- 2026-07-21T21:10:40.349Z - ac-confirmed: AC11: chat-shell.test.ts:245-349 - submissions become lines in order including while a turn runs, the iterator ends cleanly on /exit both during and between turns, return() is safe, and the '\n\n' separator never reaches the transcript as content. F7 refined the rule: an ambiguous leading separator is held and flushed only if more output follows, because setting streaming in onTurnStart would have regressed the no-output-turn case.
- 2026-07-21T21:10:40.422Z - ac-confirmed: AC12: chooseShellSurface(flags, isTty) at shell.ts:1155-1182 returns tui-agent/tui-chat/readline; guard at :1218, dispatch at :1288. Credential path shared via resolveTuiStartup so a key saved by /connect is applied in chat - shell-launch.test.ts:56-92 asserts it lands in env, that a user-set env var still wins, and that a saved selection suppresses detection. The original AC12 test was a TAUTOLOGY caught in review (it asserted wantTui===true for --chat, already true before the fix); the replacement was verified to fail against the old guard, returning 'readline' for --chat.
- 2026-07-21T21:10:40.484Z - ac-confirmed: AC13: chat-shell.test.ts:185-228 asserts a ts fence renders its language tag and that diff add/remove lines carry distinct span foreground colours via captureSpans().fg.toInts() - colour cannot be proven by a substring check.
- 2026-07-21T21:10:55.117Z - ac-confirmed: AC14: package.json absent from the flow diff; no onUsage added to ShellIO - chat's header uses the existing estimateContextTokens and labels it an estimate (D-A2). @opentui/core reached only via typeof import(...) and dynamic await import(): shell-chrome.ts:47, chat-shell.ts:53 and :452, with no top-level import and no forbidden literal in a comment. The src/capability/no-optional-imports guard passes.
- 2026-07-21T21:10:55.181Z - ac-confirmed: AC15: git diff --stat on src/commands/shell.test.ts is EMPTY across every commit of this flow, verified again after T8. Its ~600 lines pinning runShell all pass unmodified. readline still runs chat when there is no TTY, the optional dependency is absent, or the renderer fails to initialise - chooseShellSurface returns 'readline' and both TUI surfaces fall through on a false return.
- 2026-07-21T21:10:55.244Z - ac-confirmed: AC16: bun run typecheck clean; bun test 2072 pass / 11 skip / 0 fail (baseline 2024 before the flow, plus 48 new tests, none lost). keryx health run: gate WARN, score 92, regression 3 vs the stale 2026-07-06 baseline - the same pre-existing warning flow 109 investigated; neither shell-chrome.ts nor chat-shell.ts appears in the findings, and the only flow-related entry is tui-shell.ts's long-standing churn hotspot whose size this flow reduced. review-orchestrator raised 5 MEDIUM and 6 LOW; all eleven are fixed and dispositioned in journal.md, with the reviewer explicitly told T3/T4 moved untested code.
- 2026-07-21T21:10:55.308Z - ac-confirmed: AC17: specification.md: O-1 and O-2 closed in section 10 with the original finding kept above each resolution; status line is plain 'implemented'; section 1's diagram now shows the two drivers, the two IO implementations and the shared chrome, and names the pull/push asymmetry - it had claimed AgentIO/ShellIO since before either was true. D-A1..D-A4 recorded in section 9. README status, runtime evidence and the Phase 5 note updated. Deferred items remain listed: D-A3 (replies as blocks), D-A2, and O-3/O-4/O-5.
- 2026-07-21T21:10:55.370Z - completing
- 2026-07-21T21:10:57.529Z - done: all gates passed
