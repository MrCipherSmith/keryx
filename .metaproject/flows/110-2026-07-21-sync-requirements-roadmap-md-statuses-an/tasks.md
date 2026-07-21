# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect per-package current Status/Version lines and code evidence (already done during audit; summarized in context.md) |
| T2 | docs | Track A — roadmap.md: add 2 missing rows, rewrite 2 stale rows, bump Version 0.9.3 → 0.9.4 |
| T3 | docs | Track B — Status/Version corrections in 5 stale packages (opentui-shell, metaproject-native, multi-agent-engine, project-agent-harness, sandbox-credential-auto-mask) + execution-observability minor bump |
| T4 | docs | Track C — keryx-os-sandbox spec polish (mask-resolve.ts, dual-axis-report.ts, --mask-mode) |
| T5 | review | Verify docs-only (no src/ changes), every edited Markdown has Version header, roadmap matches package Status; prepare draft PR |
