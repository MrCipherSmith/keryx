import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createHubApplication, type HubServerConfig } from '../server';
import { openHubStore } from '../store';
import { createWorkState, workCommand } from './domain';
import type { HubApplication, Principal } from '../contracts';
import { matchesWorkSchema } from './openapi';
const dirs: string[] = [], apps: HubApplication[] = [];
afterEach(() => {
    for (const app of apps.splice(0))
        app.close();
    for (const d of dirs.splice(0))
        rmSync(d, { recursive: true, force: true });
});
const operatorToken = 'operator-' + 'o'.repeat(64), agentToken = 'agent-' + 'a'.repeat(64), namedToken = 'named-' + 'n'.repeat(64), oid = 'a'.repeat(40), tree = 'b'.repeat(40);
function fixture(fetcher: (request: Request) => Promise<Response>) {
    const dir = mkdtempSync(join(tmpdir(), 'hub-observer-http-'));
    dirs.push(dir);
    const store = openHubStore(dir), legacy = store.load();
    legacy.projects.push({
        id: 'p', name: 'P', version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0
    });
    store.save(legacy);
    const state = createWorkState(), actor: Principal = { id: 'human:operator', kind: 'human', role: 'operator' };
    const context = { legacy, now: () => new Date().toISOString(), resolveRepository: () => ({ id: 'repo', projectId: 'p', objectFormat: 'sha1' as const }) };
    const cmd = (command: string, payload: unknown) => workCommand(state, actor, 'p', {
        operationId: randomUUID(), command, payload, expectedVersions: Object.fromEntries(state.records.filter(r => 'version' in r).map(r => [r.id, 'version' in r ? r.version : 1]))
    }, context).result as Record<string, unknown>;
    const criteria = [{ criterionId: 'c', text: 'Works', waivable: false }];
    const flow = cmd('flow.create', {
        title: 'Flow', problem: 'Problem', expectedOutcome: 'Outcome', scope: 'Scope', outOfScope: 'Other', ownerId: null, specification: null, criteria
    });
    const intent = cmd('intent.create', {
        flowId: flow.id, title: 'Intent', deliverable: 'Result', approach: 'Manual', outOfScope: 'Other', ownerId: null, required: true, criteria, flowCriterionIds: ['c'], criterionMappings: [{ intentCriterionId: 'c', flowCriterionId: 'c' }]
    });
    const fr = cmd('revision.propose', {
        targetType: 'flow', flowId: flow.id, problem: 'Problem', expectedOutcome: 'Outcome', scope: 'Scope', outOfScope: 'Other', specification: null, criteria, requiredIntentIds: [intent.id]
    });
    const ir = cmd('revision.propose', {
        targetType: 'intent', intentId: intent.id, flowRevisionId: fr.id, deliverable: 'Result', approach: 'Manual', outOfScope: 'Other', criteria, flowCriterionIds: ['c'], criterionMappings: [{ intentCriterionId: 'c', flowCriterionId: 'c' }]
    });
    for (const [targetType, r] of [['flow-revision', fr], ['intent-revision', ir]] as const)
        cmd('requirements.approve', {
            targetType, revisionId: r.id, revisionDigest: r.contentDigest, flowRevisionId: fr.id, reason: 'Approve'
        });
    cmd('flow.start', { flowId: flow.id, flowRevisionDigest: fr.contentDigest });
    const ctx = cmd('context.create', {
        flowRevisionId: fr.id, intentRevisionId: ir.id, entries: [], gitBases: []
    });
    const attempt = cmd('attempt.create', {
        intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: actor.id, method: 'human', summary: 'Work', supersedesAttemptId: null
    });
    cmd('attempt.start', {
        attemptId: attempt.id, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: ir.contentDigest, contextDigest: ctx.contentDigest
    });
    const subject = cmd('subject.create', { attemptId: attempt.id, artifacts: [{
                kind: 'git', repositoryId: 'repo', commitOid: oid, treeOid: null, pullRequestNumber: 9
            }], report: 'Result' });
    store.work.save('p', state);
    store.close();
    const config: HubServerConfig = {
        dataDir: dir, operatorToken, agentToken, workManagement: { enabled: true, repositories: [{
                    projectId: 'p', id: 'repo', objectFormat: 'sha1', github: {
                        apiOrigin: 'http://127.0.0.1:1', owner: 'team', repository: 'project', repositoryId: 7
                    }
                }], observerFetch: fetcher }
    };
    const app = createHubApplication(config);
    apps.push(app);
    const version = state.records.find(r => r.id === attempt.id && r.kind === 'attempt');
    const body = { operationId: randomUUID(), expectedVersions: { [String(attempt.id)]: version && 'version' in version ? version.version : 1 }, payload: { subjectDigest: subject.contentDigest } };
    return {
        dir, app, config, subject, body
    };
}
function provider(request: Request): Response {
    const path = new URL(request.url).pathname;
    const value = path.endsWith('/git/commits/' + oid) ? { sha: oid, tree: { sha: tree } } : path.endsWith('/pulls/9') ? {
        number: 9, base: { repo: { id: 7 } }, head: { sha: oid, repo: { id: 7 } }, state: 'open', updated_at: new Date().toISOString()
    } : { id: 7, full_name: 'team/project' };
    return Response.json(value);
}
function call(app: HubApplication, path: string, body?: unknown, token = operatorToken) {
    return app.fetch(new Request('http://hub.test/hub/work/v1/projects/p' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': String((body as {
                    operationId: string;
                }).operationId) }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
