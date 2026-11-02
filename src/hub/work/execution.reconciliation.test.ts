import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHubStore } from '../store';
import { createWorkExecution, type WorkExecutionReservation } from './execution';

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'work-reconciliation-'));
    const store = openHubStore(dir);
    const close = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
    return { store, close };
}
const reservation: WorkExecutionReservation = { operationId: 'owned-operation', projectId: 'p', actorId: 'h', sessionDigest: 'session-digest', sessionId: 's', machineId: 'm', checkoutId: 'checkout', attemptId: 'a', flowId: 'f', intentId: 'i', flowRevisionId: 'fr', intentRevisionId: 'ir', contextSnapshotId: 'ctx', flowRevisionDigest: 'f'.repeat(64), intentRevisionDigest: 'a'.repeat(64), contextDigest: 'c'.repeat(64), associationDigest: 'd'.repeat(64), wireAssociationDigest: 'e'.repeat(64), createdAt: '2026-11-01T00:00:00Z', state: 'reserved', runId: null, turnId: null };

test('reconcileSession with no pending managed reservations performs zero remote history reads', () => {
    const f = fixture();
    const all = spyOn(f.store.remote, 'all'); const get = spyOn(f.store.remote, 'get');
    try {
        createWorkExecution(f.store).reconcileSession('ordinary-session');
        expect(all).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
    } finally { all.mockRestore(); get.mockRestore(); f.close(); }
});

test('reconcileSession parses only the pending operation lineage and never cold session history', () => {
    const f = fixture();
    try {
        f.store.remote.put('remote_session', 's', { record: { state: 'idle' } });
        f.store.work.saveExecutionReservation(reservation);
        f.store.remote.put('remote_queue', 'owned-queue', { item: { operationId: reservation.operationId, queueItemId: 'owned-queue', state: 'removed', version: 2, replacesOperationId: null }, sessionId: 's', projectId: 'p', machineId: 'm' }, { sessionId: 's' });
        for (let n = 0; n < 2000; n++) {
            const id = `cold-${n}`, marker = 'cold-reconciliation-history';
            f.store.remote.put('remote_queue', id, { marker, item: { operationId: id, queueItemId: id, state: 'removed', version: 1, replacesOperationId: null } }, { sessionId: 's' });
            f.store.remote.put('remote_command', id, { marker, operationId: id, status: 'applied' }, { sessionId: 's' });
            f.store.remote.put('remote_operation', id, { id, marker, request: { unrelated: true } }, { sessionId: 's' });
        }
        const parse = JSON.parse; let coldReads = 0;
        const parsed = spyOn(JSON, 'parse').mockImplementation((text, reviver) => { if (text.includes('cold-reconciliation-history')) coldReads++; return parse(text, reviver); });
        try { createWorkExecution(f.store).reconcileSession('s'); } finally { parsed.mockRestore(); }
        expect(coldReads).toBe(0);
        expect(f.store.work.executionReservation(reservation.operationId)?.state).toBe('released');
    } finally { f.close(); }
});

test('managed reconciliation follows multiple replacement hops only within the requested session', () => {
    const f = fixture();
    try {
        f.store.remote.put('remote_session', 's', { record: { state: 'idle' } });
        f.store.remote.put('remote_session', 'other', { record: { state: 'idle' } });
        const put = (id: string, operationId: string, replacesOperationId: string | null, sessionId: string) => f.store.remote.put('remote_queue', id, { item: { queueItemId: id, operationId, replacesOperationId, state: 'queued', version: 1 }, sessionId }, { sessionId });
        put('root-q', 'root', null, 's');
        put('first-q', 'first', 'root', 's');
        put('second-q', 'second', 'first', 's');
        put('foreign-q', 'foreign', 'root', 'other');
        put('foreign-child-q', 'foreign-child', 'foreign', 's');
        const result = f.store.remote.managedReconciliation('s', ['root']);
        expect(result.queue.map(row => row.item.operationId).sort()).toEqual(['first', 'root', 'second']);
    } finally { f.close(); }
});

function editFixture() {
    const f = fixture();
    f.store.remote.put('remote_session', 's', { record: { state: 'idle' } });
    f.store.work.saveExecutionReservation(reservation);
    const source = { sessionId: 's', projectId: 'p', machineId: 'm', item: { queueItemId: 'q', operationId: reservation.operationId, replacesOperationId: null, state: 'queued', version: 1 } };
    const request = { expectedSessionVersion: 4, controller: { controllerLeaseId: 'lease', expectedControllerVersion: 1 }, expectedQueueVersion: 1, expectedItemVersion: 1, text: 'edited', queueItemId: 'q' };
    f.store.remote.put('remote_operation', 'edit', { id: 'edit', request, actorId: 'h', sessionDigest: 'session-digest' }, { sessionId: 's' });
    const event = { kind: 'queue-changed', sessionId: 's', projectId: 'p', item: { ...source.item, queueItemId: 'new-q', operationId: 'edit', replacesOperationId: reservation.operationId, text: 'edited' } };
    const observe = (ev = event, prev = source) => createWorkExecution(f.store).queueObserved(ev as Parameters<ReturnType<typeof createWorkExecution>['queueObserved']>[0], prev as Parameters<ReturnType<typeof createWorkExecution>['queueObserved']>[1]);
    return { ...f, source, event, observe };
}

test('a successful managed replacement releases its original and reserves the replacement', () => {
    const f = editFixture();
    try {
        f.observe();
        expect(f.store.work.executionReservation(reservation.operationId)?.state).toBe('released');
        expect(f.store.work.executionReservation('edit')?.state).toBe('reserved');
    } finally { f.close(); }
});

for (const mismatch of ['session', 'project', 'machine', 'lineage', 'text'] as const) test(`managed edit refuses mismatched ${mismatch} without changing reservations`, () => {
    const f = editFixture();
    try {
        const event = { ...f.event, item: { ...f.event.item } }, source = { ...f.source };
        if (mismatch === 'session') event.sessionId = 'other';
        if (mismatch === 'project') event.projectId = 'other';
        if (mismatch === 'machine') source.machineId = 'other';
        if (mismatch === 'lineage') event.item.replacesOperationId = 'other';
        if (mismatch === 'text') event.item.text = 'other';
        expect(() => f.observe(event, source)).toThrow('Edited managed queue requires exact original reservation');
        expect(f.store.work.executionReservation(reservation.operationId)).toEqual(reservation);
        expect(f.store.work.executionReservation('edit')).toBeUndefined();
    } finally { f.close(); }
});
