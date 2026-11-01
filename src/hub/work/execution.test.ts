import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fixture, admittedSession, appliedController, success, type Fixture } from '../remote-v2/fixture.test-support';
import type { Control } from '../../remote-control/protocol';
import type { WorkRecord, Attempt } from './model';
import { sha256 } from '../domain';
import { workExecutionHint } from './execution';
let f: Fixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
async function managedAttempt(f: Fixture) {
    const path = `/hub/work/v1/projects/${f.project.id}`;
    const command = async (name: string, payload: unknown) => {
        const snapshot = await success<{
            records: WorkRecord[];
        }>(await f.call(path + '/snapshot', { cookie: f.cookie }));
        const operationId = randomUUID();
        const response = await f.call(path + '/commands', { method: 'POST', cookie: f.cookie, key: operationId, body: { operationId, command: name, expectedVersions: Object.fromEntries(snapshot.records.filter(r => 'version' in r).map(r => [r.id, 'version' in r ? r.version : 1])), payload } });
        return success<{
            entities: WorkRecord[];
        }>(response);
    };
    const field = (records: WorkRecord[], kind: WorkRecord['kind']) => {
        const r = records.find(r => r.kind === kind);
        if (!r)
            throw new Error('Missing ' + kind);
        return r;
    };
    const flowFields = { problem: 'Problem', expectedOutcome: 'Outcome', scope: 'Scope', outOfScope: 'None', specification: null, criteria: [{ criterionId: 'fc', text: 'Works', waivable: false }] };
    const created = await command('flow.create', { ...flowFields, title: 'Runtime work', ownerId: null }), flow = field(created.entities, 'flow');
    const intentFields = { deliverable: 'Implement', approach: 'Native agent', outOfScope: 'None', criteria: [{ criterionId: 'ic', text: 'Passes', waivable: false }], flowCriterionIds: ['fc'], criterionMappings: [{ intentCriterionId: 'ic', flowCriterionId: 'fc' }] };
    const intent = field((await command('intent.create', { ...intentFields, flowId: flow.id, title: 'Deliverable', ownerId: null, required: true })).entities, 'intent');
    const fr = field((await command('revision.propose', { ...flowFields, targetType: 'flow', flowId: flow.id, requiredIntentIds: [intent.id] })).entities, 'flow-revision');
    const ir = field((await command('revision.propose', { ...intentFields, targetType: 'intent', intentId: intent.id, flowRevisionId: fr.id })).entities, 'intent-revision');
    if (fr.kind !== 'flow-revision' || ir.kind !== 'intent-revision')
        throw new Error('Invalid revisions');
    await command('requirements.approve', { targetType: 'flow-revision', revisionId: fr.id, revisionDigest: fr.contentDigest, flowRevisionId: fr.id, reason: 'Reviewed' });
    await command('requirements.approve', { targetType: 'intent-revision', revisionId: ir.id, revisionDigest: ir.contentDigest, flowRevisionId: fr.id, reason: 'Reviewed' });
    await command('flow.start', { flowId: flow.id, flowRevisionDigest: fr.contentDigest });
    const ctx = field((await command('context.create', { flowRevisionId: fr.id, intentRevisionId: ir.id, entries: [], gitBases: [] })).entities, 'context');
    if (ctx.kind !== 'context')
        throw new Error('Invalid context');
    const a = field((await command('attempt.create', { intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: 'operator', method: 'native-agent', summary: 'Runtime test', supersedesAttemptId: null })).entities, 'attempt');
    await command('attempt.start', { attemptId: a.id, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: ir.contentDigest, contextDigest: ctx.contentDigest });
    const read = async () => {
        const result = await success<{
            records: WorkRecord[];
        }>(await f.call(path + '/attempts/' + a.id, { cookie: f.cookie }));
        return result;
    };
    const current = (await read()).records.find((r): r is Attempt => r.kind === 'attempt' && r.id === a.id)!;
    return { path, command, flow, intent, fr, ir, ctx, a: current, read };
}
function headers(f: Fixture, attempt: Attempt, key: string) { return { 'Content-Type': 'application/json', Cookie: f.cookie, Origin: f.origin, 'Idempotency-Key': key, 'X-Keryx-Work-Attempt': attempt.id, 'X-Keryx-Work-Version': String(attempt.version) }; }
test('managed original v2 admission binds once, preserves wire protocol, and blocks active execution submission/cancellation', async () => {
    f = await fixture({ workManagement: { enabled: true } });
    const s = await admittedSession(f), c = await appliedController(f, s), managed = await managedAttempt(f), key = randomUUID();
    const body = { expectedSessionVersion: c.sessionVersion, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, expectedConfigVersion: 1, text: 'Execute pinned work', interpretation: 'literal-message', busyPolicy: 'reject', association: { mode: 'ad-hoc', profileConsentVersion: 1 } };
    const send = () => fetch(f!.origin + s.path + '/messages', { method: 'POST', headers: headers(f!, managed.a, key), body: JSON.stringify(body) });
    const receipt = await success<Control['TurnReceipt']>(await send());
    expect(receipt.status).toBe('admitted');
    const frame = await s.peer.next('command');
    const command = frame.payload as {
        commandId: string;
        hubSequence: number;
        body: {
            request: {
                association: unknown;
            };
        };
    };
    expect(command.body.request.association).toEqual(body.association);
    expect(await success<Control['TurnReceipt']>(await send())).toEqual(receipt);
    const aggregate = await managed.read();
    const link = aggregate.records.find(r => r.kind === 'execution-link');
    expect(link?.kind === 'execution-link' && link.contextObservation).toBe('unverified');
    expect(aggregate.records.find(r => r.id === managed.a.id)).toMatchObject({ executionOutcome: 'active' });
    const subject = (await managed.command('subject.create', { attemptId: managed.a.id, artifacts: [{ kind: 'report', text: 'Result', contentDigest: sha256('Result') }], report: 'Result' })).entities.find(r => r.kind === 'subject')!;
    if (subject.kind !== 'subject')
        throw new Error('Missing subject');
    const op = randomUUID(), snapshot = await success<{
        records: WorkRecord[];
    }>(await f.call(managed.path + '/snapshot', { cookie: f.cookie }));
    const versions = Object.fromEntries(snapshot.records.filter(r => 'version' in r).map(r => [r.id, 'version' in r ? r.version : 1]));
    const submit = { operationId: op, command: 'attempt.submit', expectedVersions: versions, payload: { attemptId: managed.a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, evidenceIds: [], coverage: [{ criterionId: 'ic', result: 'missing', evidenceIds: [] }], knowledgeFollowup: { proposalIds: [], noUpdateReason: 'None' } } };
    expect((await f.call(managed.path + '/commands', { method: 'POST', cookie: f.cookie, key: op, body: submit })).status).toBe(409);
    const cancelId = randomUUID();
    expect((await f.call(managed.path + '/commands', { method: 'POST', cookie: f.cookie, key: cancelId, body: { operationId: cancelId, command: 'work.cancel', expectedVersions: versions, payload: { targetType: 'intent', targetId: managed.intent.id, reason: 'Work cancel' } } })).status).toBe(409);
    // Exact human execution control is still required and remains available through v2.
    expect((await f.call(`/hub/v2/projects/${f.project.id}/runs/${receipt.runId}/cancel`, { method: 'POST', cookie: f.cookie, body: { expectedRunVersion: 1, expectedSessionVersion: c.sessionVersion, controller: body.controller, reason: 'Operator cancellation' } })).status).toBe(200);
    const run = await success<{
        cancelRequested: boolean;
    }>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${receipt.runId}`, { cookie: f.cookie }));
    expect(run.cancelRequested).toBe(true);
    s.peer.send('session-event', { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: 'checkout', sessionEventSeq: 4, observedAt: new Date().toISOString(), kind: 'session-state', session: { ...s.session, version: 3, controller: c.lease, state: 'busy', activeRunId: receipt.runId, activeTurnId: receipt.turnId, sessionEventCursor: 4 } });
    await s.peer.next('session-event-ack');
    s.peer.send('command-receipt', { commandId: command.commandId, hubSequence: command.hubSequence, runId: receipt.runId, sessionId: s.session.sessionId, observedRunVersion: 1, status: 'admitted', errorCode: 'none' });
    s.peer.send('heartbeat', { daemonId: 'daemon-1' });
    await s.peer.next('heartbeat-ack');
    for (const [index, state] of ['received', 'starting', 'running', 'cancelling', 'cancelled'].entries()) {
        s.peer.send('run-event', { runId: receipt.runId, turnId: receipt.turnId, sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: 'checkout', localSeq: index + 1, observedAt: new Date().toISOString(), kind: 'state', state, reasonCode: 'none', ...(index >= 2 ? { nativeIdentity: { sessionId: s.session.sessionId, turnId: receipt.turnId, daemonId: 'daemon-1', supervisorHandleId: 'managed-owner' } } : {}) });
        await s.peer.next('run-event-ack');
    }
    const sealed = await managed.command('attempt.submit', submit.payload);
    expect(sealed.entities.some(r => r.kind === 'submission')).toBe(true);
    expect((await managed.read()).records.find(r => r.id === managed.a.id)).toMatchObject({ executionOutcome: 'known-terminal', state: 'submitted' });
});
test('work admission headers require both fields and positive bounded versions', () => {
    expect(() => workExecutionHint(new Request('http://hub', { headers: { 'X-Keryx-Work-Attempt': 'a' } }))).toThrow();
    expect(() => workExecutionHint(new Request('http://hub', { headers: { 'X-Keryx-Work-Attempt': 'a', 'X-Keryx-Work-Version': '0' } }))).toThrow();
    expect(workExecutionHint(new Request('http://hub', { headers: { 'X-Keryx-Work-Attempt': 'a', 'X-Keryx-Work-Version': '2' } }))).toEqual({ attemptId: 'a', expectedVersion: 2 });
});
test('queued managed request retains reservation until original native queue admission and never invents a run', async () => {
    f = await fixture({ workManagement: { enabled: true } });
    const s = await admittedSession(f), c = await appliedController(f, s), managed = await managedAttempt(f);
    const controller = { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version };
    const body: Control['MessageSubmit'] = { expectedSessionVersion: 2, expectedConfigVersion: 1, controller, text: 'First unrelated work', interpretation: 'literal-message', busyPolicy: 'reject', association: { mode: 'ad-hoc', profileConsentVersion: 1 } };
    const first = await success<Control['TurnReceipt']>(await f.call(s.path + '/messages', { method: 'POST', cookie: f.cookie, body }));
    await s.peer.next('command');
    const emit = async (seq: number, event: object) => { s.peer.send('session-event', { sessionId: s.session.sessionId, projectId: f!.project.id, checkoutId: 'checkout', sessionEventSeq: seq, observedAt: new Date().toISOString(), ...event }); await s.peer.next('session-event-ack'); };
    await emit(4, { kind: 'session-state', session: { ...s.session, version: 3, state: 'busy', activeRunId: first.runId, activeTurnId: first.turnId, nextTurnOrdinal: 2, sessionEventCursor: 4 } });
    const queuedBody = { ...body, expectedSessionVersion: 3, text: 'Queued managed work', busyPolicy: 'enqueue' }, key = randomUUID();
    const queued = await success<Control['TurnReceipt']>(await fetch(f.origin + s.path + '/messages', { method: 'POST', headers: headers(f, managed.a, key), body: JSON.stringify(queuedBody) }));
    expect(queued.runId).toBeNull();
    await s.peer.next('session-command');
    expect((await managed.read()).records.filter(r => r.kind === 'execution-link')).toHaveLength(0);
    await managed.command('attempt.report', { attemptId: managed.a.id, event: 'progress', report: 'Waiting for original queued request' });
    expect((await managed.read()).records.find(r => r.id === managed.a.id)).toMatchObject({ executionOutcome: 'unknown' });
    const item: Control['QueueItem'] = { queueItemId: 'managed-native-q', version: 1, kind: 'message', operationId: queued.operationId, state: 'queued', position: 0, text: 'Queued managed work', commandName: null, expectedConfigVersion: 1, replacesOperationId: null };
    await emit(5, { kind: 'queue-changed', queueVersion: 1, item });
    await emit(6, { kind: 'session-state', session: { ...s.session, version: 4, state: 'busy', activeRunId: first.runId, activeTurnId: first.turnId, nextTurnOrdinal: 2, queueVersion: 1, sessionEventCursor: 6 } });
    await emit(7, { kind: 'session-state', session: { ...s.session, version: 5, state: 'idle', activeRunId: null, activeTurnId: null, nextTurnOrdinal: 2, queueVersion: 1, sessionEventCursor: 7 } });
    const delivery = await s.peer.next('command'), allocated = delivery.payload as {
        runId: string;
        turnId: string;
    };
    expect(allocated.runId).not.toBe(first.runId);
    const linked = (await managed.read()).records.filter(r => r.kind === 'execution-link');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ runId: allocated.runId, contextObservation: 'unverified' });
});
test('revoked machine allocation becomes unknown and does not release work or duplicate original run', async () => {
    f = await fixture({ workManagement: { enabled: true } });
    const s = await admittedSession(f), c = await appliedController(f, s), managed = await managedAttempt(f), key = randomUUID();
    const body = { expectedSessionVersion: c.sessionVersion, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, expectedConfigVersion: 1, text: 'Work', interpretation: 'literal-message', busyPolicy: 'reject', association: { mode: 'ad-hoc', profileConsentVersion: 1 } };
    const send = () => fetch(f!.origin + s.path + '/messages', { method: 'POST', headers: headers(f!, managed.a, key), body: JSON.stringify(body) });
    const allocated = await success<Control['TurnReceipt']>(await send());
    await s.peer.next('command');
    await success(await f.call('/hub/v2/machines/' + s.machine.machineId + '/revoke', { method: 'POST', cookie: f.cookie, body: { expectedVersion: 1 } }));
    await managed.command('attempt.report', { attemptId: managed.a.id, event: 'blocked', report: 'Machine authority revoked; allocation uncertain' });
    expect((await managed.read()).records.find(r => r.id === managed.a.id)).toMatchObject({ executionOutcome: 'unknown', state: 'blocked' });
    expect(await success<Control['TurnReceipt']>(await send())).toEqual(allocated);
    expect((await managed.read()).records.filter(r => r.kind === 'execution-link')).toHaveLength(1);
});
test('fresh managed dispatch checks current bound run outcome and refuses unknown allocation on another healthy session', async () => {
    f = await fixture({ workManagement: { enabled: true } });
    const original = await admittedSession(f), controller = await appliedController(f, original), managed = await managedAttempt(f);
    const request = { expectedSessionVersion: controller.sessionVersion, controller: { controllerLeaseId: controller.lease.controllerLeaseId, expectedControllerVersion: controller.lease.version }, expectedConfigVersion: 1, text: 'Original work', interpretation: 'literal-message', busyPolicy: 'reject', association: { mode: 'ad-hoc', profileConsentVersion: 1 } };
    await success<Control['TurnReceipt']>(await fetch(f.origin + original.path + '/messages', { method: 'POST', headers: headers(f, managed.a, randomUUID()), body: JSON.stringify(request) }));
    await original.peer.next('command');
    // Revocation changes authoritative execution availability without refreshing the cached Attempt outcome.
    await success(await f.call('/hub/v2/machines/' + original.machine.machineId + '/revoke', { method: 'POST', cookie: f.cookie, body: { expectedVersion: 1 } }));
    const before = (await managed.read()).records.find((r): r is Attempt => r.kind === 'attempt' && r.id === managed.a.id)!;
    expect(before.executionOutcome).toBe('active');
    const healthy = await admittedSession(f), nextController = await appliedController(f, healthy);
    const response = await fetch(f.origin + healthy.path + '/messages', { method: 'POST', headers: headers(f, before, randomUUID()), body: JSON.stringify({ ...request, expectedSessionVersion: nextController.sessionVersion, controller: { controllerLeaseId: nextController.lease.controllerLeaseId, expectedControllerVersion: nextController.lease.version } }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'execution-allocation-uncertain' } });
    expect((await managed.read()).records.filter(r => r.kind === 'execution-link')).toHaveLength(1);
    expect(healthy.peer.pendingFrames().some(frame => frame.type === 'command')).toBe(false);
});
test('delayed queue admission refuses another linked run that became unknown and preserves native queue', async () => {
    f = await fixture({ workManagement: { enabled: true } });
    const original = await admittedSession(f), oc = await appliedController(f, original), managed = await managedAttempt(f);
    const base = { expectedSessionVersion: oc.sessionVersion, controller: { controllerLeaseId: oc.lease.controllerLeaseId, expectedControllerVersion: oc.lease.version }, expectedConfigVersion: 1, text: 'Original work', interpretation: 'literal-message', busyPolicy: 'reject', association: { mode: 'ad-hoc', profileConsentVersion: 1 } };
    await success(await fetch(f.origin + original.path + '/messages', { method: 'POST', headers: headers(f, managed.a, randomUUID()), body: JSON.stringify(base) }));
    await original.peer.next('command');
    const s = await admittedSession(f), c = await appliedController(f, s), body = { ...base, expectedSessionVersion: c.sessionVersion, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version } };
    const unrelated = await success<Control['TurnReceipt']>(await f.call(s.path + '/messages', { method: 'POST', cookie: f.cookie, body }));
    await s.peer.next('command');
    const emit = async (seq: number, event: object) => { s.peer.send('session-event', { sessionId: s.session.sessionId, projectId: f!.project.id, checkoutId: 'checkout', sessionEventSeq: seq, observedAt: new Date().toISOString(), ...event }); await s.peer.next('session-event-ack'); };
    await emit(4, { kind: 'session-state', session: { ...s.session, version: 3, state: 'busy', activeRunId: unrelated.runId, activeTurnId: unrelated.turnId, nextTurnOrdinal: 2, sessionEventCursor: 4 } });
    const current = (await managed.read()).records.find((r): r is Attempt => r.kind === 'attempt' && r.id === managed.a.id)!;
    const queued = await success<Control['TurnReceipt']>(await fetch(f.origin + s.path + '/messages', { method: 'POST', headers: headers(f, current, randomUUID()), body: JSON.stringify({ ...body, expectedSessionVersion: 3, busyPolicy: 'enqueue', text: 'Queued managed' }) }));
    await s.peer.next('session-command');
    await success(await f.call('/hub/v2/machines/' + original.machine.machineId + '/revoke', { method: 'POST', cookie: f.cookie, body: { expectedVersion: 1 } }));
    const item: Control['QueueItem'] = { queueItemId: 'review-q', version: 1, kind: 'message', operationId: queued.operationId, state: 'queued', position: 0, text: 'Queued managed', commandName: null, expectedConfigVersion: 1, replacesOperationId: null };
    await emit(5, { kind: 'queue-changed', queueVersion: 1, item });
    await emit(6, { kind: 'session-state', session: { ...s.session, version: 4, state: 'busy', activeRunId: unrelated.runId, activeTurnId: unrelated.turnId, nextTurnOrdinal: 2, queueVersion: 1, sessionEventCursor: 6 } });
    await emit(7, { kind: 'session-state', session: { ...s.session, version: 5, state: 'idle', activeRunId: null, activeTurnId: null, nextTurnOrdinal: 2, queueVersion: 1, sessionEventCursor: 7 } });
    s.peer.send('heartbeat', { daemonId: 'daemon-1' });
    await s.peer.next('heartbeat-ack');
    expect(s.peer.pendingFrames().some(frame => frame.type === 'command')).toBe(false);
    const observed = await success<Control['QueuePage']>(await f.call(s.path + '/queue', { cookie: f.cookie }));
    expect(observed.items.find(q => q.queueItemId === item.queueItemId)).toMatchObject({ state: 'queued', operationId: queued.operationId });
    const retained = await success<Control['TurnReceipt']>(await f.call(s.path + '/operations/' + queued.operationId, { cookie: f.cookie }));
    expect(retained.status).toBe('queued');
    expect(retained.runId).toBeNull();
    expect((await managed.read()).records.filter(r => r.kind === 'execution-link')).toHaveLength(1);
});
