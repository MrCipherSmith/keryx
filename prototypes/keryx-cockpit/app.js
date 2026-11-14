(() => {
  const { scenarios, planStates, present } = globalThis.CockpitModel;
  const $ = id => document.getElementById(id);
  const text = (id, value) => { $(id).textContent = value; };
  let current = "working";
  let toastTimer;
  function renderPlan(s) {
    $("plan").replaceChildren(...s.plan.map(step => {
      const li = document.createElement("li"); li.className = step.status;
      const icon = document.createElement("span"); icon.className = "step-icon"; icon.textContent = planStates[step.status].icon;
      const body = document.createElement("div");
      const title = document.createElement("div"); title.className = "step-title"; title.textContent = step.title;
      const detail = document.createElement("div"); detail.className = "step-sub"; detail.textContent = planStates[step.status].label + " · " + step.detail;
      body.append(title, detail); li.append(icon, body); return li;
    }));
  }
  function renderEvidence(s, v) {
    const box = document.createElement("div"); box.className = "evidence-box";
    const passed = s.evidence === "verified";
    for (const [name, value] of [["Тесты", passed ? "49 / 49 · демо" : "Ещё не подтверждены"], ["Ревью", passed ? "Замечания устранены · демо" : "Ещё не записано"]]) {
      const row = document.createElement("div"); row.className = "evidence-row";
      const label = document.createElement("span"); label.textContent = name;
      const result = document.createElement("span"); result.className = v.evidenceTone; result.textContent = value;
      row.append(label, result); box.append(row);
    }
    const caption = document.createElement("div"); caption.className = "evidence-caption";
    caption.textContent = ({ success: "Демонстрационная запись · demo-a17c · не результаты этого репозитория.", warning: "Исторические записи не подтверждают текущий код. Требуется обновление источника.", neutral: "Завершение ответа агента не означает, что задача проверена." })[v.evidenceTone];
    box.append(caption);
    const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Источник и привязка";
    const source = document.createElement("p"); source.className = "evidence-caption";
    source.textContent = s.flow === "bound" ? "Демо Flow #128 · completion attempt · ревизия " + (passed ? "demo-a17c" : "ещё не записана") : v.flowLabel + ". Доказательства Flow не загружены.";
    details.append(summary, source); box.append(details); $("evidence").replaceChildren(box);
  }
  function render() {
    const s = scenarios[current], v = present(s);
    document.body.dataset.scenario = current; document.body.dataset.source = s.source;
    for (const [id, value] of Object.entries({ title: s.title, source: v.sourceLabel, "flow-label": v.flowLabel, runtime: s.runtime, current: s.current, note: s.note, progress: `${v.completed} / ${v.total}`, event: s.event, "event-time": s.time })) text(id, value);
    $("progress-fill").style.width = `${v.completed / v.total * 100}%`;
    $("terminal-action").disabled = !v.canNavigate;
    $("terminal-action").textContent = v.needsAttention ? "Перейти к решению ↗" : "Открыть терминал ↗";
    renderPlan(s); renderEvidence(s, v);
    const logs = document.createElement("div"); logs.className = "terminal-output";
    for (const [title, sub] of [["✓ Причина найдена", "Refresh выполнялся для каждого запроса отдельно"], ["✓ Регрессионный тест добавлен", "Воспроизведён сценарий с истёкшим токеном"], ["◉ " + s.current, s.event]]) {
      const line = document.createElement("div"); line.className = "log"; line.textContent = title;
      const small = document.createElement("small"); small.textContent = sub; line.append(small); logs.append(line);
    }
    if (current === "unbound") logs.textContent = "◉ Уточняю сообщения CLI и подсказки пользователю. Работа идёт по отдельному плану сессии.";
    $("terminal-content").replaceChildren(logs);
  }
  for (const [id, s] of Object.entries(scenarios)) { const option = document.createElement("option"); option.value = id; option.textContent = s.label; $("scenario").append(option); }
  for (const s of Object.values(planStates)) { const span = document.createElement("span"); span.textContent = s.icon + " " + s.label; $("legend").append(span); }
  $("scenario").addEventListener("change", e => { current = e.target.value; render(); });
  $("width").addEventListener("click", () => { const narrow = document.body.classList.toggle("narrow"); $("width").setAttribute("aria-pressed", String(narrow)); $("width").textContent = narrow ? "Широкая панель" : "Узкая панель"; });
  $("pin").addEventListener("click", () => { const pinned = $("pin").getAttribute("aria-pressed") !== "true"; $("pin").setAttribute("aria-pressed", String(pinned)); $("pin").textContent = pinned ? "Закреплено" : "Закрепить"; text("toast", pinned ? "Демосессия закреплена. Живое переключение не подключено." : "Демосессия откреплена."); $("toast").classList.add("visible"); clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 3500); });
  $("terminal-action").addEventListener("click", () => { text("dialog-title", scenarios[current].terminal); text("command-preview", current === "attention" ? "Ожидает в Keryx: bun test src/auth/" : "Herdr → связанный терминал backend · t2y"); $("terminal-dialog").showModal(); });
  $("close-dialog").addEventListener("click", () => $("terminal-dialog").close());
  render();
})();
