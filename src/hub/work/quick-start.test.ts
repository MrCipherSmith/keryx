import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Principal } from '../contracts';
import { HubFailure } from '../domain';
import { openHubStore, type HubStore } from '../store';
import { buildAnswers } from './clarify';
import { workRead } from './domain';
import type { FlowRevision, WorkRecord } from './model';
import { getMode, QUICK_MODES } from './quick-modes';
import { parseQuickStartBody, quickStart, type QuickStartDeps, type QuickStartRequest } from './quick-start';

/*
 * Contract under test (src/hub/work/quick-start.ts, flow 492 T8):
 *
 *   quickStart(deps: { store: HubStore; now: () => number }, actor: Principal, projectId: string,
 *              request: { operationId, mode, description, answers: ClarifyAnswer[], criteria: string[] }): WorkReceipt
 *
 * Synchronous. It opens ONE `deps.store.workTransaction` and composes flow.create -> intent.create ->
 * flow.approve-and-start inside it, calling `deps.now()` exactly once per composed command and nowhere else.
 * The receipt is a normal WorkReceipt; its `result` is `{ flowId, intentId }`. Failures are HubFailure.
 */

const P = 'p';
const human: Principal = { id: 'human:operator', kind: 'human', role: 'operator' };
const agent: Principal = { id: 'agent:worker', kind: 'agent', role: 'agent' };
const NOW = Date.parse('2026-11-14T10:00:00.000Z');
let dir: string;
let store: HubStore;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hub-quick-start-'));
    store = openHubStore(dir);
    store.writeTransaction(legacy => {
        legacy.projects.push({ id: P, name: 'P', version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0 });
    });
});
afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const deps = (override: Partial<QuickStartDeps> = {}): QuickStartDeps => ({ store, now: () => NOW, ...override });
let sequence = 0;
function request(override: Partial<QuickStartRequest> = {}): QuickStartRequest {
    return {
        operationId: 'quick-start-' + ++sequence,
        mode: 'bug',
        description: 'Save button does nothing on the settings page',
        answers: buildAnswers('bug', { 'steps-to-reproduce': 'Open settings, press Save', 'expected-vs-actual': 'Values should be saved, nothing happens' }),
        criteria: ['Settings persist after a reload'],
        ...override,
    };
}

const snapshot = () => store.work.load(P);
function ofKind<K extends WorkRecord['kind']>(kind: K): Extract<WorkRecord, { kind: K }>[] {
    return snapshot().records.filter((record): record is Extract<WorkRecord, { kind: K }> => record.kind === kind);
}
function expectNothingWritten() {
    const state = snapshot();
    expect(state.records).toHaveLength(0);
    expect(state.events).toHaveLength(0);
    expect(Object.keys(state.operations)).toHaveLength(0);
}
function failureOf(action: () => unknown): HubFailure {
    try {
        action();
    } catch (error) {
        if (error instanceof HubFailure) return error;
        throw error;
    }
    throw new Error('Expected a HubFailure, but the call succeeded');
}
/** The Flow plus its approved (frozen) revision. */
function startedFlow() {
    const [flow] = ofKind('flow');
    const revisions = ofKind('flow-revision');
    const approved = revisions.find(revision => revision.id === flow!.approvedRevisionId)!;
    return { flow: flow!, approved, revisions };
}
const problemLines = () => startedFlow().approved.problem.split('\n');

