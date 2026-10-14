# Текущее состояние / Live status

Запуск (run, UTC): 2026-10-14 19:56 UTC

Состояние (status): ok
HEAD: ee443509a6c6f4cc4f7303cca4cae0a7fb73ae95
Строк в contribution-log.md (rows): 48

## Счётчики: снимок 04809f4f / сейчас (counts: snapshot / now)

| Ключ (key) | снимок 04809f4f | сейчас |
| --- | --- | --- |
| commit | 04809f4f | ee443509 |
| generated_at | 2026-10-04T13:17Z | 2026-10-14T19:56Z |
| flows | 383 | 421 |
| flows_by_status | done: 339, blocked: 2, in-progress: 25, ready: 3, initializing: 3, implemented: 11 | done: 347, blocked: 3, in-progress: 40, ready: 5, initializing: 7, implemented: 19 |
| acceptance_criteria | 3175 | 3570 |
| acceptance_criteria_confirmed | 3062 | 3210 |
| verify_tags | untagged: 2906, exec: 201, none: 16, judged: 31, invariant: 21 | untagged: 3090, exec: 351, none: 17, judged: 83, invariant: 29 |
| flows_since_baseline | 44 | 82 |
| outcome_author | None: 354, agent: 18, human: 11 | None: 371, agent: 32, human: 18 |
| origin | None: 373, human-request: 9, agent-finding: 1 | None: 379, agent-finding: 6, human-request: 33, agent-proposal: 3 |
| reviewed_flows | 159 | 176 |
| review_rounds | 368 | 420 |
| findings | 2544 | 2980 |
| findings_by_severity | major: 831, minor: 1204, info: 334, blocker: 175 | major: 923, minor: 1466, info: 414, blocker: 177 |
| findings_blocking | 175 | 177 |
| verdicts | refuted: 1623, confirmed: 329, no-verdict: 577, unverifiable: 15 | refuted: 1668, confirmed: 459, no-verdict: 834, unverifiable: 19 |
| refuted_by_disposition | acted-on: 1546, dismissed-incorrect: 49, no-disposition: 28 | acted-on: 1591, dismissed-incorrect: 49, no-disposition: 28 |

## Журнал решений (decisions journal)

- Решений (decisions): 62; с рекомендацией (with a recommendation): 42
- Совпадения, обычный режим (matches, normal): 18 из 25 (matched of answered)
- Совпадения, частично слепой режим (matches, partial): 3 из 4 (matched of answered)
- Совпадения, слепой режим (matches, blind): 6 из 11 (matched of answered)
- Отклонения (deviations): 13; с причиной (with a reason): 3; без причины (without a reason): 10
- Исключено как необратимые (excluded-irreversible): 3
- Прогресс к порогу P7 (150 обратимых вопросов на плечо, reversible questions per arm): A 1/150, B 3/150, C 1/150, D 0/150; порог достигнут (met): нет (no)
- Прогресс к AC11 флоу 392 (progress to AC11 of flow 392): решений 60/20, слепых 11/5; числа достигнуты (numeric targets met)
- Машин в журнале (machines in the journal): 5; записей по машинам (records per machine): 142cd74e 26, 1932608c 135, a90ce006 1, f2ede59b 34, fa7c0ca1 98
- Решений во всех машинах (decisions, all machines): 294; с рекомендацией (with a recommendation): 243; живых, не backfilled (live, not backfilled): 221

## Виды проверки (verification kinds)

- verification kinds, flows frozen in the last 7 days: 21 flows, 221 criteria, unclassified 86 (39%)
- WARNING: unclassified share 39% is above 20%: criteria are being frozen without a verification kind.
- sensitivity, flows frozen in the last 7 days: 0 of 102 exec/invariant criteria carry a sensitivity note (0%)
- Определение (definition): flows whose last `frozen` history entry is within 7 days before the run time above (UTC clock of this run); criteria are the `- ACn:` lines of each flow's acceptance-criteria.md; unclassified means no `[verify: ...]` marker or a malformed one.
