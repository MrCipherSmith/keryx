import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHubStore } from './store';
import { migrateRemote as migrateV045 } from './fixtures/writer-v045-migration.test-support';

// Uses the actual tagged v0.4.5 startup gate, not a hand-written comparison against a new constant.
test('activates legacy review storage on a trial copy, fences the actual v0.4.5 writer, and preserves a usable rollback copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-review-writer-copy-'));
  const live = join(root, 'old'), trial = join(root, 'trial'); mkdirSync(live); mkdirSync(trial);
  let source: Database | undefined;
  try {
    const seed = openHubStore(live), state = seed.load();
    state.projects.push({ id: 'historical', name: 'Historical', version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0 });
    state.flows.push({ id: 'accepted', projectId: 'historical', title: 'Already accepted', specDocumentId: 'spec', specContentDigest: 'a'.repeat(64), criteria: ['Original criterion'], status: 'done', version: 7, subjectRevisionId: 'result', acceptedBy: 'human:reviewer', acceptedAt: '2026-01-01T00:00:00.000Z', receipt: { id: 'original', actorId: 'human:reviewer', createdAt: '2026-01-01T00:00:00.000Z' } });
    seed.save(state); seed.close();
    source = new Database(join(live, 'hub.sqlite'));
    // Reproduce a pre-feature v0.4.5 file; then only activate the disposable VACUUM copy.
    source.exec('DROP TABLE IF EXISTS hub_legacy_review_decisions; UPDATE remote_schema_version SET version=4');
    expect(() => migrateV045(source!)).not.toThrow();
    const before = source.query<{ body: string }, []>('SELECT body FROM hub_state WHERE id=1').get()!.body;
    source.query('VACUUM INTO ?').run(join(trial, 'hub.sqlite'));
    const migrated = openHubStore(trial);
    expect(migrated.load().flows.find(flow => flow.id === 'accepted')).toEqual(state.flows[0]);
    migrated.close();
    const activated = new Database(join(trial, 'hub.sqlite'));
    try {
      expect(activated.query<{ version: number }, []>('SELECT version FROM remote_schema_version').get()!.version).toBeGreaterThan(4);
      expect(activated.query("SELECT name FROM sqlite_master WHERE type='table' AND name='hub_legacy_review_decisions'").get()).toBeTruthy();
      expect(() => migrateV045(activated)).toThrow('Unsupported remote schema version');
    } finally { activated.close(); }
    expect(source.query<{ body: string }, []>('SELECT body FROM hub_state WHERE id=1').get()!.body).toBe(before);
    expect(() => migrateV045(source!)).not.toThrow();
    const restored = openHubStore(live);
    expect(restored.load().flows.find(flow => flow.id === 'accepted')).toEqual(state.flows[0]); restored.close();
  } finally { source?.close(); rmSync(root, { recursive: true, force: true }); }
});
