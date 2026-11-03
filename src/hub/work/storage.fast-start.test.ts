import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrateRemote } from '../remote-v2/storage';
import { workCommand } from './domain';
import type { FlowRevision, IntentRevision, WorkFlow, WorkIntent } from './model';
import { migrateWork, workRepository } from './storage';
import { context, flowPayload, human } from './storage.fixture.test-support';

test('fast start commits exact Flow and result approvals together in scoped storage', () => {
    using db = new Database(':memory:');
    db.exec('CREATE TABLE hub_state(id INTEGER PRIMARY KEY,body TEXT NOT NULL)');
    migrateRemote(db);
    migrateWork(db);
    const repository = workRepository(db);
    const agent = { id: 'agent', kind: 'agent', role: 'agent' } as const;
    const execute = (input: unknown, actor = human) => {
        const state = repository.commandState('p', input, actor.id);
        const receipt = workCommand(state, actor, 'p', input, {
            ...context,
            nextRevisionNumber: (kind, id) => repository.nextRevisionNumber('p', kind, id),
        });
        repository.save('p', state);
        return receipt;
    };
    const flow = execute({ operationId: 'draft', expectedVersions: {}, command: 'flow.create', payload: flowPayload }, agent).result as WorkFlow;
    const source = repository.load('p').records.find((r): r is FlowRevision => r.kind === 'flow-revision' && r.id === flow.currentRevisionId)!;
    const command = {
        operationId: 'review-plan', expectedVersions: { [flow.id]: flow.version }, command: 'flow.approve-and-start',
        payload: { flowId: flow.id, flowRevisionDigest: source.contentDigest, intents: [], reason: 'Reviewed' },
    };
    const before = repository.load('p');
    expect(() => execute(command, agent)).toThrow('Authorized human decision required');
    expect(() => execute({ ...command, payload: { ...command.payload, flowRevisionDigest: 'a'.repeat(64) } })).toThrow('Exact immutable digest mismatch');
    expect(repository.load('p')).toEqual(before);
    const started = execute(command);
    expect(started.result).toMatchObject({ id: flow.id, state: 'in-progress' });
    const after = repository.load('p').records;
    const approvedFlow = after.find((r): r is WorkFlow => r.kind === 'flow' && r.id === flow.id)!;
    const approvedPlan = after.find((r): r is FlowRevision => r.kind === 'flow-revision' && r.id === approvedFlow.approvedRevisionId)!;
    const result = after.find((r): r is WorkIntent => r.kind === 'intent' && r.flowId === flow.id)!;
    const resultPlan = after.find((r): r is IntentRevision => r.kind === 'intent-revision' && r.id === result.approvedRevisionId)!;
    expect(result).toMatchObject({ state: 'ready', required: true, title: flow.title });
    expect(approvedPlan.requiredIntentIds).toEqual([result.id]);
    expect(resultPlan.flowRevisionId).toBe(approvedPlan.id);
    expect(resultPlan.criteria).toEqual(source.criteria);
    expect(after.filter(r => r.kind === 'decision').map(r => r.targetId)).toEqual([approvedPlan.id, resultPlan.id]);
    expect(execute(command)).toEqual(started);
});

test('fast start rejects incomplete coverage and pins reviewed results after the parent version changes', () => {
    using db = new Database(':memory:');
    db.exec('CREATE TABLE hub_state(id INTEGER PRIMARY KEY,body TEXT NOT NULL)');
    migrateRemote(db);
    migrateWork(db);
    const repository = workRepository(db);
    let operation = 0;
    const execute = (command: string, payload: unknown) => {
        const expectedVersions = Object.fromEntries(repository.load('p').records.flatMap(record => 'version' in record ? [[record.id, record.version]] : []));
        const input = { operationId: 'op-' + ++operation, command, payload, expectedVersions };
        const state = repository.commandState('p', input, human.id);
        const receipt = workCommand(state, human, 'p', input, {
            ...context,
            nextRevisionNumber: (kind, id) => repository.nextRevisionNumber('p', kind, id),
        });
        repository.save('p', state);
        return receipt.result;
    };
    const criteria = [...flowPayload.criteria, { criterionId: 'fc2', text: 'Second result verified', waivable: false }];
    const flow = execute('flow.create', { ...flowPayload, criteria }) as WorkFlow;
    const source = repository.load('p').records.find((record): record is FlowRevision => record.kind === 'flow-revision' && record.id === flow.currentRevisionId)!;
    const addResult = (criterionId: string) => {
        const criteria = [{ criterionId: 'checks-' + criterionId, text: 'Verification for ' + criterionId, waivable: false }];
        const intent = execute('intent.create', {
            flowId: flow.id, title: criterionId, deliverable: 'Deliver ' + criterionId, approach: 'Manual',
            outOfScope: 'Other work', ownerId: null, required: true, criteria, flowCriterionIds: [criterionId],
            criterionMappings: [{ intentCriterionId: criteria[0]!.criterionId, flowCriterionId: criterionId }],
        }) as WorkIntent;
        const revision = repository.load('p').records.find((record): record is IntentRevision => record.kind === 'intent-revision' && record.id === intent.currentRevisionId)!;
        return { intentId: intent.id, revisionId: revision.id, revisionDigest: revision.contentDigest };
    };
    const first = addResult('fc');
    const start = { flowId: flow.id, flowRevisionDigest: source.contentDigest, reason: 'Reviewed' };
    const before = repository.load('p');
    expect(() => execute('flow.approve-and-start', { ...start, intents: [first] })).toThrow('Required results must cover every Flow criterion');
    expect(repository.load('p')).toEqual(before);
    const second = addResult('fc2');
    expect(() => execute('flow.approve-and-start', { ...start, intents: [first] })).toThrow('The required results changed');
    const started = execute('flow.approve-and-start', { ...start, intents: [first, second] }) as WorkFlow;
    expect(started.state).toBe('in-progress');
    const records = repository.load('p').records;
    for (const reviewed of [first, second]) {
        const intent = records.find((record): record is WorkIntent => record.kind === 'intent' && record.id === reviewed.intentId)!;
        const original = records.find((record): record is IntentRevision => record.kind === 'intent-revision' && record.id === reviewed.revisionId)!;
        const approved = records.find((record): record is IntentRevision => record.kind === 'intent-revision' && record.id === intent.approvedRevisionId)!;
        expect(approved.id).not.toBe(original.id);
        expect(approved.flowRevisionId).toBe(started.approvedRevisionId!);
        expect(approved.criteria).toEqual(original.criteria);
        expect(approved.criterionMappings).toEqual(original.criterionMappings);
    }
});
