import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHubStore, type HubStore } from '../store';
import type { Principal } from '../contracts';
import { createLegacyConversion } from './legacy';
import { hubMutate } from '../domain';
import { checkAssociation } from '../remote-v2/sessions';
import { criteriaDigest } from '../../remote-control/protocol';
const dirs: string[] = [], stores: HubStore[] = [];
afterEach(() => {
    for (const s of stores.splice(0))
        s.close();
    for (const p of dirs.splice(0))
        rmSync(p, { recursive: true, force: true });
});
const human: Principal = { id: 'human:operator', kind: 'human', role: 'operator' }, agent: Principal = { id: 'agent:a', kind: 'agent', role: 'agent' };
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'hub-work-legacy-'));
    dirs.push(dir);
    const store = openHubStore(dir);
    stores.push(store);
    const legacy = store.load();
    legacy.projects.push({
        id: 'p', name: 'P', version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0
    });
    legacy.documents.push({
        id: 'doc', projectId: 'p', path: 'spec.md', kind: 'spec', content: 'spec', contentDigest: 'a'.repeat(64), version: 1, approval: 'accepted', sourceRevision: 'source'
    });
    legacy.flows.push({
        id: 'old', projectId: 'p', title: 'Old', specDocumentId: 'doc', specContentDigest: 'a'.repeat(64), criteria: ['One'], status: 'ready', version: 2, subjectRevisionId: null
    });
    store.save(legacy);
    return { dir, store, legacy };
}
const payload = (preview: {
    receiptId: string;
    contentDigest: string;
}) => ({
    legacyFlowId: 'old', sourceVersion: 2, dryRunReceiptId: preview.receiptId, dryRunDigest: preview.contentDigest, intent: {
        title: 'New intent', deliverable: 'Deliver', approach: 'Manual', outOfScope: 'Other', ownerId: null, required: true, criteria: [{ criterionId: 'c1', text: 'One', waivable: false }], flowCriterionIds: ['legacy-1']
    }
});
test('dry-run is human/actor scoped, revalidates source and remote execution before confirmation', () => {
    const { store, legacy } = fixture();
    const hooks = createLegacyConversion(store, legacy, () => '2026-01-01');
    expect(() => hooks.preview(agent, 'p', { legacyFlowId: 'old', sourceVersion: 2 })).toThrow();
    const preview = hooks.preview(human, 'p', { legacyFlowId: 'old', sourceVersion: 2 });
    expect(preview.status).toBe('eligible');
    expect(() => hooks.convert({ ...human, id: 'human:other' }, 'p', payload(preview))).toThrow();
    legacy.flows[0]!.version++;
    expect(() => hooks.convert(human, 'p', payload(preview))).toThrow();
    legacy.flows[0]!.version = 2;
    store.remote.put('remote_run', 'run', { runId: 'run', state: 'unknown', association: { mode: 'flow', flowId: 'old' } }, { projectId: 'p' });
    expect(() => hooks.convert(human, 'p', payload(preview))).toThrow();
});
test('conversion guard freezes all direct legacy transitions, remote admission and survives restore', async () => {
    const { store, legacy, dir } = fixture();
    const hooks = createLegacyConversion(store, legacy, () => '2026-01-01');
    const preview = hooks.preview(human, 'p', { legacyFlowId: 'old', sourceVersion: 2 });
    store.writeTransaction(current => {
        const tx = createLegacyConversion(store, current, () => '2026-01-01');
        tx.convert(human, 'p', payload(preview));
        tx.converted('old', 'new-managed');
    });
    const guarded = store.load();
    expect(guarded.flows[0]).toEqual(legacy.flows[0]);
    const config = { dataDir: dir, operatorToken: 'o'.repeat(64), agentToken: 'a'.repeat(64) };
    for (const action of ['freeze', 'start', 'submit-for-review', 'accept', 'evidence'])
        await expect(hubMutate(guarded, human, ['projects', 'p', 'flows', 'old', action], { expectedVersion: 2 }, config, async () => ({ status: 'failed', error: 'unused' }), 'operation')).rejects.toMatchObject({ code: 'flow-converted' });
    expect(() => checkAssociation(guarded, {
        mode: 'flow', flowId: 'old', expectedFlowVersion: 2, specDigest: 'a'.repeat(64), criteriaDigest: criteriaDigest(['One'])
    }, 'p')).toThrow();
    const backup = join(dir, 'backup.sqlite');
    store.backup(backup);
    const restored = mkdtempSync(join(tmpdir(), 'hub-work-restore-'));
    dirs.push(restored);
    copyFileSync(backup, join(restored, 'hub.sqlite'));
    const restore = openHubStore(restored);
    stores.push(restore);
    expect(restore.work.conversion('p', 'old')).toBe('new-managed');
    expect(() => createLegacyConversion(restore, restore.load(), () => 'now').preview(human, 'p', { legacyFlowId: 'old', sourceVersion: 2 })).toThrow();
});
test('idle eligibility refuses queued work, unuploaded terminal result and pending approval', () => {
    const { store, legacy } = fixture();
    const check = () => createLegacyConversion(store, legacy, () => 'now').preview(human, 'p', { legacyFlowId: 'old', sourceVersion: 2 });
    store.remote.put('remote_queue', 'q', { item: { state: 'queued' }, association: { mode: 'flow', flowId: 'old' } }, { projectId: 'p' });
    expect(check).toThrow();
    store.remote.delete('remote_queue', 'q');
    store.remote.put('remote_run', 'r', { runId: 'r', state: 'succeeded', association: { mode: 'flow', flowId: 'old' } }, { projectId: 'p' });
    expect(check).toThrow();
    store.remote.put('remote_run', 'r', {
        runId: 'r', state: 'succeeded', terminalAt: '2026-11-01T00:00:00Z', result: { receiptId: 'done' }, association: { mode: 'flow', flowId: 'old' }
    }, { projectId: 'p' });
    store.remote.put('remote_approval_projection', 'approval', { runId: 'r', status: 'waiting' }, { projectId: 'p' });
    expect(check).toThrow();
});
test('unallocated command confirmation blocks conversion before it can later admit work', () => {
    const { store, legacy } = fixture();
    store.remote.put('remote_confirmation', 'confirmation', { consumed: false, original: { association: { mode: 'flow', flowId: 'old' } } }, { projectId: 'p' });
    expect(() => createLegacyConversion(store, legacy, () => 'now').preview(human, 'p', { legacyFlowId: 'old', sourceVersion: 2 })).toThrow();
});

