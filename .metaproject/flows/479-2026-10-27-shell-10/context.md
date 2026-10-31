# Context

Collected deterministically by `keryx flow init` at 2026-10-27T10:53:30.814Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.641] SAC: Напиши мне скрипт на питоне цикла от 1 до 10 с промежутка… (task-note/accepted) - task-notes/sac-proposal-d820f7ae5c4b43af.md
   Session fixed /theme perception bug: applyTheme in shell-chrome.ts now repaints already-rendered chrome (transcript frames, tone block headers, dock buttons, sidebar panels) via themeColorToHex/themeColorRemap/recolorThemeTree, because OpenTUI stores colors as RGBA objects. Committed a6dd8dd, pushed to main. Lesson already accepted directly: .metaproject/memory/lessons/theme-switch-repaint.md (created via keryx memory new, bypassing SAC because no slate was open). This proposal records the work for review/audit.
   claimType: task-note | confidence: medium | version: 0.1.0
   scope: unknown
   provenance: source=sac-proposal link=./.metaproject/workspaces/workspace-55936fb9858144ec/session-evidence/6728c7b5-7e93-43a6-9ab4-ea0e9720eaf2.wrap-up.md (sha256 7f281c7cb8399293e9c361fcb0a4f19815108e08a6dfda27db1acdbd29e7f52b) author=unknown confirmedBy=unknown
2. [1.534] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
3. [1.527] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown
4. [1.473] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
5. [1.473] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-10-06T09:19:55.947Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

- По текущему src/tui/tui-shell.ts:7005 req.question обрезается до 72 символов перед showComposerChoiceDetailed. Полный текст доступен у вызывающей стороны; отдельный breadcrumb транскрипта вне scope.
- composer-choice.ts уже имеет scrollable subtitle, предел 10 строк, Ctrl+O и cleanup ScrollBox. Preview ограничен 8000 символами: этот срез нельзя переносить на тело вопроса.
- ask-user-bridge.ts маршрутизирует вопросы; shell-chrome.ts создаёт общий dock. Тесты: composer-choice.test.ts, ask-user-bridge.test.ts, ask-user-race.test.ts, ask-user-transcript.test.ts, src/commands/operator-confirm-tools.test.ts.
- Граф устарел относительно HEAD; причина основана на текущем коде. Wiki дала общий контекст TUI, не спецификацию карточки.
- Пользователь выбрал отдельный фло вместо расширения 468. Допущения: 10 строк — максимум тела, не всей карточки; сохраняем Ctrl+O; на низком терминале область уменьшается с доступом к ответам.
- Блокирующих вопросов для подготовки нет. Owner не задан: пользователь его не называл. Реализация и live-прогон не выполнялись.
