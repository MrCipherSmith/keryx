import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrateRemote } from '../remote-v2/storage';
import { migrateWork, workRepository } from './storage';
import type { WorkRecord, WorkState, WorkEvent } from './model';

function fixture() {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE hub_state(id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    migrateRemote(db); migrateWork(db);
    return { db, repo: workRepository(db) };
}
const flow = { id: 'f', projectId: 'p', kind: 'flow', state: 'in-progress', currentRevisionId: 'fr', approvedRevisionId: 'fr' } as WorkRecord;
const attempt = (id: string) => ({ id, projectId: 'p', kind: 'attempt', intentId: 'i', flowId: 'f', flowRevisionId: 'fr', intentRevisionId: 'ir', contextSnapshotId: 'ctx', state: 'running', version: 1 }) as WorkRecord;
const event = (sequence: number) => ({ projectId: 'p', sequence }) as WorkEvent;
test('one Attempt progress reads and writes bounded rows despite thousands of older Attempts in its Flow', () => {
    const { db, repo } = fixture();
    repo.save('p', { records: [flow, ...Array.from({ length: 2500 }, (_, i) => attempt('old-' + i)), attempt('active')], events: Array.from({ length: 2500 }, (_, i) => event(i + 1)), operations: {} });
    db.exec('CREATE TABLE touched(id TEXT); CREATE TRIGGER audit_work_update AFTER UPDATE ON hub_work_records BEGIN INSERT INTO touched VALUES(new.id); END;');
    const state = repo.commandState('p', { command: 'attempt.report', operationId: 'progress', expectedVersions: { active: 1 }, payload: { attemptId: 'active', state: 'running' } }, 'actor');
    expect(state.records.map(r => r.id)).toEqual(['f', 'active']);
    expect(state.events).toEqual([]);
    expect(state.sequence).toBe(2500);
    const active = state.records.find(r => r.id === 'active')!;
    Object.assign(active, { version: 2 });
    repo.save('p', state);
    expect(db.query('SELECT id FROM touched').all()).toEqual([{ id: 'active' }]);
    expect(repo.record('p', 'old-1')).toEqual(attempt('old-1'));
    db.close();
});
test('event retention preserves monotonic cursors and requires resync for a pruned cursor', () => {
    const { db, repo } = fixture();
    repo.save('p', { records: [], events: Array.from({ length: 10005 }, (_, i) => event(i + 1)), operations: {} });
    expect(repo.currentSequence('p')).toBe(10005);
    expect(() => repo.eventsAfter('p', 0, 50)).toThrow('Event history gap');
    expect(repo.eventsAfter('p', 10000, 2).map(e => e.sequence)).toEqual([10001, 10002]);
    const restarted = workRepository(db);
    const state = restarted.commandState('p', { command: 'flow.create', payload: {}, operationId: 'new', expectedVersions: {} }, 'actor');
    expect(state.sequence).toBe(10005);
    expect(state.events).toEqual([]);
    expect(db.query('SELECT count(*) AS n FROM hub_work_outbox').get()).toEqual({ n: 0 });
    db.close();
});
test('delta save never rewrites untouched records and retains durable idempotency receipts', () => {
    const { db, repo } = fixture();
    const receipt = { projectId: 'p', actorId: 'actor', operationId: 'op', eventCursor: 0 } as WorkState['operations'][string];
    repo.save('p', { records: [flow], events: [], operations: { 'p:actor:op': receipt } });
    const state = repo.commandState('p', { command: 'flow.start', payload: { flowId: 'f' }, operationId: 'op', expectedVersions: {} }, 'actor');
    expect(state.operations['p:actor:op']).toEqual(receipt);
    expect(repo.operation('p', 'other', 'op')).toBeUndefined();
    db.exec('CREATE TABLE touched(id TEXT); CREATE TRIGGER audit_work_update AFTER UPDATE ON hub_work_records BEGIN INSERT INTO touched VALUES(new.id); END;');
    repo.save('p', state);
    expect(db.query('SELECT * FROM touched').all()).toEqual([]);
    db.close();
});
test('durable history quota refuses atomically instead of deleting Evidence, Decisions or operation receipts', () => {
    const { db, repo } = fixture();
    repo.save('p', { records: [flow], events: [], operations: {} });
    db.query('UPDATE hub_work_usage SET records=? WHERE project_id=?').run(100000,'p');
    expect(() => repo.save('p', { records: [attempt('over-quota')], events: [event(1)], operations: {} })).toThrow('durable history quota');
    expect(repo.record('p','f')).toEqual(flow);
    expect(repo.record('p','over-quota')).toBeUndefined();
    expect(repo.currentSequence('p')).toBe(0);
    db.close();
});
