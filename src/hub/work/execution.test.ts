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
    const a = field((await command('attempt.create', { intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: 'human:operator', method: 'native-agent', summary: 'Runtime test', supersedesAttemptId: null })).entities, 'attempt');
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
    const cancellation = await f.call(managed.path + '/commands', { method: 'POST', cookie: f.cookie, key: cancelId, body: { operationId: cancelId, command: 'work.cancel', expectedVersions: versions, payload: { targetType: 'intent', targetId: managed.intent.id, reason: 'Work cancel' } } });
    expect(cancellation.status).toBe(409);
    expect(await cancellation.json()).toMatchObject({error:{code:"execution-uncertain"}});
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

test('human confirmed lost reconciliation settles managed execution while unknown remains fenced', async () => {
    f = await fixture({ workManagement: { enabled: true } });
    const s = await admittedSession(f), c = await appliedController(f, s), managed = await managedAttempt(f);
    const body = { expectedSessionVersion: c.sessionVersion, controller: { controllerLeaseId: c.lease.controllerLeaseId, expectedControllerVersion: c.lease.version }, expectedConfigVersion: 1, text: 'Work', interpretation: 'literal-message', busyPolicy: 'reject', association: { mode: 'ad-hoc', profileConsentVersion: 1 } };
    const turn = await success<Control['TurnReceipt']>(await fetch(f.origin + s.path + '/messages', { method: 'POST', headers: headers(f, managed.a, randomUUID()), body: JSON.stringify(body) }));
    const frame = await s.peer.next('command');
    const command = frame.payload as { commandDigest: string };
    s.peer.send('run-event', { runId: turn.runId, projectId: f.project.id, checkoutId: 'checkout', sessionId: s.session.sessionId, turnId: turn.turnId, localSeq: 1, observedAt: new Date().toISOString(), kind: 'state', state: 'unknown', reasonCode: 'recovery-required' });
    await s.peer.next('run-event-ack');
    await managed.command('attempt.report', { attemptId: managed.a.id, event: 'blocked', report: 'Unknown runtime' });
    expect((await managed.read()).records.find(r => r.id === managed.a.id)).toMatchObject({ executionOutcome: 'unknown' });
    const run = await success<{ version: number }>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`, { cookie: f.cookie }));
    const report: Control['ReconciliationReport'] = { runId: turn.runId!, projectId: f.project.id, checkoutId: 'checkout', ledgerId: 'ledger-1', daemonId: 'daemon-1', commandDigest: command.commandDigest, expectedRunVersion: run.version, observation: 'confirmed-stopped', observedAt: new Date().toISOString(), sessionId: s.session.sessionId, turnId: turn.turnId! };
    const receipt = await success<Control['ReconciliationReceipt']>(await f.call(`/hub/v2/machines/${s.machine.machineId}/reconciliations`, { method: 'POST', token: s.machine.secret, origin: null, body: report }));
    await success(await f.call(`/hub/v2/machines/${s.machine.machineId}/resolve-run`, { method: 'POST', cookie: f.cookie, body: { runId: turn.runId, expectedRunVersion: run.version, localReconciliationId: receipt.reconciliationId, decision: 'lost', reason: 'Confirmed stopped' } }));
    await managed.command('attempt.report', { attemptId: managed.a.id, event: 'failed', report: 'Resolved runtime stopped' });
    expect((await managed.read()).records.find(r => r.id === managed.a.id)).toMatchObject({ executionOutcome: 'known-terminal', state: 'failed' });
    await managed.command('attempt.create', { intentRevisionId: managed.ir.id, contextSnapshotId: managed.ctx.id, participantId: 'human:operator', method: 'native-agent', summary: 'Retry known stopped work', supersedesAttemptId: managed.a.id });
});

test('removed queued managed work releases its reservation without inventing a successful run', async () => {
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
    const item: Control['QueueItem'] = { queueItemId: 'managed-native-q', version: 1, kind: 'message', operationId: queued.operationId, state: 'queued', position: 0, text: 'Queued managed work', commandName: null, expectedConfigVersion: 1, replacesOperationId: null };
    await emit(5, { kind: 'queue-changed', queueVersion: 1, item });

    await emit(6, {kind:'queue-changed',queueVersion:2,item:{...item,version:2,state:'removed'}});
    await managed.command('attempt.report',{attemptId:managed.a.id,event:'progress',report:'Removed before execution'});
    expect((await managed.read()).records.find(record=>record.id===managed.a.id)).toMatchObject({executionOutcome:'none'});
    expect((await managed.read()).records.filter(record=>record.kind==='execution-link')).toHaveLength(0);
    const cancelled=await managed.command('work.cancel',{targetType:'intent',targetId:managed.intent.id,reason:'Removed queued work never admitted'});
    expect(cancelled.entities.find(record=>record.id===managed.intent.id)).toMatchObject({state:'cancelled'});
});

test('reauthorized queued managed work transfers the original pins and binds its replacement run', async () => {
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
    const item: Control['QueueItem'] = { queueItemId: 'managed-native-q', version: 1, kind: 'message', operationId: queued.operationId, state: 'queued', position: 0, text: 'Queued managed work', commandName: null, expectedConfigVersion: 1, replacesOperationId: null };
    await emit(5, { kind: 'queue-changed', queueVersion: 1, item });


    const suspended={...item,version:2,state:'suspended' as const};
    await emit(6,{kind:'queue-changed',queueVersion:2,item:suspended});
    await emit(7,{kind:'session-state',session:{...s.session,version:4,state:'idle',activeRunId:null,activeTurnId:null,nextTurnOrdinal:2,queueVersion:2,sessionEventCursor:7}});
    const replacement = await success<Control['SessionOperationReceipt']>(await f.call(`${s.path}/queue/${item.queueItemId}/reauthorize`,{method:'POST',cookie:f.cookie,body:{expectedSessionVersion:4,controller,expectedQueueVersion:2,expectedItemVersion:2,originalOperationId:queued.operationId,expectedConfigVersion:1,association:body.association,queueItemId:item.queueItemId}}));
    await s.peer.next('session-command');
    await emit(8,{kind:'queue-changed',queueVersion:3,item:{...suspended,state:'removed',version:3}});
    const next={...item,queueItemId:'managed-replacement',operationId:replacement.operationId,replacesOperationId:queued.operationId};
    await emit(9,{kind:'queue-changed',queueVersion:3,item:next});
    const record={...s.session,version:5,state:'idle',activeRunId:null,activeTurnId:null,nextTurnOrdinal:2,queueVersion:3,sessionEventCursor:11};
    await emit(10,{kind:'operation-receipt',receipt:{...replacement,status:'applied',observedSessionVersion:5,session:record}});
    await emit(11,{kind:'session-state',session:record});
    const delivery=await s.peer.next('command');
    const run=delivery.payload as {runId:string};
    const links=(await managed.read()).records.filter(record=>record.kind==='execution-link');
    expect(links).toHaveLength(1);expect(links[0]).toMatchObject({runId:run.runId,attemptId:managed.a.id});
});

test('definitively refused delayed admission releases work but does not pretend the native queue changed', async () => {
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
    const item: Control['QueueItem'] = { queueItemId: 'managed-native-q', version: 1, kind: 'message', operationId: queued.operationId, state: 'queued', position: 0, text: 'Queued managed work', commandName: null, expectedConfigVersion: 2, replacesOperationId: null };
    await emit(5, { kind: 'queue-changed', queueVersion: 1, item });


    await emit(6,{kind:'session-state',session:{...s.session,version:4,state:'idle',activeRunId:null,activeTurnId:null,nextTurnOrdinal:2,queueVersion:1,sessionEventCursor:6}});
    const queue=await success<Control['QueuePage']>(await f.call(s.path+'/queue',{cookie:f.cookie}));
    expect(queue.items[0]).toMatchObject({state:'queued',operationId:queued.operationId});
    await managed.command('attempt.report',{attemptId:managed.a.id,event:'progress',report:'Hub refused stale configuration before admission'});
    expect((await managed.read()).records.find(record=>record.id===managed.a.id)).toMatchObject({executionOutcome:'none'});
    expect((await managed.read()).records.filter(record=>record.kind==='execution-link')).toHaveLength(0);
    const healthy=await admittedSession(f), nextController=await appliedController(f,healthy);
    const current=(await managed.read()).records.find((record):record is Attempt=>record.kind==='attempt'&&record.id===managed.a.id)!;
    const dispatched=await success<Control['TurnReceipt']>(await fetch(f.origin+healthy.path+'/messages',{method:'POST',headers:headers(f,current,randomUUID()),body:JSON.stringify({...body,expectedSessionVersion:nextController.sessionVersion,controller:{controllerLeaseId:nextController.lease.controllerLeaseId,expectedControllerVersion:nextController.lease.version}})}));
    expect(dispatched.status).toBe('admitted');
});

test('editing queued managed work preserves the Attempt binding under its new native operation', async () => {
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
    const item: Control['QueueItem'] = { queueItemId: 'managed-native-q', version: 1, kind: 'message', operationId: queued.operationId, state: 'queued', position: 0, text: 'Queued managed work', commandName: null, expectedConfigVersion: 1, replacesOperationId: null };
    await emit(5, { kind: 'queue-changed', queueVersion: 1, item });


    await emit(6,{kind:'session-state',session:{...s.session,version:4,state:'busy',activeRunId:first.runId,activeTurnId:first.turnId,nextTurnOrdinal:2,queueVersion:1,sessionEventCursor:6}});
    const edited=await success<Control['SessionOperationReceipt']>(await f.call(`${s.path}/queue/${item.queueItemId}`,{method:'PATCH',cookie:f.cookie,body:{expectedSessionVersion:4,controller,expectedQueueVersion:1,expectedItemVersion:1,text:'Edited managed instructions',queueItemId:item.queueItemId}}));
    await s.peer.next('session-command');
    await emit(7,{kind:'queue-changed',queueVersion:2,item:{...item,version:2,state:'removed'}});
    const next={...item,queueItemId:'edited-managed-native-q',operationId:edited.operationId,replacesOperationId:queued.operationId,text:'Edited managed instructions'};
    s.peer.send('session-event',{sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',sessionEventSeq:8,observedAt:new Date().toISOString(),kind:'queue-changed',queueVersion:2,item:{...next,replacesOperationId:'foreign-operation'}});
    expect((await s.peer.next('error')).payload).toMatchObject({code:'stale-reference'});
    await emit(8,{kind:'queue-changed',queueVersion:2,item:next});
    const record={...s.session,version:5,state:'idle',activeRunId:null,activeTurnId:null,nextTurnOrdinal:2,queueVersion:2,sessionEventCursor:10};
    await emit(9,{kind:'operation-receipt',receipt:{...edited,status:'applied',observedSessionVersion:5,session:record}});
    await emit(10,{kind:'session-state',session:record});
    const delivery=await s.peer.next('command');const run=delivery.payload as {runId:string};
    const links=(await managed.read()).records.filter(record=>record.kind==='execution-link');
    expect(links).toHaveLength(1);expect(links[0]).toMatchObject({runId:run.runId,attemptId:managed.a.id});
});

test('managed queue quota failure rolls back native allocation and permits a later fresh dispatch', async () => {
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
    const item: Control['QueueItem'] = { queueItemId: 'managed-native-q', version: 1, kind: 'message', operationId: queued.operationId, state: 'queued', position: 0, text: 'Queued managed work', commandName: null, expectedConfigVersion: 1, replacesOperationId: null };
    await emit(5, { kind: 'queue-changed', queueVersion: 1, item });


    await emit(6,{kind:'session-state',session:{...s.session,version:4,state:'busy',activeRunId:first.runId,activeTurnId:first.turnId,nextTurnOrdinal:2,queueVersion:1,sessionEventCursor:6}});
    const {Database}=await import('bun:sqlite');const db=new Database(f.dataDir+'/hub.sqlite');
    try {
      const beforeRuns=db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM remote_run').get()!.n;
      const beforeCommands=db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM remote_command').get()!.n;
      const beforeMachine=db.query<{body:string},[string]>('SELECT body FROM remote_machine WHERE id=?').get(s.machine.machineId)!.body;
      db.query('UPDATE hub_work_usage SET records=100000 WHERE project_id=?').run(f.project.id);
      await emit(7,{kind:'session-state',session:{...s.session,version:5,state:'idle',activeRunId:null,activeTurnId:null,nextTurnOrdinal:2,queueVersion:1,sessionEventCursor:7}});
      await success<Control['QueuePage']>(await f.call(s.path+'/queue',{cookie:f.cookie}));
      expect(db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM remote_run').get()!.n).toBe(beforeRuns);
      expect(db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM remote_command').get()!.n).toBe(beforeCommands);
      const machine=JSON.parse(db.query<{body:string},[string]>('SELECT body FROM remote_machine WHERE id=?').get(s.machine.machineId)!.body);
      expect(machine.hubSequence).toBe(JSON.parse(beforeMachine).hubSequence);
      const session=JSON.parse(db.query<{body:string},[string]>('SELECT body FROM remote_session WHERE id=?').get(s.session.sessionId)!.body);
      expect(session.record).toMatchObject({state:'idle',activeRunId:null,nextTurnOrdinal:2});expect(session.pending).toBeUndefined();
      const reservation=JSON.parse(db.query<{body:string},[string]>('SELECT body FROM hub_work_execution_reservations WHERE operation_id=?').get(queued.operationId)!.body);
      expect(reservation).toMatchObject({state:'released',runId:null,turnId:null});
      expect((await managed.read()).records.filter(record=>record.kind==='execution-link')).toHaveLength(0);
      expect(s.peer.pendingFrames().filter(frame=>frame.type==='command')).toHaveLength(0);
      db.query('UPDATE hub_work_usage SET records=(SELECT COUNT(*) FROM hub_work_records WHERE project_id=?) WHERE project_id=?').run(f.project.id,f.project.id);
      await managed.command('attempt.report',{attemptId:managed.a.id,event:'progress',report:'Admission quota refused before execution'});
      const healthy=await admittedSession(f), controller2=await appliedController(f,healthy);
      const current=(await managed.read()).records.find((record):record is Attempt=>record.kind==='attempt'&&record.id===managed.a.id)!;
      const fresh=await success<Control['TurnReceipt']>(await fetch(f.origin+healthy.path+'/messages',{method:'POST',headers:headers(f,current,randomUUID()),body:JSON.stringify({...body,expectedSessionVersion:controller2.sessionVersion,controller:{controllerLeaseId:controller2.lease.controllerLeaseId,expectedControllerVersion:controller2.lease.version}})}));
      expect(fresh.status).toBe('admitted');
    } finally {db.close();}
});
