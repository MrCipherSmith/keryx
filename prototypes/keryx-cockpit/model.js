(function (root) {
  const planStates = {
    proposed: { label: "Предложено", icon: "◇" },
    pending: { label: "Ожидает", icon: "○" },
    in_progress: { label: "В работе", icon: "◉" },
    completed: { label: "Завершено", icon: "✓" },
    blocked: { label: "Заблокировано", icon: "!" },
    skipped: { label: "Пропущено", icon: "–" }
  };
  const plan = [
    { title: "Воспроизвести истечение токена", status: "completed", detail: "Причина найдена · refresh выполнялся дважды" },
    { title: "Добавить регрессионный тест", status: "completed", detail: "RED · сценарий воспроизведён" },
    { title: "Исправить обновление сессии", status: "in_progress", detail: "Один refresh-запрос для параллельных обращений" },
    { title: "Проверить изменения", status: "pending", detail: "Тесты и независимое ревью" },
    { title: "Подготовить итог и доказательства", status: "proposed", detail: "План завершения ещё не согласован" }
  ];
  const base = { demo: true, title: "Сессия не должна заканчиваться неожиданно", runtime: "Работает", source: "fresh", flow: "bound", evidence: "pending", plan, current: "Исправляет обновление токена", note: "Причина найдена. Добавлен регрессионный тест; агент исправляет обработчик.", terminal: "backend · t2y", time: "сейчас", event: "Выделен единый refresh-запрос для параллельных обращений." };
  const scenarios = {
    working: { ...base, label: "В работе" },
    attention: { ...base, label: "Нужно решение", runtime: "Ждёт человека", current: "Нужно разрешение на запуск тестов", note: "Агент подготовил команду. Подтверждение остаётся в терминале Keryx.", attention: true, event: "Запрошено разрешение: bun test src/auth/" },
    verified: { ...base, label: "Результат", runtime: "Готов к вводу", current: "Исправление готово к твоей оценке", note: "В демосценарии записаны тесты и ревью для ревизии demo-a17c. Это не результаты текущего репозитория.", evidence: "verified", plan: plan.map(x => ({ ...x, status: "completed" })), event: "Зафиксированы доказательства для demo-a17c." },
    stale: { ...base, label: "Устарело", source: "stale", evidence: "verified", time: "12 минут назад", runtime: "Неизвестно", current: "Нужна свежая проверка состояния", note: "Последний snapshot устарел. Старые проверки не подтверждают текущую ревизию.", event: "Обновления publisher перестали поступать." },
    unbound: { ...base, label: "Без Flow", flow: "unbound", title: "Улучшить сообщения об ошибках CLI", current: "Работа по плану сессии", note: "Flow не привязан — обычная сессия остаётся полноценной. План и runtime доступны независимо.", plan: plan.map((x,i) => ({ ...x, title: ["Изучить сообщения CLI", "Добавить тест ошибки", "Уточнить подсказки", "Проверить вывод", "Подготовить итог"][i] })) },
    offline: { ...base, label: "Нет связи", source: "offline", flow: "unavailable", runtime: "Недоступен", current: "Нет связи с источником", note: "Показан последний известный план. Привязку терминала нельзя проверить — навигация отключена.", time: "связь потеряна", event: "Не удалось прочитать snapshot сессии." }
  };
  function present(s) {
    return { completed: s.plan.filter(x => x.status === "completed").length, total: s.plan.length,
      evidenceTone: s.source !== "fresh" ? "warning" : s.evidence === "verified" ? "success" : "neutral",
      sourceLabel: ({ fresh: "Демоданные · сейчас", stale: "Данные устарели · 12 мин", offline: "Источник недоступен" })[s.source],
      flowLabel: ({ bound: "Flow #128 · демо", unbound: "Flow не привязан", unavailable: "Источник недоступен" })[s.flow],
      needsAttention: Boolean(s.attention), action: "terminal-preview", canNavigate: s.source === "fresh" };
  }
  root.CockpitModel = { scenarios, planStates, present };
  if (typeof exports !== "undefined") Object.assign(exports, root.CockpitModel);
})(globalThis);