for (const state of ['suspended', 'admitted']) test(`legacy conversion refuses native queue state ${state} without a settled run`, () => {
    const { store, legacy } = fixture();
    store.remote.put('remote_queue', 'q', { item: { state }, request: { association: { mode: 'flow', flowId: 'old' } } }, { projectId: 'p' });
    expect(() => createLegacyConversion(store, legacy, () => 'now').preview(human, 'p', { legacyFlowId: 'old', sourceVersion: 2 })).toThrow('queue');
});
for (const status of ['waiting', 'recorded', 'delivered', 'applied', 'not-applied', 'expired']) test(`legacy conversion handles actual approval state ${status}`, () => {
    const { store, legacy } = fixture();
    store.remote.put('remote_run', 'r', { runId: 'r', state: 'succeeded', terminalAt: '2026-11-01T00:00:00Z', result: { receiptId: 'done' }, association: { mode: 'flow', flowId: 'old' } }, { projectId: 'p' });
    store.remote.put('remote_approval_projection', 'approval', { runId: 'r', status }, { projectId: 'p' });
    const check = () => createLegacyConversion(store, legacy, () => 'now').preview(human, 'p', { legacyFlowId: 'old', sourceVersion: 2 });
    if (['applied', 'not-applied', 'expired'].includes(status)) expect(check().status).toBe('eligible');
    else expect(check).toThrow('approval');
});
