# Flow Journal

- 2026-07-20T07:20:11.829Z - flow created
- 2026-07-20T07:20:52.832Z - task-added: T5: add dep + R1 native gate
- 2026-07-20T07:20:52.911Z - task-added: T6: API map + --tui prototype
- 2026-07-20T07:20:52.991Z - task-added: T7: spike report + gate
- 2026-07-20T07:20:53.248Z - task-done: T1: Collect remaining context
- 2026-07-20T07:21:10.846Z - frozen: 4 criteria; checksum recorded
- 2026-07-20T07:21:10.955Z - started

## Phase 0 spike — findings (orchestrator)
- R1 install PASS: @opentui/core@0.4.5, prebuilt libopentui.dylib (darwin-arm64), no Zig; import loads native (257 exports).
- R2 RESOLVED: screenMode "split-footer" = fixed footer composer + scrolling main (Pi/grok layout) — adopt this.
- R3 MAPPED: InputRenderable/SelectRenderable ({name,description} == our registry)/ScrollBoxRenderable/BoxRenderable/TextRenderable/MarkdownRenderable(bonus)/KeyHandler; createCliRenderer(config).
- R4 MIT. R5 ~150ms headless incl native init.
- N2 headless testing PROVEN: @opentui/core/testing createTestRenderer + mockInput + captureCharFrame; 2 spike tests pass (Select renders command menu; Input accepts typed keys → .value).
- Proof: src/tui/tui-shell.ts launchTuiShell() split-footer skeleton + `--tui` wiring; non-TTY fallback to readline verified.
- THE GATE: keryx pins dependencies=={} and optionalDependencies EXACTLY to {mcp-sdk, web-tree-sitter} (AC15 + no-optional-imports). Clean path PROVEN: @opentui/core in optionalDependencies + dynamic import() + fallback passes the zero-dep floor + no-top-level-import guards; only AC15's exact-list assertion remains → a conscious ADR-level dependency-surface expansion for Phase 1.
- Verdict GO. Not merging the dependency to main; report + flow package only. Spike code kept on branch spike/059-opentui-shell as evidence.
- 2026-07-20T07:34:35.872Z - task-done: T2: Implement per plan
- 2026-07-20T07:34:35.975Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-20T07:34:36.084Z - task-done: T4: Self-review and prepare draft PR
- 2026-07-20T07:34:36.183Z - task-done: T5: add dep + R1 native gate
- 2026-07-20T07:34:36.279Z - task-done: T6: API map + --tui prototype
- 2026-07-20T07:34:36.415Z - task-done: T7: spike report + gate
- 2026-07-20T07:34:36.526Z - ac-confirmed: AC1: bun add @opentui/core install PASS (prebuilt libopentui.dylib, no Zig); import loads native (257 exports)
- 2026-07-20T07:34:36.656Z - ac-confirmed: AC2: API mapped: Input/Select/ScrollBox/Box/Text/Markdown Renderables + KeyHandler + createCliRenderer; split-footer screenMode
- 2026-07-20T07:34:36.753Z - ac-confirmed: AC3: src/tui/tui-shell.ts --tui skeleton (split-footer transcript+composer+/-dropdown); tsc clean; non-TTY→readline fallback verified; dynamic import + optionalDependencies
- 2026-07-20T07:34:36.869Z - ac-confirmed: AC4: report.md: R1-R5 + GO verdict + AC15 dependency-surface decision for Phase 1; headless spike tests green; main not changed (dep stays on spike branch)
- 2026-07-20T07:35:39.367Z - completing: merged commit: 337f266474a6dab616ae69f47e9860f9596fe4ca
- 2026-07-20T07:35:39.404Z - done: all gates passed