describe('AC4: one-line description becomes a started Flow in one go', () => {
    test('creates a Flow with no specification, one intent and the frozen template plus own criteria', () => {
        const body = request({ mode: 'bug', description: 'Save button does nothing', criteria: ['Settings persist after a reload', 'No console errors on save'] });
        const receipt = quickStart(deps(), human, P, body);
        const { flow, approved, revisions } = startedFlow();
        expect(ofKind('flow')).toHaveLength(1);
        expect(flow.state).toBe('in-progress');
        expect(flow.approvedRevisionId).not.toBeNull();
        expect(flow.title.trim().length).toBeGreaterThan(0);
        expect(revisions.length).toBeGreaterThanOrEqual(1);
        expect(approved.specification).toBeNull();
        expect(approved.criteria.map(criterion => criterion.text)).toEqual([...getMode('bug').criteriaTemplate, ...body.criteria]);
        const intents = ofKind('intent');
        expect(intents).toHaveLength(1);
        expect(intents[0]).toMatchObject({ flowId: flow.id, state: 'ready', required: true });
        expect(approved.requiredIntentIds).toEqual([intents[0]!.id]);
        const intentRevision = ofKind('intent-revision').find(revision => revision.id === intents[0]!.approvedRevisionId)!;
        expect(intentRevision.flowRevisionId).toBe(approved.id);
        expect([...intentRevision.flowCriterionIds].sort()).toEqual(approved.criteria.map(criterion => criterion.criterionId).sort());
        expect(receipt.status).toBe('committed');
        expect(receipt.result).toMatchObject({ flowId: flow.id, intentId: intents[0]!.id });
    });

    for (const mode of QUICK_MODES) {
        test(`${mode.id} mode freezes its criteria template ahead of the operator's own`, () => {
            quickStart(deps(), human, P, request({ mode: mode.id, answers: buildAnswers(mode.id, {}), criteria: ['Operator criterion'] }));
            expect(startedFlow().approved.criteria.map(criterion => criterion.text)).toEqual([...mode.criteriaTemplate, 'Operator criterion']);
        });
    }

    test('works with no criteria of its own (template only)', () => {
        quickStart(deps(), human, P, request({ mode: 'quick', answers: buildAnswers('quick', {}), criteria: [] }));
        expect(startedFlow().approved.criteria.map(criterion => criterion.text)).toEqual([...getMode('quick').criteriaTemplate]);
    });

    test('every criterion has a non-empty, unique, deterministic criterionId', () => {
        const body = request();
        quickStart(deps(), human, P, body);
        quickStart(deps(), human, P, { ...body, operationId: 'quick-start-again' });
        const [first, second] = ofKind('flow').map(flow => ofKind('flow-revision').find(revision => revision.id === flow.approvedRevisionId)!);
        const ids = first!.criteria.map(criterion => criterion.criterionId);
        expect(ids.every(id => id.length > 0)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
        expect(second!.criteria.map(criterion => criterion.criterionId)).toEqual(ids);
    });

    test('every confirmation recorded belongs to the signed-in human', () => {
        quickStart(deps(), human, P, request());
        const decisions = ofKind('decision');
        expect(decisions.length).toBeGreaterThan(0);
        expect(decisions.every(decision => decision.actorKind === 'human' && decision.createdBy === human.id)).toBe(true);
        expect(snapshot().records.every(record => record.createdBy === human.id)).toBe(true);
    });
});

describe('AC5: operation id is the idempotency key', () => {
    test('replaying the same request returns the stored receipt and creates nothing new', () => {
        const body = request();
        const first = quickStart(deps(), human, P, body);
        const before = JSON.stringify(snapshot());
        const second = quickStart(deps(), human, P, structuredClone(body));
        expect(second).toEqual(first);
        expect(ofKind('flow')).toHaveLength(1);
        expect(ofKind('intent')).toHaveLength(1);
        expect(JSON.stringify(snapshot())).toBe(before);
    });

    test('the stored receipt survives a store restart', () => {
        const body = request();
        const first = quickStart(deps(), human, P, body);
        store.close();
        store = openHubStore(dir);
        const replay = quickStart(deps(), human, P, body);
        expect(replay).toEqual(first);
        expect(ofKind('flow')).toHaveLength(1);
    });

    const changes: [string, Partial<QuickStartRequest>][] = [
        ['description', { description: 'A different description' }],
        ['mode', { mode: 'task', answers: buildAnswers('task', {}) }],
        ['answers', { answers: buildAnswers('bug', { 'affected-area': 'Settings' }) }],
        ['criteria', { criteria: ['Another criterion'] }],
    ];
    for (const [field, change] of changes) {
        test(`the same id with a different ${field} is an idempotency-conflict (409) and changes nothing`, () => {
            const body = request();
            quickStart(deps(), human, P, body);
            const before = JSON.stringify(snapshot());
            const failure = failureOf(() => quickStart(deps(), human, P, { ...body, ...change }));
            expect(failure.status).toBe(409);
            expect(failure.code).toBe('idempotency-conflict');
            expect(JSON.stringify(snapshot())).toBe(before);
        });
    }

    test('a different operation id with the same body is a new Flow', () => {
        const body = request();
        quickStart(deps(), human, P, body);
        quickStart(deps(), human, P, { ...body, operationId: body.operationId + '-second' });
        expect(ofKind('flow')).toHaveLength(2);
    });
});

describe('AC6: the clarifying form is recorded on the Flow', () => {
    test('a skipped form is recorded with the exact skip line and the description', () => {
        const body = request({ description: 'Checkout total is wrong', answers: buildAnswers('bug', {}) });
        quickStart(deps(), human, P, body);
        expect(problemLines()).toContain('Clarifying form: skipped');
        expect(startedFlow().approved.problem).toContain('Checkout total is wrong');
    });

    test('the skip record is readable from the Flow through the work read API', () => {
        quickStart(deps(), human, P, request({ answers: buildAnswers('bug', {}) }));
        const { flow } = startedFlow();
        const url = new URL('http://hub.test/flows/' + flow.id);
        const projection = workRead(store.work.readState(P, ['flows', flow.id], url), human, P, ['flows', flow.id], url) as { records: WorkRecord[] };
        const revision = projection.records.find((record): record is FlowRevision => record.kind === 'flow-revision' && record.id === flow.approvedRevisionId)!;
        expect(revision.problem.split('\n')).toContain('Clarifying form: skipped');
    });

    test('a wholly skipped form records the skip line and every question under its own name', () => {
        quickStart(deps(), human, P, request({ answers: buildAnswers('bug', {}) }));
        const lines = problemLines();
        expect(lines).toContain('Clarifying form: skipped');
        for (const question of ['steps-to-reproduce', 'expected-vs-actual', 'affected-area']) {
            expect(lines[lines.indexOf('Q: ' + question) + 1]).toBe('Skipped');
        }
    });

    test('a blank answer reads as a skipped question, not an empty answer line', () => {
        quickStart(deps(), human, P, request({
            answers: [{ q: 'steps-to-reproduce', a: '   ', skipped: false }, { q: 'expected-vs-actual', a: 'Saved values', skipped: false }],
        }));
        const lines = problemLines();
        expect(lines[lines.indexOf('Q: steps-to-reproduce') + 1]).toBe('Skipped');
        expect(lines).not.toContain('Clarifying form: skipped');
    });

    test('an answer marked skipped is recorded as skipped even when it carries text', () => {
        quickStart(deps(), human, P, request({
            answers: [{ q: 'steps-to-reproduce', a: 'typed then skipped', skipped: true }, { q: 'expected-vs-actual', a: 'Saved values', skipped: false }],
        }));
        const lines = problemLines();
        expect(lines[lines.indexOf('Q: steps-to-reproduce') + 1]).toBe('Skipped');
        expect(lines).not.toContain('A: typed then skipped');
        expect(lines).toContain('A: Saved values');
    });

    test('a partly answered form lists Q/A lines and has no skip line', () => {
        quickStart(deps(), human, P, request({
            answers: buildAnswers('bug', { 'steps-to-reproduce': 'Open settings, press Save', 'expected-vs-actual': 'Saved values, got nothing' }),
        }));
        const lines = problemLines();
        expect(lines).toContain('Q: steps-to-reproduce');
        expect(lines).toContain('A: Open settings, press Save');
        expect(lines).toContain('Q: expected-vs-actual');
        expect(lines).toContain('A: Saved values, got nothing');
        expect(lines).not.toContain('Clarifying form: skipped');
    });

    test('a skipped question is recorded under its own name, also when other questions were answered', () => {
        quickStart(deps(), human, P, request({
            answers: buildAnswers('bug', { 'steps-to-reproduce': 'Open settings, press Save' }),
        }));
        const lines = problemLines();
        const at = lines.indexOf('Q: expected-vs-actual');
        expect(at).toBeGreaterThan(-1);
        expect(lines[at + 1]).toBe('Skipped');
        expect(lines[lines.indexOf('Q: affected-area') + 1]).toBe('Skipped');
        expect(lines[lines.indexOf('Q: steps-to-reproduce') + 1]).toBe('A: Open settings, press Save');
        expect(lines).not.toContain('Clarifying form: skipped');
    });

    test('a fully answered form has no skip line', () => {
        quickStart(deps(), human, P, request({
            answers: buildAnswers('bug', { 'steps-to-reproduce': 'one', 'expected-vs-actual': 'two', 'affected-area': 'three' }),
        }));
        const lines = problemLines();
        expect(lines).toEqual(expect.arrayContaining(['Q: steps-to-reproduce', 'A: one', 'Q: expected-vs-actual', 'A: two', 'Q: affected-area', 'A: three']));
        expect(lines).not.toContain('Clarifying form: skipped');
    });
});

describe('AC7: the three composed commands commit together or not at all', () => {
    // flow.create, intent.create and flow.approve-and-start each read deps.now() once, in that order;
    // the clock is the narrow injected seam, so call 2 fails intent.create and call 3 fails the start.
    const failingClock = (failingCall: number) => {
        let calls = 0;
        return () => {
            if (++calls === failingCall) throw new Error('clock failed on call ' + failingCall);
            return NOW;
        };
    };

    for (const failingCall of [2, 3]) {
        test(`a failure in composed command ${failingCall} leaves no Flow, intent, criteria, event or receipt`, () => {
            const body = request();
            expect(() => quickStart(deps({ now: failingClock(failingCall) }), human, P, body)).toThrow('clock failed on call ' + failingCall);
            expectNothingWritten();
            expect(ofKind('flow')).toHaveLength(0);
            expect(ofKind('intent')).toHaveLength(0);
            expect(ofKind('flow-revision')).toHaveLength(0);
            expect(ofKind('decision')).toHaveLength(0);
        });
    }

    test('earlier committed work is untouched and the same operation id can be retried afterwards', () => {
        quickStart(deps(), human, P, request({ description: 'Earlier, successful work' }));
        const before = JSON.stringify(snapshot());
        const retry = request({ description: 'Work that fails on the last step' });
        expect(() => quickStart(deps({ now: failingClock(3) }), human, P, retry)).toThrow('clock failed');
        expect(JSON.stringify(snapshot())).toBe(before);
        quickStart(deps(), human, P, retry);
        expect(ofKind('flow')).toHaveLength(2);
        expect(ofKind('intent')).toHaveLength(2);
    });
});

describe('AC8: only the signed-in human can freeze criteria', () => {
    const refused: [string, Principal | null][] = [
        ['an agent', agent],
        ['an agent credential carrying the operator role', { id: 'agent:worker', kind: 'agent', role: 'operator' }],
        ['a human principal without a human role', { id: 'human:operator', kind: 'human', role: 'agent' }],
    ];
    for (const [label, actor] of refused) {
        test(`${label} is refused with 403 and nothing is created`, () => {
            const failure = failureOf(() => quickStart(deps(), actor as Principal, P, request()));
            expect(failure.status).toBe(403);
            expectNothingWritten();
        });
    }

    test('a request without any session is refused and nothing is created', () => {
        expect(() => quickStart(deps(), null as unknown as Principal, P, request())).toThrow();
        expectNothingWritten();
    });

    test('a read-only human is refused', () => {
        const failure = failureOf(() => quickStart(deps(), { ...human, readOnly: true }, P, request()));
        expect(failure.status).toBe(403);
        expectNothingWritten();
    });

    test('a human outside the project scope is refused', () => {
        const failure = failureOf(() => quickStart(deps(), { ...human, projectIds: ['other'] }, P, request()));
        expect(failure.status).toBe(404);
        expectNothingWritten();
    });

    test('an unknown project is refused', () => {
        const failure = failureOf(() => quickStart(deps(), human, 'missing', request()));
        expect(failure.status).toBe(404);
        expectNothingWritten();
    });

    test('an agent cannot replay a human receipt or reuse its operation id', () => {
        const body = request();
        quickStart(deps(), human, P, body);
        const before = JSON.stringify(snapshot());
        const failure = failureOf(() => quickStart(deps(), agent, P, body));
        expect(failure.status).toBe(403);
        expect(JSON.stringify(snapshot())).toBe(before);
    });

    test('no confirmation is ever attributed to an agent, refused or not', () => {
        failureOf(() => quickStart(deps(), agent, P, request()));
        expect(ofKind('decision')).toHaveLength(0);
        quickStart(deps(), human, P, request());
        expect(ofKind('decision').every(decision => decision.createdBy !== agent.id)).toBe(true);
        expect(snapshot().events.every(event => event.actorKind === 'human' && event.actorId === human.id)).toBe(true);
    });
});

describe('invalid requests are rejected before any write', () => {
    test('an unknown mode is a 400', () => {
        const failure = failureOf(() => quickStart(deps(), human, P, request({ mode: 'epicc' as QuickStartRequest['mode'] })));
        expect(failure.status).toBe(400);
        expectNothingWritten();
    });

    for (const description of ['', '   ', '\n\t ']) {
        test(`an empty description (${JSON.stringify(description)}) is a 400`, () => {
            const failure = failureOf(() => quickStart(deps(), human, P, request({ description })));
            expect(failure.status).toBe(400);
            expectNothingWritten();
        });
    }

    describe('the body is bounded to what flow.create accepts', () => {
        const body = (over: Record<string, unknown>) => ({ mode: 'bug', description: 'Export does nothing', answers: [], criteria: [], ...over });
        const rejected = (over: Record<string, unknown>) => failureOf(() => parseQuickStartBody(body(over)));

        test('a normal body parses', () => {
            expect(parseQuickStartBody(body({})).mode).toBe('bug');
        });

        test('a description that cannot fit the 10000-character problem is a 400', () => {
            expect(rejected({ description: 'x'.repeat(10001) }).status).toBe(400);
        });

        test('answers that push the composed problem past 10000 characters are a 400', () => {
            const answers = [{ q: 'steps-to-reproduce', a: 'y'.repeat(9990), skipped: false }];
            expect(rejected({ answers }).status).toBe(400);
            expect(() => parseQuickStartBody(body({ answers: [{ q: 'steps-to-reproduce', a: 'y'.repeat(9000), skipped: false }] }))).not.toThrow();
        });

        test('more than 200 answers is a 400', () => {
            const answers = Array.from({ length: 201 }, () => ({ q: 'q', a: null, skipped: true }));
            expect(rejected({ answers }).status).toBe(400);
        });

        test('a criterion over 4000 characters is a 400', () => {
            expect(rejected({ criteria: ['z'.repeat(4001)] }).status).toBe(400);
            expect(() => parseQuickStartBody(body({ criteria: ['z'.repeat(4000)] }))).not.toThrow();
        });

        test('typed criteria plus the mode template may not exceed 200', () => {
            const room = 200 - getMode('bug').criteriaTemplate.length;
            expect(() => parseQuickStartBody(body({ criteria: Array.from({ length: room }, (_, i) => 'c' + i) }))).not.toThrow();
            expect(rejected({ criteria: Array.from({ length: room + 1 }, (_, i) => 'c' + i) }).status).toBe(400);
        });

        test('blank criteria do not count against the cap', () => {
            const room = 200 - getMode('bug').criteriaTemplate.length;
            expect(() => parseQuickStartBody(body({ criteria: [...Array.from({ length: room }, (_, i) => 'c' + i), '', '   '] }))).not.toThrow();
        });
    });

    test('a rejected request stores no receipt, so its operation id stays usable', () => {
        const body = request({ description: '' });
        failureOf(() => quickStart(deps(), human, P, body));
        quickStart(deps(), human, P, { ...body, description: 'Now with a description' });
        expect(ofKind('flow')).toHaveLength(1);
    });
});
