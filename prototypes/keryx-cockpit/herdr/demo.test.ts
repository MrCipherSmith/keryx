import { describe, expect, test } from 'bun:test';
import { scenarios, getScenario } from './demo.js';

describe('native Cockpit demo', () => {
  test('offers all six prototype scenarios', () => {
    expect(scenarios.map(s => s.id)).toEqual(['working', 'attention', 'verified', 'stale', 'no-flow', 'offline']);
  });
  test('always labels task data as demo, never live evidence', () => {
    for (const scenario of scenarios) {
      expect(scenario.demo).toBe(true);
      expect(scenario.steps.length).toBeGreaterThan(0);
      expect(scenario.evidence.every(e => e.includes('Демо'))).toBe(true);
    }
  });
  test('unknown scenario safely falls back to working', () => {
    expect(getScenario('missing').id).toBe('working');
  });
  test('missing and stale sources remain explicit', () => {
    expect(getScenario('offline').notice).toContain('Нет связи');
    expect(getScenario('stale').notice).toContain('устарели');
  });
});
