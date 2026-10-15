# Текущее состояние / Live status

Запуск (run, UTC): 2026-10-15 07:32 UTC

Состояние (status): ok
HEAD: 12fc4732cb4a0d4a260a65b5b107fa3532ee9cfd
Строк в contribution-log.md (rows): 48

## Счётчики: снимок 04809f4f / сейчас (counts: snapshot / now)

| Ключ (key) | снимок 04809f4f | сейчас |
| --- | --- | --- |
| commit | 04809f4f | 12fc4732 |
| generated_at | 2026-10-04T13:17Z | 2026-10-15T07:33Z |
| flows | 383 | 422 |
| flows_by_status | done: 339, blocked: 2, in-progress: 25, ready: 3, initializing: 3, implemented: 11 | done: 347, blocked: 3, in-progress: 41, ready: 5, initializing: 7, implemented: 19 |
| acceptance_criteria | 3175 | 3576 |
| acceptance_criteria_confirmed | 3062 | 3210 |
| verify_tags | untagged: 2906, exec: 201, none: 16, judged: 31, invariant: 21 | untagged: 3090, exec: 356, none: 17, judged: 83, invariant: 30 |
| flows_since_baseline | 44 | 83 |
| outcome_author | None: 354, agent: 18, human: 11 | None: 372, agent: 32, human: 18 |
| origin | None: 373, human-request: 9, agent-finding: 1 | None: 379, agent-finding: 6, human-request: 34, agent-proposal: 3 |
| reviewed_flows | 159 | 176 |
| review_rounds | 368 | 420 |
| findings | 2544 | 2980 |
| findings_by_severity | major: 831, minor: 1204, info: 334, blocker: 175 | major: 923, minor: 1466, blocker: 177, info: 414 |
| findings_blocking | 175 | 177 |
| verdicts | refuted: 1623, confirmed: 329, no-verdict: 577, unverifiable: 15 | refuted: 1668, no-verdict: 834, confirmed: 459, unverifiable: 19 |
| refuted_by_disposition | acted-on: 1546, dismissed-incorrect: 49, no-disposition: 28 | acted-on: 1591, dismissed-incorrect: 49, no-disposition: 28 |

## Журнал решений (decisions journal)

- Решений (decisions): 53; с рекомендацией (with a recommendation): 45
- Совпадения, обычный режим (matches, normal): 35 из 36 (matched of answered)
- Совпадения, частично слепой режим (matches, partial): 5 из 5 (matched of answered)
- Совпадения, слепой режим (matches, blind): 3 из 4 (matched of answered)
- Отклонения (deviations): 2; с причиной (with a reason): 2; без причины (without a reason): 0
- Исключено как необратимые (excluded-irreversible): 34
- Прогресс к порогу P7 (150 обратимых вопросов на плечо, reversible questions per arm): A 6/150, B 3/150, C 2/150, D 4/150; порог достигнут (met): нет (no)
- Прогресс к AC11 флоу 392 (progress to AC11 of flow 392): решений 53/20, слепых 4/5; числа не достигнуты (numeric targets not met)
- Машин в журнале (machines in the journal): 12; записей по машинам (records per machine): 0155ba5b 7, 03f624d1 11, 142cd74e 53, 1932608c 135, 88997f59 47, 8ff58fff 18, a90ce006 1, ce88bc99 68, d6347c29 1, f2aff11d 5, f2ede59b 34, fa7c0ca1 119
- Решений во всех машинах (decisions, all machines): 499; с рекомендацией (with a recommendation): 425; живых, не backfilled (live, not backfilled): 426

## Виды проверки (verification kinds)

- verification kinds, flows frozen in the last 7 days: 22 flows, 227 criteria, unclassified 86 (38%)
- WARNING: unclassified share 38% is above 20%: criteria are being frozen without a verification kind.
- sensitivity, flows frozen in the last 7 days: 0 of 108 exec/invariant criteria carry a sensitivity note (0%)
- Определение (definition): flows whose last `frozen` history entry is within 7 days before the run time above (UTC clock of this run); criteria are the `- ACn:` lines of each flow's acceptance-criteria.md; unclassified means no `[verify: ...]` marker or a malformed one.
