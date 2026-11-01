import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHubStore, type HubStore } from '../store';
import type { WorkState } from './model';
const roots: string[] = [];
const stores: HubStore[] = [];
afterEach(() => {
    for (const s of stores.splice(0))
        s.close();
    for (const p of roots.splice(0))
        rmSync(p, { recursive: true, force: true });
});
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'hub-work-store-'));
    roots.push(dir);
    const store = openHubStore(dir);
    stores.push(store);
    return { dir, store };
}
function state(): WorkState {
    return { records: [{
                id: 'flow-one', projectId: 'p', kind: 'flow', title: 'One', createdBy: 'a', createdAt: '2026-01-01', updatedAt: '2026-01-01', state: 'draft', version: 1, currentRevisionId: 'r', ownerId: null, approvedRevisionId: null, acceptanceDecisionId: null, legacyFlowId: null
            }], events: [], operations: {} };
}
test('persists project-scoped work alongside legacy state across restart', () => {
    const { dir, store } = fixture();
    store.writeTransaction(legacy => {
        legacy.projects.push({
            id: 'p', name: 'P', version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0
        });
        store.work.save('p', state());
    });
    store.close();
    const reopened = openHubStore(dir);
    stores.push(reopened);
    expect(reopened.work.load('p')).toEqual(state());
    expect(reopened.work.load('q').records).toEqual([]);
    expect(reopened.load().projects[0]?.id).toBe('p');
});
test('rolls back work and legacy together on failure', () => {
    const { store } = fixture();
    expect(() => store.writeTransaction(legacy => {
        legacy.projects.push({
            id: 'p', name: 'P', version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0
        });
        store.work.save('p', state());
        throw Error('abort');
    })).toThrow('abort');
    expect(store.work.load('p').records).toHaveLength(0);
    expect(store.load().projects).toHaveLength(0);
});
test('refuses mixed-project writes', () => {
    const { store } = fixture();
    expect(() => store.work.save('q', state())).toThrow();
    expect(store.work.load('q').records).toHaveLength(0);
});
test('archives an exact authorized document version and retains it across restart', () => {
    const { store, dir } = fixture();
    const doc = {
        id: 'd', projectId: 'p', path: 'spec.md', kind: 'spec' as const, content: 'first', contentDigest: 'abc', version: 1, approval: 'accepted' as const, sourceRevision: 'source'
    };
    store.work.archiveDocument(doc);
    store.close();
    const reopened = openHubStore(dir);
    stores.push(reopened);
    expect(reopened.work.documentVersion('p', { documentId: 'd', version: 1, contentDigest: 'abc' })).toEqual(doc);
    expect(reopened.work.documentVersion('q', { documentId: 'd', version: 1, contentDigest: 'abc' })).toBeUndefined();
    expect(reopened.work.documentVersion('p', { documentId: 'd', version: 1, contentDigest: 'wrong' })).toBeUndefined();
});
test('activates the existing old-writer startup gate only on committed managed writes', () => {
    const { dir, store } = fixture();
    const db = new Database(join(dir, 'hub.sqlite'));
    const oldVersionCheck = () => {
        const row = db.query<{
            version: number;
        }, [
        ]>('SELECT version FROM remote_schema_version').get();
        if (row && row.version !== 1 && row.version !== 2)
            throw Error('Unsupported remote schema version');
    };
    expect(oldVersionCheck).not.toThrow();
    expect(() => store.writeTransaction(() => {
        store.work.save('p', state());
        throw Error('rollback');
    })).toThrow();
    expect(oldVersionCheck).not.toThrow();
    store.writeTransaction(() => store.work.save('p', state()));
    expect(oldVersionCheck).toThrow('Unsupported remote schema version');
    expect(db.query<{
        version: number;
    }, [
    ]>('SELECT version FROM remote_schema_version').get()?.version).toBe(3);
    db.close();
    store.close();
    const reopened = openHubStore(dir);
    stores.push(reopened);
    expect(reopened.work.load('p').records).toHaveLength(1);
});
test('execution reservations survive restart and cannot change principal or allocated run', () => {
    const { store, dir } = fixture();
    const reservation = {
        operationId: 'dispatch', projectId: 'p', actorId: 'human:operator', sessionDigest: 'session-digest', sessionId: 's', machineId: 'm', checkoutId: 'c', attemptId: 'a', flowId: 'f', intentId: 'i', flowRevisionId: 'fr', intentRevisionId: 'ir', contextSnapshotId: 'ctx', flowRevisionDigest: 'f-digest', intentRevisionDigest: 'i-digest', contextDigest: 'ctx-digest', associationDigest: 'association', wireAssociationDigest: 'wire', createdAt: 'now', state: 'reserved' as const, runId: null, turnId: null
    };
    store.work.saveExecutionReservation(reservation);
    expect(store.work.reservationsForAttempt('p', 'a')).toEqual([reservation]);
    expect(() => store.work.saveExecutionReservation({ ...reservation, actorId: 'other' })).toThrow();
    const bound = {
        ...reservation, state: 'bound' as const, runId: 'r', turnId: 't'
    };
    store.work.saveExecutionReservation(bound);
    store.close();
    const restored = openHubStore(dir);
    stores.push(restored);
    expect(restored.work.reservationForRun('r')).toEqual(bound);
    expect(() => restored.work.saveExecutionReservation({ ...bound, runId: 'other' })).toThrow();
});
test('Git observations append immutably with monotonic generations scoped to subject', () => {
    const { store } = fixture();
    expect(store.work.nextObservationGeneration('p', 's')).toBe(1);
    expect(store.work.nextObservationGeneration('p', 's')).toBe(2);
    expect(store.work.nextObservationGeneration('q', 's')).toBe(1);
    const observation = {
        id: 'observation', projectId: 'p', subjectId: 's', subjectDigest: 'digest', createdBy: 'human:a', observedAt: 'now', generation: 2, artifacts: [], contentDigest: 'hash'
    };
    store.work.saveGitObservation(observation);
    expect(store.work.gitObservations('p', 's')).toEqual([observation]);
    expect(() => store.work.saveGitObservation({ ...observation, contentDigest: 'changed' })).toThrow();
    expect(store.work.gitObservations('q', 's')).toEqual([]);
});
test('managed transactions and unchanged remote transactions never rewrite the legacy aggregate', () => {
    const { store, dir } = fixture();
    store.save(store.load());
    const db = new Database(join(dir, 'hub.sqlite'));
    db.exec('CREATE TABLE legacy_updates(n INTEGER); CREATE TRIGGER legacy_write AFTER UPDATE ON hub_state BEGIN INSERT INTO legacy_updates VALUES(1); END;');
    store.workTransaction(() => store.work.save('p', state()));
    store.writeTransaction(() => store.work.save('p', state()));
    expect(db.query('SELECT * FROM legacy_updates').all()).toEqual([]);
    db.close();
});
test('stale legacy snapshots cannot overwrite a later committed mutation', () => {
    const { store } = fixture();
    const stale = store.load();
    store.writeTransaction(legacy => { legacy.projects.push({ id: 'p', name: 'New', version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0 }); });
    expect(() => store.save(stale)).toThrow('Legacy state changed');
    expect(store.project('p')?.name).toBe('New');
});
test('conversion projection is visible to old guards without persisting a duplicate in hub_state', () => {
    const { store, dir } = fixture();
    store.work.markConverted('p','legacy','managed');
    const legacy = store.load();
    expect(legacy.legacyConversions?.legacy?.managedFlowId).toBe('managed');
    store.save(legacy);
    const db = new Database(join(dir,'hub.sqlite'));
    const row = db.query<{body:string},[]>('SELECT body FROM hub_state WHERE id=1').get();
    expect(JSON.parse(row!.body).legacyConversions).toBeUndefined();
    db.close();
});
test('tightens existing shared directory and live database file permissions', () => {
    const { store, dir } = fixture();
    store.close();
    chmodSync(dir,0o755);
    chmodSync(join(dir,'hub.sqlite'),0o644);
    const reopened = openHubStore(dir);
    stores.push(reopened);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir,'hub.sqlite')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir,'hub.sqlite-wal')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir,'hub.sqlite-shm')).mode & 0o777).toBe(0o600);
});
test('backup copies committed WAL records without allocating a whole database serialization buffer', () => {
    const { store, dir } = fixture();
    store.workTransaction(() => store.work.save('p',state()));
    const serialize = Database.prototype.serialize;
    Database.prototype.serialize = () => { throw Error('Whole database buffer forbidden'); };
    const destination = join(dir,'backup.sqlite');
    try { store.backup(destination); } finally { Database.prototype.serialize = serialize; }
    const backup = new Database(destination, { readonly: true });
    expect(backup.query('SELECT id FROM hub_work_records').all()).toEqual([{id:'flow-one'}]);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(() => store.backup(destination)).toThrow();
    backup.close();
});
