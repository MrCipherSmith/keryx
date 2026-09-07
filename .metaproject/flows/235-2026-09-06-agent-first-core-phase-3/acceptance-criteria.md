# Acceptance Criteria

- AC1: **AC-07**: Уникальный термин только в Details находится; бессмысленный запрос не получает уверенный ответ; RU/EN и идентификаторы включены в фиксированный корпус.
- AC2: **AC-12**: Seed и известные consumers/tests возвращаются без алфавитного вытеснения; нулевой ballast отсутствует; при overflow видны потеря/продолжение или mandatory-overflow.
- AC3: **AC-14**: Markdown сохраняет ограничение, JSON валиден, failed tests/exit code не теряются; неверная база возвращает full-view с причиной; короткий ввод не раздувается.
- AC4: **AC-30**: Доступный пропуск раскрывается по адресу без поиска; усечение manifest видно; закрытый объект не выдаёт existence/id; pure search не пишет history.
- AC5: **AC-M03**: Missing file, broken index, nonsense и слабый lexical сигнал дают разные коды; next action не заставляет полный обход; score не назван вероятностью.
- AC6: **AC-M04**: Отдельные description-only, symbol и impact fixtures имеют объяснимые candidates; важный связанный код не уступает нерелевантной глобальной популярности.
- AC7: **AC-W01**: Термин в Details/Main flows/Constraints находится; duplicate headings разных доменов различимы; rename сохраняет stable id, deleted id не перенаправляется молча.
- AC8: **AC-W02**: Синтетическая страница отвечает на заранее заданный why/rule вопрос; причины без источника unknown; счётчик страниц не используется как completeness.
- AC9: **AC-W04**: Обязательное исключение не теряется; конфликтующие источники явно paired; stale/draft не verified; mandatory overflow возвращает ошибку, а не сокращённое правило.
- AC10: Current focused/type/build/health checks and independent review have explicit evidence; prerequisites are satisfied; no required failed/incomplete check is relabeled PASS; partial acceptance is not full phase completion.
