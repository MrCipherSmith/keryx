# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect context: IO seam (shell.ts), ui.ts toolkit, flow-021/022 reuse, baseline (done at init/enrich) |
| T2 | implement | Additive `ShellIO` hooks + `system()` routing in `runShell`; `renderMarkdown` + `roleLabel` in `ui.ts`; rich `shellCommand` (header, prompt, spinner, streaming, md re-render, styled onSystem) |
| T3 | test | Unit-test `renderMarkdown` (FORCE_COLOR + NO_COLOR, incl. code block + list); extend `runShell` tests: hooks fire at right points AND hook-less output byte-identical; keep suite offline/deterministic ≥ 1355 pass / 0 fail |
| T4 | review | Self-review, `tsc --noEmit`, full `bun test`, manual live smoke vs local Ollama (journal), prepare draft PR |