test('observes configured Git metadata, commits scoped receipt/event and replays across restart without provider effects', async () => {
    let calls = 0;
    const f = fixture(async (r) => {
        calls++;
        return provider(r);
    });
    const path = '/subjects/' + f.subject.id;
    const response = await call(f.app, path + '/observe', f.body);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.observation).toMatchObject({ projectId: 'p', subjectId: f.subject.id, generation: 1 });
    expect(result.observation.artifacts[0].availability).toBe('available');
    expect(typeof result.eventCursor).toBe('string');
    const originalSubject = await (await call(f.app, path)).json();
    expect(originalSubject.record.artifacts[0].verification).toBe('claimed');
    const before = calls;
    f.app.close();
    const restarted = createHubApplication(f.config);
    apps.push(restarted);
    expect(await (await call(restarted, path + '/observe', f.body)).json()).toEqual(result);
    expect(calls).toBe(before);
    const list = await (await call(restarted, path + '/observations')).json();
    expect(list.observations).toHaveLength(1);
    const receipt = await (await call(restarted, '/operations/' + f.body.operationId)).json();
    expect(receipt.result).toEqual(result);
    const bad = await call(restarted, path + '/observe', { ...f.body, payload: { subjectDigest: 'b'.repeat(64) } });
    expect(bad.status).toBe(409);
    expect((await call(restarted, '/subjects/foreign/observe', { ...f.body, operationId: randomUUID() })).status).toBe(404);
    expect(matchesWorkSchema(result, { $ref: '#/components/schemas/ObservationResult' })).toBe(true);
    expect(matchesWorkSchema(list, { $ref: '#/components/schemas/ObservationPage' })).toBe(true);
    expect(matchesWorkSchema(receipt, { $ref: '#/components/schemas/Operation' })).toBe(true);
});
test('persists pending observation outcome and rechecks revocation after provider IO before committing', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    let first = true;
    const f = fixture(async (r) => {
        if (first) {
            first = false;
            entered();
            await gate;
        }
        return provider(r);
    });
    const file = join(f.dir, 'agents.json');
    const write = (readOnly: boolean) => writeFileSync(file, JSON.stringify({ agents: [{
                id: 'observer', tokenDigest: createHash('sha256').update(namedToken).digest('hex'), projectIds: ['p'], readOnly
            }] }), { mode: 0o600 });
    write(false);
    f.app.close();
    const app = createHubApplication({ ...f.config, agentCredentialsFile: file });
    apps.push(app);
    const observing = call(app, '/subjects/' + f.subject.id + '/observe', f.body, namedToken);
    await started;
    const pending = await call(app, '/operations/' + f.body.operationId, undefined, namedToken);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ status: 'pending', result: null, eventCursor: null });
    write(true);
    release();
    expect((await observing).status).toBe(403);
    expect((await (await call(app, '/subjects/' + f.subject.id + '/observations', undefined, namedToken)).json()).observations).toHaveLength(0);
});
test('post-provider Attempt version drift cannot commit an observation against stale guards', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    let first = true;
    const f = fixture(async (r) => {
        if (first) {
            first = false;
            entered();
            await gate;
        }
        return provider(r);
    });
    const observing = call(f.app, '/subjects/' + f.subject.id + '/observe', f.body);
    await started;
    const reported = await call(f.app, '/commands', {
        operationId: randomUUID(), command: 'attempt.report', expectedVersions: f.body.expectedVersions, payload: { attemptId: f.subject.attemptId, event: 'progress', report: 'New progress' }
    });
    expect(reported.status).toBe(200);
    release();
    expect((await observing).status).toBe(409);
    const failed = await call(f.app, '/operations/' + f.body.operationId);
    expect(failed.status).toBe(404);
    const records = await (await call(f.app, '/subjects/' + f.subject.id + '/observations')).json();
    expect(records.observations).toHaveLength(0);
    const events = await (await call(f.app, '/events')).json();
    expect(events.events.some((e: {
        type: string;
    }) => e.type === 'git-observed')).toBe(false);
});
test('a restarted pending read resumes the exact durable job generation and observation identity', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    const f = fixture(async (r) => {
        entered();
        await gate;
        return provider(r);
    });
    const original = call(f.app, '/subjects/' + f.subject.id + '/observe', f.body);
    await started;
    const store = openHubStore(f.dir);
    const job = store.work.observationJob('p', 'human:operator', f.body.operationId)!;
    expect(job.generation).toBe(1);
    store.close();
    f.app.close();
    const restarted = createHubApplication({ ...f.config, workManagement: { ...f.config.workManagement!, observerFetch: async (r) => provider(r) } });
    apps.push(restarted);
    const resumed = await call(restarted, '/subjects/' + f.subject.id + '/observe', f.body);
    expect(resumed.status).toBe(200);
    const result = await resumed.json();
    expect(result.observation).toMatchObject({ id: job.observationId, generation: job.generation });
    expect(result.receiptId).toBe(job.receiptId);
    expect((await call(restarted, '/operations/' + f.body.operationId)).status).toBe(200);
    release();
    expect([500, 503]).toContain((await original).status);
    expect((await (await call(restarted, '/subjects/' + f.subject.id + '/observations')).json()).observations).toHaveLength(1);
});
