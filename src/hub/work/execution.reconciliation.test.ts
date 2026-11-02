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
