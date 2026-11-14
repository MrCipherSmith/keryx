test('task status is not an agent reply status', async () => {
  const { taskStatus } = await import('./live.js');
  expect(taskStatus('done')).toBe('Завершена');
  expect(taskStatus('completed')).toBe('Завершена');
  expect(taskStatus('todo')).toBe('Ожидает');
});
test('request and plan precede potentially long project flow list', async () => {
  const source = await Bun.file(new URL('./main.js', import.meta.url)).text();
  expect(source.indexOf("this.card('request'")).toBeGreaterThan(0);
  expect(source.indexOf("this.card('request'")).toBeLessThan(source.indexOf("this.card('plan'"));
  expect(source.indexOf("this.card('plan'")).toBeLessThan(source.indexOf("this.card('flows'"));
});
import { expect, test } from 'bun:test';
import { parseSnapshot, selectAddress } from './live.js';
const snapshot = { version: 1, terminalId: 't2', projectPath: '/p', sessionId: 's', updatedAt: new Date().toISOString(), scope: 'project', flows: [], plan: null, issues: [] };
test('snapshot binding, version and heartbeat are checked', () => {
  expect(parseSnapshot(JSON.stringify(snapshot), 't2').state).toBe('live');
  expect(parseSnapshot(JSON.stringify(snapshot), 't3').state).toBe('unavailable');
  expect(parseSnapshot('{', 't2').state).toBe('unavailable');
  expect(parseSnapshot(null, 't2').state).toBe('unavailable');
  expect(parseSnapshot(JSON.stringify({ ...snapshot, updatedAt: '2020-01-01' }), 't2').state).toBe('stale');
});
test('selection follows focus only, ignoring obsolete manual selection', () => {
  const agents = [{ address: 't2', focused: false }, { address: 't3', focused: true }];
  expect(selectAddress(agents, null)).toBe('t3'); expect(selectAddress(agents, 't2')).toBe('t3');
  expect(selectAddress(agents.map(a => ({ ...a, focused: false })), null)).toBeNull();
  expect(selectAddress([{ address: 't2', focused: false }], null)).toBeNull();
  expect(selectAddress([{ address: 't2', focused: true }, { address: 't3', focused: true }], null)).toBeNull();
});
test('cockpit has no duplicated agent navigation and project flows start collapsed', async () => {
  const source = await Bun.file(new URL('./main.js', import.meta.url)).text();
  expect(source).not.toContain("this.card('live-agents'");
  expect(source).not.toContain('this.selected');
  expect(source).not.toContain("run('agent.focus'");
  expect(source).toContain('this.projectFlowsOpen = false');
  expect(source).toContain('К этой сессии Flow не привязан');
  expect(source).toContain('this.projectFlowsOpen ?');
  expect(source).toContain('Нет активного Keryx-терминала');
});
