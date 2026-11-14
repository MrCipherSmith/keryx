import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { agents, theme, run, appHome, readTextFile } from 'herdr';
import { parseSnapshot, selectAddress, taskStatus } from './live.js';
const statuses = { working: 'Работает', blocked: 'Нужен ответ', done: 'Ответ готов', idle: 'Готов к задаче', proposed: 'На согласовании', pending: 'Ожидает', in_progress: 'В работе', completed: 'Завершён', skipped: 'Пропущен', todo: 'Ожидает' };
export default class KeryxCockpit extends View {
  init(_, cx) {
    this.projectFlowsOpen = false;
    this.expandedFlowId = null;
    this.expandedTaskKey = null;
    this.result = { state: 'unavailable', reason: 'Подключение к мосту…' };
    cx.spawn(async cx => {
      for (;;) {
        const live = agents().filter(a => a.app === 'keryx');
        const address = selectAddress(live);
        let result = { state: 'unavailable', reason: 'Нет активного Keryx-терминала — выберите его в Herdr' };
        if (address && /^[a-zA-Z0-9_-]+$/.test(address)) {
          try { result = parseSnapshot(await readTextFile(`${appHome()}/data/keryx-cockpit/${address}.json`), address); }
          catch { result = { state: 'unavailable', reason: `Мост терминала ${address} недоступен. Shell должен быть запущен с поддержкой Cockpit` }; }
        } else if (address) result = { state: 'unavailable', reason: 'Удалённый мост пока не поддерживается' };
        if (this.address !== address || this.result.snapshot?.sessionId !== result.snapshot?.sessionId) {
          this.projectFlowsOpen = false;
          this.expandedFlowId = null;
          this.expandedTaskKey = null;
        }
        if (!result.snapshot?.flows.some(f => f.id === this.expandedFlowId)) this.expandedFlowId = null;
        if (this.expandedTaskKey && !result.snapshot?.flows.some(f => f.tasks.some(task => JSON.stringify([f.id, task.id]) === this.expandedTaskKey))) this.expandedTaskKey = null;
        this.address = address; this.result = result; cx.notify();
        await cx.sleep(2000);
      }
    });
  }
  text(value, color, size = 13) { return div().text_size(size).text_color(color).child(String(value)); }
  button(id, label, action, t, selected = false) {
    return div().id(id).px(10).py(6).rounded(6).bg(selected ? t.accent : t.raised)
      .text_color(selected ? t.background : t.foreground).text_size(12).cursor_pointer().on_click(action).child(label);
  }
  card(id, children, t) {
    return v_flex().id(id).p(14).gap(9).rounded(10).bg(t.surface).border_1().border_color(t.border).children(children);
  }
  visibleFlows(s) {
    return s.scope === 'project' ? s.flows.filter(f => f.status !== 'done') : s.flows;
  }
  taskRows(flowId, tasks, t) {
    return tasks.flatMap(task => {
      const key = JSON.stringify([flowId, task.id]), open = this.expandedTaskKey === key;
      return [this.button(`toggle-task-${key}`, `${open ? '▾' : '▸'} ${task.id} · ${task.title} — ${taskStatus(task.status)}`,
        (_, cx) => { this.expandedTaskKey = open ? null : key; cx.notify(); }, t),
        ...(open ? [
          this.text('ОПИСАНИЕ', t.muted, 11),
          this.text(task.description || 'Отдельное описание не записано', t.foreground),
          this.text(task.criteriaScope === 'flow' ? 'КРИТЕРИИ FLOW (нет привязки к задаче)' : 'КРИТЕРИИ ГОТОВНОСТИ', t.muted, 11),
          this.text(task.criteria || 'Критерии не записаны', t.foreground),
          this.text('РЕЗУЛЬТАТЫ (ЗАПИСАННЫЕ)', t.muted, 11),
          this.text(task.results || 'Результаты не записаны', t.foreground),
          ...(task.description === undefined ? [this.text('Shell передаёт старый формат: подробности доступны после обновления Shell', t.blocked)] : []),
        ] : [])];
    });
  }
  flowRows(s, t) {
    s = { ...s, flows: this.visibleFlows(s) };
    if (s.scope === 'project' && s.flows.length) {
      return s.flows.flatMap(f => {
        const open = this.expandedFlowId === f.id;
        const header = this.button(`toggle-flow-${f.id}`,
          `${open ? '▾' : '▸'} ${f.id} · ${f.title} · ${f.status} · ${f.tasks.length} задач`,
          (_, cx) => { this.expandedFlowId = open ? null : f.id; cx.notify(); }, t);
        const tasks = open ? (f.tasks.length
          ? this.taskRows(f.id, f.tasks, t)
          : [this.text('В этом Flow нет задач', t.muted)]) : [];
        return [header, ...tasks];
      });
    }
    return s.flows.length ? s.flows.flatMap(f => [this.text(`${f.id} · ${f.title} · ${f.status}`, t.accent, 15),
      ...this.taskRows(f.id, f.tasks, t)])
      : [this.text(s.issues.length ? 'Источник Flow недоступен — см. ошибки ниже' : s.scope === 'project' ? 'Нет открытых Flow проекта' : 'В этом контексте нет Flow', t.muted)];
  }
  render() {
    const t = theme(), live = agents().filter(a => a.app === 'keryx');
    const address = selectAddress(live);
    const result = address === this.address ? this.result : { state: 'unavailable', reason: 'Загрузка активной сессии Herdr…' };
    const s = result.snapshot ? { ...result.snapshot, flows: this.visibleFlows(result.snapshot) } : null;
    return v_flex().id('keryx-cockpit-root').size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(v_flex().id('cockpit-scroll').size_full().min_h(0).overflow_y_scrollbar().p(16).gap(14).children([
        h_flex().items_center().gap(10).children([this.text('KERYX COCKPIT', t.accent, 22), this.text('READ ONLY', t.muted, 11)]),
        this.text(result.state === 'live' ? 'Живые данные · обновление каждые 2 с' : result.state === 'stale' ? 'УСТАРЕВШИЕ ДАННЫЕ · Shell не обновляет мост' : result.reason, result.state === 'live' ? t.accent : t.blocked),
        ...(s ? [
          this.card('context', [this.text(s.projectPath, t.foreground), this.text(`Терминал: ${address} · Сессия: ${s.sessionId}`, t.muted),
            this.text(`Источник: ${s.sourcePath || s.projectPath}`, t.muted, 11), this.text(`Снимок: ${s.updatedAt}`, t.muted, 11)], t),
          this.card('request', [this.text('НАД ЧЕМ РАБОТАЕМ', t.muted, 11),
            this.text(s.request?.initial || 'Исходный запрос не передан этой версией Shell', t.foreground),
            ...(s.request && s.request.current !== s.request.initial ? [this.text('ТЕКУЩИЙ ЗАПРОС', t.muted, 11), this.text(s.request.current, t.foreground)] : []),
          ], t),
          this.card('plan', [this.text(`ПЛАН СЕССИИ${s.plan ? ` · РЕВИЗИЯ ${s.plan.revision}` : ''}`, t.muted, 11),
            ...(s.plan?.items.length ? s.plan.items.map(item => this.text(`${item.title} — ${statuses[item.status] || item.status}`, t.foreground)) : [this.text('План сессии не опубликован', t.muted)]),
          ], t),
          this.card('flows', [this.text('FLOW СЕССИИ', t.muted, 11),
            ...(s.scope === 'session' ? this.flowRows(s, t) : [this.text(s.issues.length ? 'Привязка Flow недоступна — см. ошибки ниже' : 'К этой сессии Flow не привязан', t.muted)]),
          ], t),
          ...(s.scope === 'project' ? [this.card('project-flows', [
            this.button('toggle-project-flows', `${this.projectFlowsOpen ? '▾' : '▸'} FLOW ПРОЕКТА · ${s.flows.length}`, (_, cx) => { this.projectFlowsOpen = !this.projectFlowsOpen; cx.notify(); }, t),
            ...(this.projectFlowsOpen ? this.flowRows(s, t) : []),
          ], t)] : []),
          ...(s.issues.length ? [this.card('issues', s.issues.map(issue => this.text(issue, t.blocked)), t)] : []),
        ] : []),
        this.text('Только чтение. Статусы задач не являются доказательством прохождения тестов или ревью.', t.muted, 11),
        this.button('cockpit-back', '← Обычный интерфейс Herdr', () => run('layout.switch', { name: 'main' }), t),
      ]));
  }
}
