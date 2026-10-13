# Текущее состояние / Live status

Запуск (run, UTC): 2026-10-13 11:51 UTC

Состояние (status): ok
HEAD: 9449cd8cc9ffaad887b2844220b98a1b11ea5e95
Строк в contribution-log.md (rows): 48

## Счётчики: снимок 04809f4f / сейчас (counts: snapshot / now)

| Ключ (key) | снимок 04809f4f | сейчас |
| --- | --- | --- |
| commit | 04809f4f | 9449cd8cc |
| generated_at | 2026-10-04T13:17Z | 2026-10-13T11:51Z |
| flows | 383 | 413 |
| flows_by_status | done: 339, blocked: 2, in-progress: 25, ready: 3, initializing: 3, implemented: 11 | done: 347, blocked: 3, in-progress: 35, ready: 4, initializing: 5, implemented: 19 |
| acceptance_criteria | 3175 | 3479 |
| acceptance_criteria_confirmed | 3062 | 3203 |
| verify_tags | untagged: 2906, exec: 201, none: 16, judged: 31, invariant: 21 | untagged: 3060, exec: 298, none: 17, judged: 76, invariant: 28 |
| flows_since_baseline | 44 | 74 |
| outcome_author | None: 354, agent: 18, human: 11 | None: 365, agent: 30, human: 18 |
| origin | None: 373, human-request: 9, agent-finding: 1 | None: 379, agent-finding: 3, human-request: 30, agent-proposal: 1 |
| reviewed_flows | 159 | 173 |
| review_rounds | 368 | 404 |
| findings | 2544 | 2732 |
| findings_by_severity | major: 831, minor: 1204, info: 334, blocker: 175 | major: 858, minor: 1320, blocker: 176, info: 378 |
| findings_blocking | 175 | 176 |
| verdicts | refuted: 1623, confirmed: 329, no-verdict: 577, unverifiable: 15 | refuted: 1668, no-verdict: 661, confirmed: 384, unverifiable: 19 |
| refuted_by_disposition | acted-on: 1546, dismissed-incorrect: 49, no-disposition: 28 | acted-on: 1591, dismissed-incorrect: 49, no-disposition: 28 |

## Журнал решений (decisions journal)

- Решений (decisions): 98; с рекомендацией (with a recommendation): 89
- Совпадения, обычный режим (matches, normal): 62 из 64 (matched of answered)
- Совпадения, частично слепой режим (matches, partial): 15 из 15 (matched of answered)
- Совпадения, слепой режим (matches, blind): 8 из 9 (matched of answered)
- Отклонения (deviations): 3; с причиной (with a reason): 1; без причины (without a reason): 2
- Исключено как необратимые (excluded-irreversible): 57
- Прогресс к порогу P7 (150 обратимых вопросов на плечо, reversible questions per arm): A 15/150, B 9/150, C 6/150, D 9/150; порог достигнут (met): нет (no)
- Прогресс к AC11 флоу 392 (progress to AC11 of flow 392): решений 97/20, слепых 9/5; числа достигнуты (numeric targets met)
- Машин в журнале (machines in the journal): 2; записей по машинам (records per machine): 1932608c 134, fa7c0ca1 98
- Решений во всех машинах (decisions, all machines): 232; с рекомендацией (with a recommendation): 194; живых, не backfilled (live, not backfilled): 159

## Виды проверки (verification kinds)

- verification kinds, flows frozen in the last 7 days: 17 flows, 175 criteria, unclassified 97 (55%)
- WARNING: unclassified share 55% is above 20%: criteria are being frozen without a verification kind.
- sensitivity, flows frozen in the last 7 days: 0 of 51 exec/invariant criteria carry a sensitivity note (0%)
- Определение (definition): flows whose last `frozen` history entry is within 7 days before the run time above (UTC clock of this run); criteria are the `- ACn:` lines of each flow's acceptance-criteria.md; unclassified means no `[verify: ...]` marker or a malformed one.
