# Context

Collected deterministically by `keryx flow init` at 2026-09-19T21:39:31.171Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.461] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
2. [1.363] SAC: Напиши мне скрипт на питоне цикла от 1 до 10 с промежутка… (task-note/accepted) - task-notes/sac-proposal-d820f7ae5c4b43af.md
   Session fixed /theme perception bug: applyTheme in shell-chrome.ts now repaints already-rendered chrome (transcript frames, tone block headers, dock buttons, sidebar panels) via themeColorToHex/themeColorRemap/recolorThemeTree, because OpenTUI stores colors as RGBA objects. Committed a6dd8dd, pushed to main. Lesson already accepted directly: .metaproject/memory/lessons/theme-switch-repaint.md (created via keryx memory new, bypassing SAC because no slate was open). This proposal records the work for review/audit.
   claimType: task-note | confidence: medium | version: 0.1.0
   scope: unknown
   provenance: source=sac-proposal link=./.metaproject/workspaces/workspace-55936fb9858144ec/session-evidence/6728c7b5-7e93-43a6-9ab4-ea0e9720eaf2.wrap-up.md (sha256 7f281c7cb8399293e9c361fcb0a4f19815108e08a6dfda27db1acdbd29e7f52b) author=unknown confirmedBy=unknown
3. [1.358] SAC: найди все не завершенные flow (task-note/accepted) - task-notes/sac-proposal-7854a304859a4170.md
   Незавершённые flow на 2026-08-19 (из 171): 099/100 blocked (нужен Linux/Windows host), 144/145 in-progress (3/4), 130/131/133 implemented (код готов). Плюс done-но-неполные: 064 (5/6), 116 (0/4), 163 (4/5), 169 (9/10), 170 (6/7), 171 (8/10). Следующий шаг — по выбору пользователя: до-закрыть 144/145 или разобрать done-но-неполные.
   claimType: task-note | confidence: medium | version: 0.1.0
   scope: unknown
   provenance: source=sac-proposal link=./.metaproject/workspaces/workspace-86f1eb7d089b4f1a/session-evidence/b4beb664-6284-457d-bb68-0aaa4a24a760.wrap-up.md (sha256 f64aaf83fbce0bcca89d87b2317bb3278d0fc7a0ec72c6dd11b731ebf4dcef58) author=unknown confirmedBy=unknown
4. [1.358] SAC: Anchors: root: /Users/tsaitler.aleksandr/goodea/keryx tre… (task-note/accepted) - task-notes/sac-proposal-b051e66aebd74f37.md
   Flow 188 (count .ts files in src/harness/provider, read-only) completed. Direct child .ts files excluding .test.ts and subfolders: fake-provider.ts, make-provider.ts, provider-port.ts, single-turn.ts, tool-call-linking.ts, types.ts = 6 files. Subfolders (openai/, ollama/, gemini/, anthropic/, compat/, fixtures/) and their contents excluded per the no-subfolders constraint. Task required read-only; rounds T1-T4 (plan/test/PR) are generic placeholders not applicable to this read-only counting task.
   claimType: task-note | confidence: medium | version: 0.1.0
   scope: unknown
   provenance: source=sac-proposal link=./.metaproject/workspaces/workspace-5c74a3f7b3c7414b/session-evidence/4f3b7eb5-a514-476e-8732-6087df8710d6.wrap-up.md (sha256 a12235fc2638f84f9fc1305cc5fff51a0563003ee785b92a1c81a02c961927a3) author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

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

_(flow-init skill appends here)_
