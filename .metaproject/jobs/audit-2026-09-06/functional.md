# Функциональный аудит Keryx v0.2.80

База аудита: `main`, `d0a2a011df93c2459cb4329a7dc152fb0fe625a6`. Проверялся полный текущий проект; исходники не изменялись.

## Матрица возможностей

| Возможность | Статус | Доказательство |
|---|---|---|
| init/onboarding | implemented | Временный проект: source `init --yes`, `status`, 9/9 модулей, rc 0; без git hooks корректно пропущены. |
| gdgraph | partial | `gdgraph build/find/affected` работают; текущий граф: 1168 исходных файлов + 4 asset nodes, 3515 рёбер, tree-sitter unavailable, 50 unresolved edges. |
| gdwiki | partial | `wiki ask`, `validate`, `check-links` работают; 50 страниц, 12 affected/stale, нет страниц domain/business/user-scenario. |
| gdctx | implemented | Временный `ctx rg` дал компактный результат и корректные `file:line` matches. |
| health | partial | Текущий source `health run --strict` PASS, score 93, 237 P2 complexity findings; eslint skipped (required), tests/coverage намеренно не входили в этот запуск. Отдельный Bun audit выявил 28 advisory, которые health считает нулём. |
| testing | implemented | Full current `bun test`: 6897 pass / 18 skip / 0 fail; typecheck PASS. |
| security | partial | File scan и `scan-mcp` directory PASS; документированный `security scan <directory>` падает с EISDIR. |
| standard | implemented | Temporary `standard validate` PASS. |
| memory | implemented | Lexical `memory index/search` PASS в временном workspace; отсутствие embeddings задокументировано. |
| MCP/harness | partial | MCP install и offline harness suites PASS; live provider/MCP и noninteractive tool execution не проверены либо явно ограничены документацией. |

## Проверенный дефект

- **F-001 (P1/major):** `security scan <path>` описан как сканирование файла или каталога в `docs/docs/complete-setup-and-agent-workflows.md:676`, но `src/commands/security.ts:210` вызывает `readFile` для разрешённого пути. Воспроизведение во временном инициализированном проекте: `bun src/cli.ts security scan . --json` → `EISDIR: illegal operation on a directory, read`, rc 1. Сканирование файла проходит. Нужно либо рекурсивно обрабатывать каталоги, либо согласованно изменить публичную документацию и usage на file-only.

## Функциональный риск

- **F-002 (P2/minor, partial/unverified):** `wiki ask` собирает все wiki pages (`src/wiki/ask.ts:325-333`) без проверки freshness state; текущий отчёт freshness содержит 12 affected/stale страниц. Запрос по этому репозиторию показал accepted memory constraint, утверждающий, что PATH Keryx устарел, хотя source и global CLI оба сообщают 0.2.80. Цитирование работает, но stale context не помечается и не исключается.

- **F-003 (P1/major):** текущий strict health report (`.metaproject/data/health/artifacts/latest.md`, 2026-09-05) показывает `dependencyAudit: 0 findings` и Gate PASS, хотя отдельный текущий `bun audit --json` завершился rc 1 с 28 advisory, включая critical/high. `src/health/sources/dependency-audit.ts:54-69` разбирает только npm-подобные `vulnerabilities`/`advisories` maps; Bun выдаёт package-keyed arrays. В результате quality gate может объявлять PASS при уязвимостях зависимостей.

## Сильные стороны

- Локальный детерминированный workflow реален: на временном проекте завершилась цепочка init → graph → wiki → ctx → health/test analyze → standard validate.
- `keryx ctx run` ограничил полный тестовый лог, сохранив raw log и нормализованное резюме.
- Узкие guard/CLI suites также прошли: 173 + 84 + 52 теста.
- README/onboarding честно перечисляют ограничения model credentials, ripgrep, tree-sitter, remote approval и harness.

## Проверки и ограничения

- `bun ./src/cli.ts --version` и глобальный `keryx --version`: 0.2.80.
- `bun run typecheck`: PASS.
- Полный `bun test`: 6897 PASS, 18 SKIP, 0 FAIL, 51882 expect-вызова, 562 файла, 149.10 s.
- Нормализованные доказательства сохранены в [verification.md](verification.md), включая exact raw/summary paths для test, typecheck, health и audit.
- Временный onboarding-проект был без git, поэтому установка git hooks не проверялась.
- 18 пропусков относятся к host-dependent/opt-in live сценариям: bubblewrap, Windows, реальные subprocess/MCP/PTY и macOS network smoke; live provider credential и remote approval transport не проверялись.
- Символьный слой graph недоступен; выводы используют file-level fallback, а 50/3515 рёбер остаются unresolved.

## Routing audit

- `graph_used`: `keryx gdgraph context/find/affected/query`; использован существующий свежий граф.
- `wiki_used`: `.metaproject/wiki/index.md`, `keryx wiki freshness`, `wiki ask`, `wiki validate`, `wiki check-links`.
- `ctx_used`: `keryx ctx read/rg/run`; raw output не загружался без compact summary.
- `raw_rg_used: no`.
