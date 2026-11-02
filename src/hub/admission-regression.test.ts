import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubApplication } from './server';
import { openHubStore } from './store';
import { sha256, HubFailure } from './domain';
import { createRemoteControl } from './remote-v2/index';

const bounded = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('test deadline exceeded')), 5000))]);

test('slow public login bodies cannot exhaust authenticated mutation admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-admission-'));
  const token = 'operator-' + 'o'.repeat(64);
  const app = createHubApplication({ dataDir: root, operatorToken: token, agentToken: 'agent-' + 'a'.repeat(64) });
  const controllers: AbortController[] = [], pending: Promise<Response>[] = [];
  const mutation = (key: string) => app.fetch(new Request('http://hub.test/hub/v1/projects', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ name: 'Admission control' }) }));
  let entered = 0;
  const ready = Promise.withResolvers<void>();
  try {
    expect((await bounded(mutation('before'))).status).toBe(200);
    for (let i = 0; i < 32; i++) {
      const abort = new AbortController(); controllers.push(abort);
      let reported = false;
      const body = new ReadableStream<Uint8Array>({ pull() { if (!reported) { reported = true; if (++entered === 32) ready.resolve(); } } }, { highWaterMark: 0 });
      pending.push(app.fetch(new Request('http://hub.test/hub/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: abort.signal })));
    }
    await bounded(ready.promise);
    expect((await bounded(mutation('during'))).status).toBe(200);
  } finally {
    for (const controller of controllers) controller.abort();
    await bounded(Promise.allSettled(pending));
    try { expect((await bounded(mutation('after'))).status).toBe(200); }
    finally { app.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('authenticated machine stream over remote parser limit is cancelled without mutating state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-stream-limit-'));
  const store = openHubStore(root), secret = 'machine-secret';
  const record = { machineId: 'machine', version: 1, displayName: 'machine', projectIds: [], credentialDigest: sha256(secret), ledgerId: 'ledger', revoked: false, createdAt: new Date().toISOString(), lastSeenAt: null, epoch: 0, hubSequence: 0, inventoryVersion: 0, recoveryRequired: false };
  store.writeTransaction((_state, repo) => repo.put('remote_machine', record.machineId, record));
  const remote = createRemoteControl({ store, serialized: async action => action(), human: async () => { throw new Error('machine authentication failed'); }, authorityValid: () => true, checkOrigin: () => undefined, transportAllowed: () => true });
  let cancelled = false, sent = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 33) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  try {
    const request = new Request('http://hub.test/hub/v2/projects/p/runs/r/results', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body });
    let error: unknown;
    try { await remote.handle(request); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(HubFailure);
    expect((error as HubFailure).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(store.remote.get('remote_machine', record.machineId)).toEqual(record);
    expect(store.remote.all('remote_operation')).toEqual([]);
  } finally { remote.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
