import {Database} from 'bun:sqlite';
import {matchesWorkSchema} from './openapi';
import { openHubStore } from '../store';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createHubApplication, loadHubConfig, type HubServerConfig } from '../server';
import type { HubApplication } from '../contracts';
const operatorToken = 'operator-' + 'o'.repeat(64), agentToken = 'agent-' + 'a'.repeat(64), reviewerToken = 'reviewer-' + 'r'.repeat(64), namedToken = 'named-' + 'n'.repeat(64);
let dir: string, app: HubApplication, config: HubServerConfig;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hub-work-http-'));
    config = {
        dataDir: dir, operatorToken, agentToken, reviewerToken, workManagement: { enabled: true }
    };
    app = createHubApplication(config);
});
afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
});
async function req(path: string, body?: unknown, token: string | null = operatorToken, extra: Record<string, string> = {}) {
    const headers = new Headers(extra);
    if (token)
        headers.set('authorization', 'Bearer ' + token);
    if (body !== undefined) {
        headers.set('content-type', 'application/json');
        if (!headers.has('idempotency-key'))
            headers.set('idempotency-key', (body as {
                operationId?: string;
            }).operationId ?? randomUUID());
    }
    return app.fetch(new Request('http://hub.test' + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
async function project() {
    const r = await req('/hub/v1/projects', { name: 'Work' });
    expect(r.status).toBe(200);
    return (await r.json()).id as string;
}
const base = (p: string) => '/hub/work/v1/projects/' + p;
function command(title = 'First', operationId = randomUUID()) {
    return {
        operationId, command: 'flow.create', expectedVersions: {}, payload: {
            title, problem: 'problem', expectedOutcome: 'outcome', scope: 'scope', outOfScope: 'excluded', ownerId: null, specification: null, criteria: [{ criterionId: 'c1', text: 'Done', waivable: false }]
        }
    };
}
test('authenticates, advertises actual features and preserves disabled legacy API', async () => {
    const p = await project();
    expect((await req(base(p) + '/capabilities', undefined, null)).status).toBe(401);
    const caps = await (await req(base(p) + '/capabilities')).json();
    expect(caps).toMatchObject({ enabled: true, features: { managedExecution: true, gitObserver: false, legacyConversion: true } });
    expect(caps.allowedCommands).toContain('flow.create');
    expect(caps.allowedCommands).toContain('execution.bind');
    app.close();
    app = createHubApplication({ ...config, workManagement: { enabled: false } });
    expect(await (await req(base(p) + '/capabilities')).json()).toMatchObject({ enabled: false, allowedCommands: [] });
    expect((await req(base(p) + '/commands', command())).status).toBe(404);
    expect((await req('/hub/v1/projects')).status).toBe(200);
});
test('commits receipt/state/events once across restart; conflicts never overwrite', async () => {
    const p = await project(), body = command();
    const first = await req(base(p) + '/commands', body);
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result.entities.length).toBeGreaterThan(0);
    app.close();
    app = createHubApplication(config);
    expect(await (await req(base(p) + '/commands', body)).json()).toEqual(result);
    expect((await req(base(p) + '/commands', { ...body, payload: { ...body.payload, title: 'Changed' } })).status).toBe(409);
    const events = await (await req(base(p) + '/events')).json();
    expect(events.events.length).toBeGreaterThan(0);
    const receipt = await (await req(base(p) + '/operations/' + body.operationId)).json();
    expect(receipt.result).toEqual(result);
    expect((await req(base(p) + '/operations/' + body.operationId, undefined, reviewerToken)).status).toBe(404);
});
test('rejects missing guards atomically and cross-project record access', async () => {
    const p = await project(), q = await project();
    const result = await (await req(base(p) + '/commands', command())).json();
    const f = result.entities.find((r: {
        kind: string;
    }) => r.kind === 'flow');
    expect((await req(base(q) + '/flows/' + f.id)).status).toBe(404);
    const body = {
        operationId: randomUUID(), command: 'work.cancel', expectedVersions: {}, payload: { targetType: 'flow', targetId: f.id, reason: 'cancel' }
    };
    expect((await req(base(p) + '/commands', body)).status).toBe(409);
    expect((await req(base(p) + '/operations/' + body.operationId)).status).toBe(404);
});
test('requires cookie Origin and blocks agent protected commands', async () => {
    const p = await project();
    const login = await req('/hub/v1/session', { token: operatorToken }, null);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await req(base(p) + '/commands', command(), null, { cookie, origin: 'https://evil.test' })).status).toBe(403);
    expect((await req(base(p) + '/commands', command(), null, { cookie, origin: 'http://hub.test' })).status).toBe(200);
    const protectedBody = {
        operationId: randomUUID(), command: 'work.cancel', expectedVersions: {}, payload: { targetType: 'flow', targetId: 'missing', reason: 'cancel' }
    };
    expect((await req(base(p) + '/commands', protectedBody, agentToken)).status).toBe(403);
});
test('rechecks named agent scope and readOnly before replay', async () => {
    const p = await project(), q = await project();
    const file = join(dir, 'agents.json');
    const write = (projectIds: string[], readOnly = false) => writeFileSync(file, JSON.stringify({ agents: [{
                id: 'worker', tokenDigest: createHash('sha256').update(namedToken).digest('hex'), projectIds, readOnly
            }] }), { mode: 0o600 });
    write([p]);
    app.close();
    config = { ...config, agentCredentialsFile: file };
    app = createHubApplication(config);
    const body = command();
    expect((await req(base(p) + '/commands', body, namedToken)).status).toBe(200);
    expect((await req(base(q) + '/capabilities', undefined, namedToken)).status).toBe(403);
    write([p], true);
    expect((await req(base(p) + '/commands', body, namedToken)).status).toBe(403);
    write([]);
    expect((await req(base(p) + '/operations/' + body.operationId, undefined, namedToken)).status).toBe(403);
});
test('bounds streaming bodies without Content-Length and validates matching operation id', async () => {
    const p = await project();
    const body = command();
    expect((await req(base(p) + '/commands', body, operatorToken, { 'idempotency-key': 'different' })).status).toBe(400);
    const bytes = new TextEncoder().encode(JSON.stringify({ ...body, payload: { ...body.payload, title: 'x'.repeat(65536) } }));
    const stream = new ReadableStream<Uint8Array>({ start(c) {
            c.enqueue(bytes.subarray(0, 40000));
            c.enqueue(bytes.subarray(40000));
            c.close();
        } });
    const response = await app.fetch(new Request('http://hub.test' + base(p) + '/commands', { method: 'POST', headers: { authorization: 'Bearer ' + operatorToken, 'content-type': 'application/json', 'idempotency-key': body.operationId }, body: stream }));
    expect(response.status).toBe(413);
});
test('snapshots remain consistent and cursor tokens cannot cross principal/project', async () => {
    const p = await project(), q = await project();
    await req(base(p) + '/commands', command());
    const first = await (await req(base(p) + '/snapshot?limit=1')).json();
    expect(first.records).toHaveLength(1);
    expect(typeof first.nextCursor).toBe('string');
    await req(base(p) + '/commands', command('Second'));
    const second = await (await req(base(p) + '/snapshot?limit=1&cursor=' + encodeURIComponent(first.nextCursor))).json();
    expect(second.eventCursor).toBe(first.eventCursor);
    expect((await req(base(q) + '/snapshot?cursor=' + encodeURIComponent(first.nextCursor))).status).toBe(410);
    expect((await req(base(p) + '/snapshot?cursor=' + encodeURIComponent(first.nextCursor), undefined, reviewerToken)).status).toBe(410);
    const events = await (await req(base(p) + '/events?limit=1')).json();
    expect(typeof events.nextCursor).toBe('string');
    expect((await req(base(q) + '/events?after=' + encodeURIComponent(events.nextCursor))).status).toBe(410);
});
test('snapshot cursor resumes only later work and stable receipt cursor survives restart', async () => {
    const p = await project();
    const first = await (await req(base(p) + '/commands', command())).json();
    const snapshot = await (await req(base(p) + '/snapshot?limit=1')).json();
    expect(typeof snapshot.eventCursor).toBe('string');
    const nextBody = command('Later');
    const later = await (await req(base(p) + '/commands', nextBody)).json();
    const events = await (await req(base(p) + '/events?after=' + encodeURIComponent(snapshot.eventCursor))).json();
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.events.every((e: {
        operationId: string;
    }) => e.operationId === nextBody.operationId)).toBe(true);
    app.close();
    app = createHubApplication(config);
    expect(await (await req(base(p) + '/commands', nextBody)).json()).toEqual(later);
    expect((await req(base(p) + '/events?after=' + encodeURIComponent(first.eventCursor))).status).toBe(200);
    expect((await req(base(p) + '/snapshot?cursor=' + encodeURIComponent(snapshot.nextCursor))).status).toBe(410);
});
test('a guarded committed transition replays after its original version becomes stale', async () => {
    const p = await project();
    const created = await (await req(base(p) + '/commands', command())).json();
    const flow = created.entities.find((r: {
        kind: string;
    }) => r.kind === 'flow');
    const body = {
        operationId: randomUUID(), command: 'work.cancel', expectedVersions: { [flow.id]: flow.version }, payload: { targetType: 'flow', targetId: flow.id, reason: 'No longer needed' }
    };
    const first = await req(base(p) + '/commands', body);
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(await (await req(base(p) + '/commands', body)).json()).toEqual(result);
    expect((await req(base(p) + '/commands', { ...body, operationId: randomUUID() })).status).toBe(409);
});
test('serves the work contract over a real local HTTP connection', async () => {
    const p = await project();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    try {
        const response = await fetch(new URL(base(p) + '/capabilities', server.url), { headers: { authorization: 'Bearer ' + operatorToken } });
        expect(response.status).toBe(200);
        expect((await response.json()).enabled).toBe(true);
    }
    finally {
        await server.stop(true);
    }
});
async function legacyFlowFixture(p: string) {
    const imported = await (await req('/hub/v1/projects/' + p + '/import', { expectedVersion: 1, sourceRevision: 'source', documents: [{ path: 'spec.md', kind: 'spec', content: 'Legacy spec' }] })).json();
    const created = await (await req('/hub/v1/projects/' + p + '/flows', { title: 'Legacy', specDocumentId: imported.documents[0].id, criteria: ['Original requirement'] })).json();
    return (await (await req('/hub/v1/projects/' + p + '/flows/' + created.id + '/freeze', { expectedVersion: created.version })).json());
}
test('explicit human conversion creates fresh draft requirements and freezes old legacy writers', async () => {
    const p = await project(), old = await legacyFlowFixture(p);
    const previewCommand = {
        operationId: randomUUID(), command: 'legacy.preview', expectedVersions: { [old.id]: old.version }, payload: { legacyFlowId: old.id, sourceVersion: old.version }
    };
    expect((await req(base(p) + '/commands', previewCommand, agentToken)).status).toBe(403);
    const response = await req(base(p) + '/commands', previewCommand);
    expect(response.status).toBe(200);
    const preview = (await response.json()).preview;
    expect(preview.status).toBe('eligible');
    const body = {
        operationId: randomUUID(), command: 'legacy.convert', expectedVersions: { [old.id]: old.version }, payload: {
            legacyFlowId: old.id, sourceVersion: old.version, dryRunReceiptId: preview.receiptId, dryRunDigest: preview.contentDigest, intent: {
                title: 'Explicit intent', deliverable: 'Result', approach: 'Manual', outOfScope: 'Other', ownerId: null, required: true, criteria: [{ criterionId: 'c1', text: 'Requirement', waivable: false }], flowCriterionIds: ['legacy-1']
            }
        }
    };
    const converted = await req(base(p) + '/commands', body);
    expect(converted.status).toBe(200);
    const result = await converted.json();
    const managed = result.entities.find((r: {
        kind: string;
    }) => r.kind === 'flow');
    expect(managed).toMatchObject({ legacyFlowId: old.id, state: 'draft', approvedRevisionId: null });
    expect(result.entities.some((r: {
        kind: string;
    }) => r.kind === 'intent')).toBe(true);
    expect((await req('/hub/v1/projects/' + p + '/flows/' + old.id + '/start', { expectedVersion: old.version })).status).toBe(409);
    expect(await (await req('/hub/v1/projects/' + p + '/flows/' + old.id)).json()).toEqual(old);
    expect(await (await req(base(p) + '/commands', body)).json()).toEqual(result);
    app.close();
    app = createHubApplication(config);
    expect((await req('/hub/v1/projects/' + p + '/flows/' + old.id + '/start', { expectedVersion: old.version })).status).toBe(409);
});
test('conversion and legacy start races have one winner with no dual authority', async () => {
    const p = await project(), old = await legacyFlowFixture(p);
    const preview = await (await req(base(p) + '/commands', {
        operationId: randomUUID(), command: 'legacy.preview', expectedVersions: { [old.id]: old.version }, payload: { legacyFlowId: old.id, sourceVersion: old.version }
    })).json();
    const body = {
        operationId: randomUUID(), command: 'legacy.convert', expectedVersions: { [old.id]: old.version }, payload: {
            legacyFlowId: old.id, sourceVersion: old.version, dryRunReceiptId: preview.preview.receiptId, dryRunDigest: preview.preview.contentDigest, intent: {
                title: 'Intent', deliverable: 'Result', approach: 'Manual', outOfScope: 'Other', ownerId: null, required: true, criteria: [{ criterionId: 'c1', text: 'Requirement', waivable: false }], flowCriterionIds: ['legacy-1']
            }
        }
    };
    const results = await Promise.all([req(base(p) + '/commands', body), req('/hub/v1/projects/' + p + '/flows/' + old.id + '/start', { expectedVersion: old.version })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
});
test('repository registry is explicit project scoped configuration and rejects malformed admin input', () => {
    const common = { KERYX_HUB_DATA_DIR: dir, KERYX_HUB_OPERATOR_TOKEN: operatorToken, KERYX_HUB_AGENT_TOKEN: agentToken };
    expect(loadHubConfig({ ...common, KERYX_HUB_WORK_ENABLED: 'true', KERYX_HUB_WORK_REPOSITORIES: JSON.stringify([{ projectId: 'p', id: 'repo', objectFormat: 'sha1' }]) }).workManagement?.repositories).toEqual([{ projectId: 'p', id: 'repo', objectFormat: 'sha1' }]);
    expect(() => loadHubConfig({ ...common, KERYX_HUB_WORK_REPOSITORIES: JSON.stringify([{
                projectId: 'p', id: 'repo', objectFormat: 'sha1', token: 'secret'
            }]) })).toThrow();
    expect(() => loadHubConfig({ ...common, KERYX_HUB_WORK_REPOSITORIES: '[' })).toThrow();
});
test('refuses credential material in work metadata before persistence and never echoes it', async () => {
    const p = await project(), body = command('report ' + operatorToken);
    const rejected = await req(base(p) + '/commands', body);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain(operatorToken);
    expect((await req(base(p) + '/operations/' + body.operationId)).status).toBe(404);
    expect((await (await req(base(p) + '/flows')).json()).records).toHaveLength(0);
    const backupStore = openHubStore(dir);
    const backup = join(dir, 'credential-check.sqlite');
    try {
        backupStore.backup(backup);
    }
    finally {
        backupStore.close();
    }
    expect(readFileSync(backup).includes(Buffer.from(operatorToken))).toBe(false);
    expect(readFileSync(backup).includes(Buffer.from(agentToken))).toBe(false);
});
test('malformed Unicode cursor signatures fail with a bounded resync error', async () => {
    const p = await project();
    await req(base(p) + '/commands', command());
    const valid = (await (await req(base(p) + '/events')).json()).nextCursor;
    const malformed = valid.split('.')[0] + '.' + 'é'.repeat(43);
    const response = await req(base(p) + '/events?after=' + encodeURIComponent(malformed));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: 'resync-required' } });
});
test('Git capability reflects only repositories configured for the authorized project',async()=>{const p=await project();app.close();app=createHubApplication({...config,workManagement:{enabled:true,repositories:[{projectId:'another-project',id:'repo',objectFormat:'sha1',github:{apiOrigin:'https://api.github.com',owner:'team',repository:'project',repositoryId:7}}]}});const capabilities=await(await req(base(p)+'/capabilities')).json();expect(capabilities.features.gitObserver).toBe(false);});
test('fetches exact pinned historical Hub document bytes after update and restart without latest fallback',async()=>{const p=await project(),other=await project();const imported=await(await req('/hub/v1/projects/'+p+'/import',{expectedVersion:1,sourceRevision:'source',documents:[{path:'wiki/context.md',kind:'wiki',content:'# Old immutable context'}]})).json();const doc=imported.documents[0];const created=await(await req(base(p)+'/commands',command())).json();const flow=created.entities.find((r:{kind:string})=>r.kind==='flow');const intentResult=await(await req(base(p)+'/commands',{operationId:randomUUID(),command:'intent.create',expectedVersions:{[flow.id]:flow.version},payload:{flowId:flow.id,title:'Intent',deliverable:'Result',approach:'Manual',outOfScope:'Other',ownerId:null,required:true,criteria:[{criterionId:'ic',text:'Result',waivable:false}],flowCriterionIds:['c1'],criterionMappings:[{intentCriterionId:'ic',flowCriterionId:'c1'}]}})).json();const intent=intentResult.entities.find((r:{kind:string})=>r.kind==='intent');const ctx=await req(base(p)+'/commands',{operationId:randomUUID(),command:'context.create',expectedVersions:{[intent.id]:intent.version},payload:{flowRevisionId:flow.currentRevisionId,intentRevisionId:intent.currentRevisionId,entries:[{entryId:'wiki',role:'wiki',reference:{documentId:doc.id,version:doc.version,contentDigest:doc.contentDigest},required:true,contentDigest:doc.contentDigest}],gitBases:[]}});expect(ctx.status).toBe(200);const proposal=await(await req('/hub/v1/projects/'+p+'/proposals',{documentId:doc.id,baseVersion:doc.version,content:'# New latest context',reason:'Update wiki'})).json();expect((await req('/hub/v1/projects/'+p+'/proposals/'+proposal.id+'/review',{decision:'accepted',expectedVersion:proposal.version,contentDigest:proposal.contentDigest})).status).toBe(200);app.close();app=createHubApplication(config);const path='/documents/'+doc.id+'/versions/'+doc.version+'?digest='+doc.contentDigest;const old=await req(base(p)+path,undefined,agentToken);expect(old.status).toBe(200);const result=await old.json();expect(result.document).toEqual({id:doc.id,projectId:p,path:doc.path,kind:doc.kind,version:doc.version,contentDigest:doc.contentDigest,content:doc.content});expect(typeof result.eventCursor).toBe('string');expect(matchesWorkSchema(result,{$ref:'#/components/schemas/DocumentVersion'})).toBe(true);expect((await(await req('/hub/v1/projects/'+p+'/documents/'+doc.id)).json()).content).toBe('# New latest context');expect((await req(base(other)+path)).status).toBe(404);expect((await req(base(p)+path.replace(doc.contentDigest,'f'.repeat(64)))).status).toBe(404);const db=new Database(join(dir,'hub.sqlite'));db.query("UPDATE hub_work_documents SET body=json_set(body,'$.content',?) WHERE project_id=? AND document_id=? AND version=?").run('tampered archive',p,doc.id,doc.version);db.close();expect((await req(base(p)+path)).status).toBe(404);});
test('completed single-page snapshots never retain exports or exhaust normal refreshes',async()=>{const p=await project();await req(base(p)+'/commands',command());for(let index=0;index<100;index++){const response=await req(base(p)+'/snapshot');expect(response.status).toBe(200);expect((await response.json()).nextCursor).toBeNull();}});
test('terminal multi-page snapshots reclaim quota while unfinished scoped exports remain bounded',async()=>{const p=await project(),q=await project();await req(base(p)+'/commands',command());for(let index=0;index<100;index++){const first=await req(base(p)+'/snapshot?limit=1');expect(first.status).toBe(200);const page=await first.json();const last=await req(base(p)+'/snapshot?limit=1&cursor='+encodeURIComponent(page.nextCursor));expect(last.status).toBe(200);const terminal=await last.json();expect(terminal.nextCursor).toBeNull();expect(terminal.eventCursor).toBe(page.eventCursor);}const cursors:string[]=[];for(let index=0;index<32;index++){const response=await req(base(p)+'/snapshot?limit=1');expect(response.status).toBe(200);cursors.push((await response.json()).nextCursor);}expect((await req(base(p)+'/snapshot?limit=1')).status).toBe(413);expect((await req(base(p)+'/snapshot?limit=200')).status).toBe(200);expect((await req(base(q)+'/snapshot?limit=1&cursor='+encodeURIComponent(cursors[0]!))).status).toBe(410);expect((await req(base(p)+'/snapshot?limit=1&cursor='+encodeURIComponent(cursors[0]!),undefined,reviewerToken)).status).toBe(410);expect((await req(base(p)+'/snapshot?limit=1&cursor='+encodeURIComponent(cursors[0]!))).status).toBe(200);expect((await req(base(p)+'/snapshot?limit=1&cursor='+encodeURIComponent(cursors[0]!))).status).toBe(410);expect((await req(base(p)+'/snapshot?limit=1')).status).toBe(200);});
