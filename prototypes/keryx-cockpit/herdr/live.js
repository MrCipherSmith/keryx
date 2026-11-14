const taskStatuses = { done: 'Завершена', completed: 'Завершена', todo: 'Ожидает', pending: 'Ожидает', in_progress: 'В работе', blocked: 'Заблокирована', skipped: 'Пропущена', cancelled: 'Отменена' };
export function taskStatus(status) { return taskStatuses[status] || status; }
// Pure snapshot boundary, shared by the native mod and Bun tests.
export function selectAddress(agents) {
  const focused = agents.filter(a => a.focused);
  return focused.length === 1 ? focused[0].address : null;
}
const row = x => x && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.status === 'string';
export function parseSnapshot(text, terminalId, now = Date.now()) {
  try {
    const s = JSON.parse(text);
    if (!s || s.version !== 1 || s.terminalId !== terminalId ||
        typeof s.projectPath !== 'string' || typeof s.sessionId !== 'string' ||
        !['project', 'session'].includes(s.scope) ||
        !Array.isArray(s.flows) || !s.flows.every(f => row(f) && Array.isArray(f.tasks) && f.tasks.every(row)) ||
        !Array.isArray(s.issues) || !s.issues.every(x => typeof x === 'string') ||
        !(s.request === undefined || s.request === null || (typeof s.request.initial === 'string' && typeof s.request.current === 'string')) ||
        !(s.plan === null || (s.plan && Number.isInteger(s.plan.revision) && Array.isArray(s.plan.items) && s.plan.items.every(row)))) {
      return { state: 'unavailable', reason: 'Нет совместимого снимка этой сессии' };
    }
    const age = now - Date.parse(s.updatedAt);
    if (!Number.isFinite(age) || age < -5000) return { state: 'unavailable', reason: 'Некорректное время снимка' };
    return { state: age > 10000 ? 'stale' : 'live', snapshot: s };
  } catch { return { state: 'unavailable', reason: 'Мост ещё не подключён или снимок недоступен' }; }
}
