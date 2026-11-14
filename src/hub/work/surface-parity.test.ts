// Flow 492 T12 (AC12): the quick-start request is built twice, once for the TUI and once for the web
// dialog. This test fails when a request field exists on one surface and not on the other, or when the
// two surfaces build different bodies from the same operator input. The Hub route is the third party:
// its accepted key set is read from `parseQuickStartBody` by probing it, not copied here.

import { describe, expect, test } from 'bun:test';
import { quickStartRequest, type QuickDraft } from '../../../apps/hub-web/src/features/managed-work/quick-request';
import { buildQuickStartRequest, QUICK_START_REQUEST_FIELDS } from '../../tui/quick-start-request';
import { questionsFor } from './clarify';
import { QUICK_MODES, type QuickModeId } from './quick-modes';
import { parseQuickStartBody } from './quick-start';

type Body = Record<string, unknown>;
type Builder = (scenario: Scenario) => Body;

/** One operator input, written once and handed to each surface in the shape its form holds. */
interface Scenario {
  readonly mode: QuickModeId;
  readonly description: string;
  /** Answered questions by template-question id; every other question of the mode is skipped. */
  readonly answered: Readonly<Record<string, string>>;
  readonly criteria: readonly string[];
}

const tui: Builder = (scenario) =>
  buildQuickStartRequest({
    mode: scenario.mode,
    description: scenario.description,
    answers: scenario.answered,
    criteria: scenario.criteria,
  }) as unknown as Body;

const web: Builder = (scenario) => {
  const skipped: Record<string, boolean> = {};
  const answers: Record<string, string> = {};
  for (const question of questionsFor(scenario.mode)) {
    const text = scenario.answered[question.id];
    if (text === undefined) {
      // The web form keeps what was typed before "skip" was ticked; the request must still drop it.
      answers[question.id] = 'typed before skipping';
      skipped[question.id] = true;
    } else answers[question.id] = text;
  }
  const draft: QuickDraft = {
    mode: scenario.mode,
    description: scenario.description,
    answers,
    skipped,
    criteria: scenario.criteria.join('\n'),
  };
  return quickStartRequest(draft) as unknown as Body;
};

/** The server-side key set, read from the parser: a key is accepted when dropping it breaks a valid body, and nothing else is. */
function serverKeys(valid: Body): { required: string[]; rejectsUnknown: boolean } {
  const throws = (body: Body): boolean => {
    try {
      parseQuickStartBody(body);
      return false;
    } catch {
      return true;
    }
  };
  expect(throws(valid)).toBe(false);
  const required = Object.keys(valid).filter((key) => {
    const { [key]: _dropped, ...rest } = valid;
    return throws(rest);
  });
  return { required, rejectsUnknown: throws({ ...valid, unexpectedField: 'x' }) };
}

/** Every way `candidate` differs from `reference`: missing keys, extra keys, and different values. Empty means parity. */
function differences(reference: Body, candidate: Body): string[] {
  const found: string[] = [];
  for (const key of Object.keys(reference)) {
    if (!(key in candidate)) found.push('missing field: ' + key);
    else if (JSON.stringify(candidate[key]) !== JSON.stringify(reference[key])) found.push('different value: ' + key);
  }
  for (const key of Object.keys(candidate)) if (!(key in reference)) found.push('extra field: ' + key);
  return found;
}

const sortedKeys = (body: Body): string[] => Object.keys(body).sort();

const scenario: Scenario = {
  mode: 'bug',
  description: 'The export button does nothing on the reports page',
  answered: {
    'steps-to-reproduce': 'Open reports, press Export',
    'expected-vs-actual': 'A file downloads; nothing happens',
  },
  criteria: ['The export downloads a CSV file', 'The button shows progress while exporting'],
};

describe('quick-start surface parity', () => {
  test('the fixture exercises answered, skipped and own-criteria input', () => {
    const body = tui(scenario) as { answers: { skipped: boolean }[]; criteria: string[] };
    expect(body.answers.filter((answer) => answer.skipped)).toHaveLength(1);
    expect(body.answers.filter((answer) => !answer.skipped)).toHaveLength(2);
    expect(body.criteria).toHaveLength(2);
  });

  test('each surface sends exactly the fields the Hub route accepts', () => {
    const fields = [...QUICK_START_REQUEST_FIELDS].sort();
    const server = serverKeys(tui(scenario));
    expect(server.rejectsUnknown).toBe(true);
    expect(server.required.sort()).toEqual(fields);
    expect(sortedKeys(tui(scenario))).toEqual(fields);
    expect(sortedKeys(web(scenario))).toEqual(fields);
  });

  test('the two surfaces build the same body from the same input', () => {
    expect(differences(tui(scenario), web(scenario))).toEqual([]);
    expect(web(scenario)).toEqual(tui(scenario));
  });

  test('both bodies pass the Hub route validation unchanged', () => {
    for (const build of [tui, web]) {
      const body = build(scenario);
      expect(parseQuickStartBody(body)).toEqual(body as unknown as ReturnType<typeof parseQuickStartBody>);
    }
  });

  test('every mode builds the same body on both surfaces, answered or all skipped', () => {
    expect(QUICK_MODES.length).toBeGreaterThan(0);
    for (const mode of QUICK_MODES) {
      const [first] = questionsFor(mode.id);
      const cases: Scenario[] = [
        { ...scenario, mode: mode.id, answered: first ? { [first.id]: 'one answer' } : {} },
        { ...scenario, mode: mode.id, answered: {} },
        { ...scenario, mode: mode.id, answered: {}, criteria: [] },
      ];
      for (const input of cases) {
        expect(differences(tui(input), web(input))).toEqual([]);
        expect(() => parseQuickStartBody(web(input))).not.toThrow();
        expect((web(input) as { answers: unknown[] }).answers).toHaveLength(questionsFor(mode.id).length);
      }
    }
  });

  describe('the guard bites', () => {
    test('identical bodies report no difference', () => {
      expect(differences(tui(scenario), tui(scenario))).toEqual([]);
    });

    test('a field added on one surface is reported', () => {
      const drifted: Builder = (input) => ({ ...web(input), priority: 'high' });
      expect(differences(tui(scenario), drifted(scenario))).toEqual(['extra field: priority']);
      expect(differences(drifted(scenario), tui(scenario))).toEqual(['missing field: priority']);
      expect(() => parseQuickStartBody(drifted(scenario))).toThrow();
    });

    test('a field missing on one surface is reported', () => {
      const drifted: Builder = (input) => {
        const { criteria: _dropped, ...rest } = web(input);
        return rest;
      };
      expect(differences(tui(scenario), drifted(scenario))).toEqual(['missing field: criteria']);
      expect(() => parseQuickStartBody(drifted(scenario))).toThrow();
    });

    test('a renamed field is reported as one missing and one extra', () => {
      const drifted: Builder = (input) => {
        const { description, ...rest } = web(input);
        return { ...rest, summary: description };
      };
      expect(differences(tui(scenario), drifted(scenario)).sort()).toEqual(['extra field: summary', 'missing field: description']);
    });

    test('the same keys with a different value are reported', () => {
      const drifted: Builder = (input) => ({ ...web(input), criteria: [] });
      expect(differences(tui(scenario), drifted(scenario))).toEqual(['different value: criteria']);
    });

    test('the server key probe refuses a body the route would reject', () => {
      expect(() => serverKeys({ ...tui(scenario), extra: 1 })).toThrow();
    });
  });
});
