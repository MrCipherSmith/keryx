# Дополнение: фактическое покрытие Keryx Shell

2026-09-06, main d0a2a01, source/global 0.2.80.

## Уточнение первоначального аудита

Код проекта действительно проверялся, а полный test suite включал тесты shell. Однако первоначальный аудит не содержал отдельного пользовательского end-to-end прохода `keryx shell`. Статические выводы о harness/serve/MCP нельзя автоматически переносить на interactive shell: у него отдельные запуск, permission gate, UI и жизненный цикл сессии. Формулировка «комплексный аудит» не означает построчный обзор каждого файла или проверку каждого сценария.

## Дополнительные проверки

- Прочитаны wiki architecture/permission-modes и структура/целевые участки `src/commands/shell.ts`; графом найдены shell config, launch, approval, TUI и process modules.
- Реальный запуск исходного CLI в PTY: `bun ./src/cli.ts shell --provider fake --model fake --agent --no-tui --ask`.
- `/help`, `/mode`, `/status` работают. Permission mode явно `ask`.
- Обычный ввод `Hello` достигает fake-provider. Он возвращает ожидаемое сообщение об отсутствии записанного transcript; REPL сохраняет работоспособность и принимает следующий `/status`.
- `/exit` завершает процесс с rc 0. Повторный запуск с `-r` и созданным session ID возобновил ту же сессию и её историю. Повторный выход успешен.
- `bun test src/commands/shell.test.ts src/commands/shell-launch.test.ts src/commands/shell-slash-registry.test.ts`: **89 pass, 0 fail, 359 assertions**, 3 файла.
- Summary: `.metaproject/data/gdctx/artifacts/2026-09-05T21-13-29-815Z_run.md`; raw: `.metaproject/data/gdctx/raw/2026-09-05T21-13-29-815Z_run.log`.

Сессии smoke-проверки записаны штатным shell storage; исходники и настройки разрешений не менялись. Fake-provider не подтверждает качество ответа реальной модели или выполнение ею tools.

## SH-001 — P2/minor: CLI help запускает shell

Фактический `keryx shell --help` предложил выбор provider/mode, создал session и запустил readline REPL вместо показа справки. При закрытом stdin процесс завершился с rc 0. Он также сообщил об отсутствии ключа выбранного по умолчанию OpenRouter и fallback на offline provider.

Код подтверждает причину: `src/commands/shell.ts:1655-1699` разбирает известные флаги, но не обрабатывает help и молча пропускает неизвестные. `shellCommand` затем продолжает обычный запуск. Это UX/CLI-контракт, не доказанная security vulnerability.

Рекомендация: обработать `--help`/`-h` до provider/session initialization, добавить явную диагностику неизвестных флагов. Проверить, что help не создаёт session и не начинает выбор/инициализацию provider.

## Что остаётся непроверенным

- Полноценный OpenTUI: рендер, фокус, клавиши, мышь, resize, модальные окна и terminal compatibility.
- Реальный model-provider: streaming, tool-calling, отмена активного ответа, восстановление после сетевых ошибок, точность token/cost accounting.
- Полная цепочка агентного задания через shell с изменением файлов, approvals, background jobs и subagents.
- Security properties shell во всех permission/sandbox режимах; результаты статического обзора соседних подсистем этого не заменяют.

Вывод: код и автоматические проверки shell изучены частично; отдельный readline smoke выполнен. Называть shell полностью проверенным продуктовым сценарием пока нельзя.

Routing audit: graph_used: yes; wiki_used: yes; ctx_used: yes; raw_rg_used: no. Использованы ранее загруженные local routing/review skills и testing skill. Live provider calls не выполнялись.
