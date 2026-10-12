# Текущее состояние / Live status

Запуск (run, UTC): 2026-10-12 19:43 UTC

Состояние (status): ok
HEAD: 844afa2d101810806ed17938a79a3cc95fb64ccd
Строк в contribution-log.md (rows): 48

## Счётчики: снимок 04809f4f / сейчас (counts: snapshot / now)

| Ключ (key) | снимок 04809f4f | сейчас |
| --- | --- | --- |
| commit | 04809f4f | 844afa2d |
| generated_at | 2026-10-04T13:17Z | 2026-10-12T19:43Z |
| flows | 383 | 409 |
| flows_by_status | done: 339, blocked: 2, in-progress: 25, ready: 3, initializing: 3, implemented: 11 | done: 345, blocked: 3, in-progress: 33, ready: 3, initializing: 5, implemented: 20 |
| acceptance_criteria | 3175 | 3424 |
| acceptance_criteria_confirmed | 3062 | 3203 |
| verify_tags | untagged: 2906, exec: 201, none: 16, judged: 31, invariant: 21 | untagged: 3042, exec: 282, none: 17, judged: 55, invariant: 28 |
| flows_since_baseline | 44 | 70 |
| outcome_author | None: 354, agent: 18, human: 11 | None: 364, agent: 27, human: 18 |
| origin | None: 373, human-request: 9, agent-finding: 1 | None: 377, agent-finding: 3, human-request: 28, agent-proposal: 1 |
| reviewed_flows | 159 | 166 |
| review_rounds | 368 | 391 |
| findings | 2544 | 2646 |
| findings_by_severity | major: 831, minor: 1204, info: 334, blocker: 175 | major: 838, minor: 1274, info: 359, blocker: 175 |
| findings_blocking | 175 | 175 |
| verdicts | refuted: 1623, confirmed: 329, no-verdict: 577, unverifiable: 15 | refuted: 1668, confirmed: 344, no-verdict: 618, unverifiable: 16 |
| refuted_by_disposition | acted-on: 1546, dismissed-incorrect: 49, no-disposition: 28 | acted-on: 1591, dismissed-incorrect: 49, no-disposition: 28 |

## Журнал решений (decisions journal)

- Решений (decisions): 61; с рекомендацией (with a recommendation): 42
- Совпадения, обычный режим (matches, normal): 18 из 25 (matched of answered)
- Совпадения, частично слепой режим (matches, partial): 3 из 4 (matched of answered)
- Совпадения, слепой режим (matches, blind): 6 из 11 (matched of answered)
- Отклонения (deviations): 13; с причиной (with a reason): 3; без причины (without a reason): 10
- Исключено как необратимые (excluded-irreversible): 3
- Прогресс к порогу P7 (150 обратимых вопросов на плечо, reversible questions per arm): A 1/150, B 3/150, C 1/150, D 0/150; порог достигнут (met): нет (no)
- Прогресс к AC11 флоу 392 (progress to AC11 of flow 392): решений 59/20, слепых 11/5; числа достигнуты (numeric targets met)
- Машин в журнале (machines in the journal): 2; записей по машинам (records per machine): 1932608c 134, fa7c0ca1 28
- Решений во всех машинах (decisions, all machines): 162; с рекомендацией (with a recommendation): 127; живых, не backfilled (live, not backfilled): 89

## Виды проверки (verification kinds)

- verification kinds, flows frozen in the last 7 days: 16 flows, 145 criteria, unclassified 104 (72%)
- WARNING: unclassified share 72% is above 20%: criteria are being frozen without a verification kind.
- sensitivity, flows frozen in the last 7 days: 0 of 36 exec/invariant criteria carry a sensitivity note (0%)
- Определение (definition): flows whose last `frozen` history entry is within 7 days before the run time above (UTC clock of this run); criteria are the `- ACn:` lines of each flow's acceptance-criteria.md; unclassified means no `[verify: ...]` marker or a malformed one.
