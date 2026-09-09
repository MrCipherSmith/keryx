# Acceptance Criteria

- AC1: **AC-19**: Core-only packaging и smoke без клиента/ключей работают; клиент не импортирует private core; TUI/readline, streaming/cancel/resume проверяются отдельной матрицей.
- AC2: **AC-20**: Import-policy проверка ловит запрещённый fixture и проходит разрешённый; facade parity сохраняется при переносе; весь repo на пакеты не дробится без пользы.
- AC3: Current focused/type/build/health checks and independent review have explicit evidence; prerequisites are satisfied; no required failed/incomplete check is relabeled PASS; partial acceptance is not full phase completion.
