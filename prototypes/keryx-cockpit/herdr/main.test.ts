import { expect, test } from 'bun:test';
test('project flow accordion renders only one open task list', async () => {
  const source = await Bun.file(new URL('./main.js', import.meta.url)).text();
  const element = () => {
    const data: any = { label: '', click: null };
    const p: any = new Proxy(data, { get: (o, k) => k in o ? o[k] : (...args: any[]) => {
      if (k === 'child') o.label = String(args[0]);
      if (k === 'on_click') o.click = args[0];
      return p;
    } });
    return p;
  };
  const C = new Function('View', 'div', 'v_flex', 'taskStatus', source.replace(/^import .*;\n/gm, '').replace('export default class', 'return class'))(class {}, element, element, (s: string) => s);
  const v = new C(); v.init(null, { spawn() {} });
  const s = { scope: 'project', issues: [], flows: ['a', 'b'].map(id => ({ id, title: id, status: 'active', tasks: [{ id: `${id}1`, title: `Task ${id}`, status: 'todo' }] })) };
  const cx = { notify() {} };
  const task = { id: 'T1', title: 'Details', status: 'todo', description: 'Specific description', criteria: 'AC1: works', criteriaScope: 'task', results: '12 passed' };
  expect(v.taskRows('a', [task], {})).toHaveLength(1);
  v.taskRows('a', [task], {})[0].click(null, cx);
  expect(v.taskRows('a', [task], {}).map((r: any) => r.label)).toEqual(['▾ T1 · Details — todo', 'ОПИСАНИЕ', 'Specific description', 'КРИТЕРИИ ГОТОВНОСТИ', 'AC1: works', 'РЕЗУЛЬТАТЫ (ЗАПИСАННЫЕ)', '12 passed']);
  expect(v.taskRows('b', [task], {})).toHaveLength(1);
  expect(v.flowRows({ ...s, scope: 'session', flows: [{ ...s.flows[0], tasks: [task] }] }, {}).map((r: any) => r.label)).toContain('Specific description');
  v.taskRows('a', [task], {})[0].click(null, cx);
  expect(v.taskRows('a', [task], {})).toHaveLength(1);
  const missing = { ...task, description: null, criteria: null, results: null };
  v.taskRows('a', [missing], {})[0].click(null, cx);
  expect(v.taskRows('a', [missing], {}).map((r: any) => r.label)).toContain('Результаты не записаны');

  expect(v.flowRows(s, {})).toHaveLength(2);
  v.flowRows(s, {})[0].click(null, cx);
  expect(v.flowRows(s, {}).map((r: any) => r.label)).toContain('▸ a1 · Task a — todo');
  v.flowRows(s, {}).at(-1).click(null, cx);
  expect(v.flowRows(s, {}).map((r: any) => r.label)).not.toContain('▸ a1 · Task a — todo');
  expect(v.flowRows(s, {}).map((r: any) => r.label)).toContain('▸ b1 · Task b — todo');
  v.flowRows(s, {})[1].click(null, cx); expect(v.flowRows(s, {})).toHaveLength(2);
  const flows = ['initializing', 'ready', 'in-progress', 'implemented', 'completing', 'blocked', 'done']
    .map(status => ({ id: status, title: status, status, tasks: [] }));
  const project = { ...s, flows };
  expect(v.visibleFlows(project).map((f: any) => f.status)).toEqual(flows.slice(0, -1).map(f => f.status));
  expect(v.flowRows(project, {})).toHaveLength(6);
  const closed = { ...s, flows: [flows.at(-1)] };
  expect(v.visibleFlows(closed)).toHaveLength(0);
  expect(v.flowRows(closed, {})[0].label).toBe('Нет открытых Flow проекта');
  expect(v.visibleFlows({ ...closed, scope: 'session' })).toHaveLength(1);
});
