# Flow: текущие механизмы и граница повторного использования

Дата: 2026-10-25, Asia/Muscat. Исследование текущего checkout Keryx `main`, HEAD `1b7852748055d264d046092612fe3190fc82f70a`. Код не менялся; команды изменения Flow не запускались.

## Подтверждено в исходниках

- `freeze` читает AC, сохраняет checksum, классифицирует критерии и переводит Flow в ready: [service.ts](/Users/Goodea/goodea/keryx/src/flow/service.ts:1041).
- `acConfirm` проверяет существование критерия и целостность AC, затем сохраняет подтверждение и заявленную identity. Это не отдельная аутентификация человека: [service.ts](/Users/Goodea/goodea/keryx/src/flow/service.ts:1245).
- `acUpdate` пересчитывает checksum и сбрасывает все прежние подтверждения: [service.ts](/Users/Goodea/goodea/keryx/src/flow/service.ts:1327).
- Completion выполняется под per-flow lock; записывает gate outcomes как отдельную попытку и возвращается в in-progress при fail: [service.ts](/Users/Goodea/goodea/keryx/src/flow/service.ts:1459), [failure branch](/Users/Goodea/goodea/keryx/src/flow/service.ts:1556).
- Перед done критерии повторно сверяются, token расходуется только на успешном пути, подпись и done сохраняются: [service.ts](/Users/Goodea/goodea/keryx/src/flow/service.ts:1574), [token/signature](/Users/Goodea/goodea/keryx/src/flow/service.ts:1603).
- Confirmation token уже имеет TTL, single-use и привязку к Flow/AC checksum/PR target; есть terminal и TUI/remote-card пути. Но исходник явно предупреждает: shell-capable процесс может подделать terminal/файл; это не доказательство identity человека: [confirm-token.ts](/Users/Goodea/goodea/keryx/src/flow/confirm-token.ts:1).
- Confirmation gate opt-in, а не гарантия для любого существующего Flow: [service.ts](/Users/Goodea/goodea/keryx/src/flow/service.ts:499).
- Текущий код прямо оговаривает, что разные completion gates могут видеть разные PR heads во время конкурентного push. Записанный headCommit относится к наблюдению PR gate: [service.ts](/Users/Goodea/goodea/keryx/src/flow/service.ts:521).

## Что брать в Hub

Сохранить владельца Flow, checksum/version invalidation, gate attempt history, token/receipt seam и явные переходы. Не создавать второй Flow в OpenSpec adapter или SAC. Добавить ссылки на immutable spec requirements/change revision и доказательства точного code subject; в Hub перенести полномочия и запись человеческой identity на серверную сторону.

Текущий local confirmation pattern полезен как UX/протокол делегации, но недостаточен для ранее предложенной сильной гарантии «агент не может сам объявить работу принятой». Нужны серверные scopes, protected confirmation и subject-bound package. Это архитектурное требование, а не обнаруженная реализованная функция.

## Ограничения и routing audit

Тесты/health/CI не запускались; это чтение implementation и документации. Graph перестроен для навигации, но включил `.worktree-backups` и выдал parser warnings; все указанные выводы проверены по root `src`, не по backup-копиям. Wiki `src-flow` использована как указатель, не доказательство.

`graph_used`: context/build/find/affected. `wiki_used`: index, src-flow, wiki-graph-sac. `ctx_used`: rg/read/run. `raw_rg_used`: no. `memory`: targeted search, no accepted matches.
