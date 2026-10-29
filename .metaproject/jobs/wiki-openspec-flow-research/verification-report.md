# Проверка источников и границы утверждений

Date: 2026-10-25. Scope: source/document consistency; не code quality review и не тестовый gate. Проверены analysis.md и четыре findings-файла. Источники привязаны к снимкам HEAD, указанным в analysis.md.

## Результат

В пяти назначенных документах проверено 199 уникальных локальных ссылок path+line: все файлы существуют, номера строк находятся в пределах файлов. Это проверка адресуемости, а не семантическое подтверждение каждой из 199 ссылок. Ключевые спорные claims дополнительно сверены по bounded диапазонам root source; ни один не требует отзыва. Ниже — условия, которые следует сохранить при переносе результатов в Page.

| Claim | Проверенный источник | Граница формулировки |
|---|---|---|
| SAC wiki-update создаёт decision page | [render/path](/Users/Goodea/goodea/keryx/src/sac/wiki-owner-writer.ts:30), строки 30–78 | Existing-page patch отсутствует в этом owner writer. Не утверждать, что Keryx вообще не умеет редактировать существующие wiki pages. |
| contract-change пока идёт в skill | [ownerFor](/Users/Goodea/goodea/keryx/src/sac/proposal-lifecycle.ts:847) | Новый OpenSpec owner и routing — предложение. |
| Slate содержит частные рабочие Notes | [тип](/Users/Goodea/goodea/keryx/src/session/slate.ts:128), строки 128–150 | Notes не Seeds/proposal; private — модель использования, не доказанная confidentiality boundary против процесса с файловым доступом. |
| Enrich сохраняет accepted исходной страницы | [selection](/Users/Goodea/goodea/keryx/src/wiki/enrich.ts:300), строки 300–313; [writer](/Users/Goodea/goodea/keryx/src/wiki/enrich.ts:898), строки 898–906 | Не писать «enrich автоматически принимает draft». Accepted может сохраниться при изменённой prose через page/force. Это compositional source finding, не exploit-test. |
| Flow token не доказывает человека | [контракт](/Users/Goodea/goodea/keryx/src/flow/confirm-token.ts:1), строки 1–34 | Native shell approval floor существует; его нельзя распространять на любой внешний shell или считать server-authenticated team approval. TTL Flow здесь 10 минут; SAC token имеет отдельный контракт. |
| Vantage guard уже реализован | [wrapper/check](/Users/Goodea/work/vantage-frontend/src/test/msw/in-flight.ts:25), строки 25–50; [setup](/Users/Goodea/work/vantage-frontend/src/test/vitest.setup.ts:50), строки 50–58 | Есть код и hookup; текущий PASS тестов/CI не установлен. Unmatched-network guard — отдельный guard. |
| Tasks DoD отстал от наличия кода | [tasks](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/tasks.md:21), строки 21–27 | «Today» — сохранённая историческая запись, не текущий запуск и не доказательство провала HEAD. |
| Нет найденной связи change→Flow/wiki update | [scoped findings](vantage-findings.md) | Отсутствие связи ограничено перечисленными локальными scopes. Related wiki существует, но guard не описан; нельзя писать «wiki отсутствует». |

## Уточнения сценария и проектных обещаний

1. Requirement гарантирует диагностику перехваченных axios requests; Open Issues отдельно исключают fetch/direct axios: [spec](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/specs/test-tooling/spec.md:34). Не расширять на весь HTTP без нового требования/проверок. Число fetch call sites в Open Issues не повторять как измеренное сегодня.
2. Abort scenario проходит при settlement до check. Очистка Set изолирует регистрацию следующего теста; guard не отменяет pending requests и не гарантирует отсутствие любого воздействия позднего ответа на приложение. «Robin не обвинён этим guard за старую запись» точнее, чем «следующий тест полностью изолирован».
3. Scenario→AC mapping, protected review exact wiki revision, server Hub store и Git publication receipts — проектируемые действия. Сегодня этот сквозной Flow не выполнялся. SAC decision stub не подменяет patch существующей модульной wiki.
4. Уже выданная авторизация сохраняется; proposed deliveryContract должен определить конкретный subject и scopes, а не добавлять повторный вопрос на каждом чтении/тесте. Approval prose и финальная acceptance Flow остаются различными решениями.
5. 43 change directories не означают 43 нереализованных changes. Отсутствие archive/baseline/Flow link в локальном scope не доказывает отсутствие внешних процессов. Отсутствующий в PATH OpenSpec CLI не означает отсутствие у разработчиков.

## Ограничения и routing audit

Повторная проверка не запускала тесты, health, OpenSpec, sync/enrich/verify/review или Flow transitions; job state не читался и не менялся. Новое широкое исследование не проводилось. Сверка отрицательных результатов опирается на явные scopes первоначальных findings.

`graph_used`: yes, affected wiki owner и Vantage guard; graph predates ненормативные untracked backup/review trees, использован только как навигация, root source прочитан прямо. `wiki_used`: yes, через исходные findings и routed outline обоих indexes; новой архитектурной разведки не было. `ctx_used`: yes, compact findings/outline indexes, raw artifacts сохранены gdctx; точные короткие диапазоны дочитаны напрямую, поскольку summary недостаточна для semantic verification. `raw_rg_used`: no. Bootstrap indexes обоих проектов прочитаны до code navigation.
