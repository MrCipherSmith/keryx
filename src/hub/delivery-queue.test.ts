import { createHash } from 'node:crypto';
import { openHubStore } from './store';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubApplication } from './server';
import type { HubApplication, GitDeliveryAdapter } from './contracts';
const roots: string[] = [], apps: HubApplication[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.close(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const token = 'operator-' + 'x'.repeat(64);
function fixture(adapter: GitDeliveryAdapter) {
    const dir = mkdtempSync(join(tmpdir(),'hub-delivery-queue-')); roots.push(dir);
    const config = { dataDir:dir, operatorToken:token, agentToken:'agent-'+'y'.repeat(64), gitDelivery:adapter };
    const app = createHubApplication(config); apps.push(app);
    const request = (path: string, body?: unknown, key = 'key-'+Math.random()) => app.fetch(new Request('http://hub.test/hub/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    return { app, config, request };
}
async function selected(request: ReturnType<typeof fixture>['request'], gitBaseSha = 'a'.repeat(40), remoteUrl = 'https://github.com/team/repo.git') {
    const p = await (await request('/projects',{name:'Delivery'})).json();
    const r = await (await request('/projects/'+p.id+'/revisions',{baseRevisionId:null,gitBaseSha,message:'Work',changes:[{path:'a.txt',contentBase64:'YQ=='}]})).json();
    await request('/projects/'+p.id+'/line',{revisionId:r.id,expectedVersion:0});
    return {p,r,body:{revisionId:r.id,expectedLineVersion:1,remoteUrl,baseBranch:'main'}};
}
test('external Git delivery never holds the global mutation queue and same-key retry never starts it twice', async () => {
    let release!: () => void, entered!: () => void, calls=0;
    const gate = new Promise<void>(resolve=>release=resolve), started = new Promise<void>(resolve=>entered=resolve);
    const f = fixture(async()=>{ calls++; entered(); await gate; return {status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)}; });
    const {p,body} = await selected(f.request);
    const pending = f.request('/projects/'+p.id+'/deliveries',body,'delivery-one');
    await started;
    // The adapter is already paused on an explicit gate. The unrelated request
    // must complete before that gate opens; abort bounds a broken serialized path.
    try {
        const concurrent = await f.app.fetch(new Request('http://hub.test/hub/v1/projects', { method:'POST', signal:AbortSignal.timeout(1000), headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'independent'}, body:JSON.stringify({name:'Unrelated'}) }));
        expect(concurrent.status).toBe(200);
    } finally { release(); }
    expect((await pending).status).toBe(200);
    expect((await f.request('/projects/'+p.id+'/deliveries',body,'delivery-one')).status).toBe(200);
    expect(calls).toBe(1);
});
test('delivery completion rechecks the current selected line without overwriting a newer selection', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve=>release=resolve), started = new Promise<void>(resolve=>entered=resolve);
    const f=fixture(async()=>{entered();await gate;return{status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};});
    const {p,r,body}=await selected(f.request);
    const pending=f.request('/projects/'+p.id+'/deliveries',body,'stale-delivery');await started;
    const newer = await (await f.request('/projects/'+p.id+'/revisions',{baseRevisionId:r.id,gitBaseSha:'a'.repeat(40),message:'New selected work',changes:[{path:'b.txt',contentBase64:'Yg=='}]})).json();
    expect((await f.request('/projects/'+p.id+'/line',{revisionId:newer.id,expectedVersion:1})).status).toBe(200);
    release();
    const response = await pending; expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({externalResult:{status:'published',branch:'managed',commitSha:'b'.repeat(40)}});
    const published = await (await f.request('/projects/'+p.id+'/deliveries')).json();
    expect(published.deliveries).toEqual([expect.objectContaining({status:'published',commitSha:'b'.repeat(40),revisionId:r.id})]);
    const project=await(await f.request('/projects/'+p.id)).json();
    expect(project.lineVersion).toBe(2);expect(project.lineRevisionId).toBe(newer.id);
    expect((await f.request('/projects/'+p.id+'/deliveries',body,'stale-delivery')).status).toBe(409);
});

test('restart exposes interrupted effects and human no-effect reconciliation releases the fence without repeating Git', async () => {
    let calls=0;
    const f=fixture(async()=>{calls++;return{status:'failed',error:'Must not rerun'};});
    const {p,r,body}=await selected(f.request);
    const pathname='/hub/v1/projects/'+p.id+'/deliveries', key='restart-key';
    const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
    const replayKey=digest(JSON.stringify(['human:operator','POST',pathname,key]));
    const id='delivery-'+replayKey.slice(0,32);
    const store=openHubStore(f.config.dataDir);
    store.workTransaction(()=>store.deliveries.reserve({id,replayKey,actorId:'human:operator',projectId:p.id,requestDigest:digest(JSON.stringify(body)),expectedLineVersion:1,revisionId:r.id,remoteUrl:body.remoteUrl,baseBranch:body.baseBranch,status:'pending'}));
    f.app.close();
    const restarted=createHubApplication(f.config);apps.push(restarted);
    const request=()=>restarted.fetch(new Request('http://hub.test'+pathname,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)}));
    expect((await request()).status).toBe(409);expect(calls).toBe(0);
    const path = `/projects/${p.id}/delivery-jobs/${id}`;
    const get = () => restarted.fetch(new Request('http://hub.test/hub/v1'+path, {headers:{authorization:'Bearer '+token}}));
    const detail = await get(); expect(detail.status).toBe(200);
    const job = await detail.json(); expect(job.version).toBe(2); expect(job).toMatchObject({id,status:'uncertain',version:2});
    const reconcile = (auth:string, expectedVersion:number) => restarted.fetch(new Request('http://hub.test/hub/v1'+path+'/reconcile',{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json','idempotency-key':'recover'},body:JSON.stringify({expectedVersion,decision:'confirm-no-effect',reason:'Operator inspected the managed branch and confirmed no publication'})}));
    expect((await reconcile(f.config.agentToken, job.version)).status).toBe(403);
    const unsafeArchive=await restarted.fetch(new Request('http://hub.test/hub/v1'+path+'/archive',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'archive-uncertain'},body:JSON.stringify({expectedVersion:job.version,reason:'Unknown effects must remain fenced'})}));expect(unsafeArchive.status).toBe(409);
    const stale = await reconcile(token, job.version + 1); expect({status:stale.status,body:await stale.json()}).toMatchObject({status:409,body:{error:{code:'version-conflict'}}});
    const resolved = await reconcile(token, job.version); expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({status:'completed',reconciliation:{actorId:'human:operator',decision:'confirm-no-effect',reason:expect.any(String)}});
    expect((await request()).status).toBe(409); expect(calls).toBe(0);
    const fresh = await restarted.fetch(new Request('http://hub.test'+pathname,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'fresh-after-reconciliation'},body:JSON.stringify(body)}));
    expect(fresh.status).toBe(200);expect(calls).toBe(1);
    store.close();
});
test('settle waits for an external Git delivery to persist its result before shutdown', async () => {
    let release!:()=>void, entered!:()=>void, settled=false;
    const gate=new Promise<void>(resolve=>release=resolve), started=new Promise<void>(resolve=>entered=resolve);
    const f=fixture(async()=>{entered();await gate;return{status:'failed',error:'No remote publication'};});
    const {p,body}=await selected(f.request);
    const delivery=f.request('/projects/'+p.id+'/deliveries',body,'drain-delivery');await started;
    const settling=f.app.settle!().then(()=>{settled=true;});
    await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);
    release();expect((await delivery).status).toBe(200);await settling;expect(settled).toBe(true);
});

test('legacy domain delivery entry refuses before any Git effect instead of bypassing durable delivery jobs', async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return {status:'failed',error:'Must not execute'}; });
    const {p,body} = await selected(f.request);
    const store = openHubStore(f.config.dataDir);
    try {
        const { hubMutate } = await import('./domain');
        await expect(hubMutate(store.load(), {id:'human:operator',kind:'human',role:'operator'}, ['projects',p.id,'deliveries'], body, f.config, async () => {calls++;return {status:'failed',error:'Bypassed'};}, 'bypass')).rejects.toMatchObject({code:'delivery-service-required'});
        expect(calls).toBe(0);
    } finally { store.close(); }
});

test('a publication survives authority expiry and current human reconciliation uses only server-recorded facts', async () => {
    let release!: () => void, entered!: () => void, calls = 0;
    const gate = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => entered = resolve);
    const result = {status:'published' as const,branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};
    const f = fixture(async () => {calls++;entered();await gate;return result;});
    const {p,body} = await selected(f.request);
    const pending = f.request('/projects/'+p.id+'/deliveries',body,'authority-expiry');await started;
    const newToken = 'rotated-operator-'+'z'.repeat(64);f.config.operatorToken = newToken;release();
    expect((await pending).status).toBe(401);
    const request = (path:string, body?:unknown) => f.app.fetch(new Request('http://hub.test/hub/v1'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+newToken,'content-type':'application/json','idempotency-key':'reconcile-result'},...(body?{body:JSON.stringify(body)}:{})}));
    const page = await (await request(`/projects/${p.id}/delivery-jobs`)).json();
    expect(page.jobs).toHaveLength(1);
    const job = page.jobs[0];expect(job.status).toBe('result');expect(job.result).toEqual(result);
    const reconcilePath = `/projects/${p.id}/delivery-jobs/${job.id}/reconcile`;
    expect((await request(reconcilePath,{expectedVersion:job.version,decision:'confirm-no-effect',reason:'Cannot hide publication'})).status).toBe(409);
    expect((await request(reconcilePath,{expectedVersion:job.version,decision:'finalize-recorded-result',reason:'Forged client result is prohibited',result:{...result,commitSha:'f'.repeat(40)}})).status).toBe(400);
    const completed = await request(reconcilePath,{expectedVersion:job.version,decision:'finalize-recorded-result',reason:'Review original immutable server publication'});
    expect(completed.status).toBe(200);expect(calls).toBe(1);
    const audit = await completed.json();expect(audit.reconciliation.actorId).toBe('human:operator');expect(audit.result).toEqual(result);
    const deliveries = await (await request(`/projects/${p.id}/deliveries`)).json();
    expect(deliveries.deliveries).toHaveLength(1);expect(deliveries.deliveries[0].commitSha).toBe(result.commitSha);
});

test('operator archives completed jobs at the audit cap without losing exact reads replay or external facts', async () => {
    let calls = 0;
    const f = fixture(async () => {calls++;return {status:'failed',error:'No publication'};});
    const {p,body} = await selected(f.request);
    const original = await (await f.request(`/projects/${p.id}/deliveries`,body,'archive-original')).json();
    const store = openHubStore(f.config.dataDir);
    try {
        const job = store.deliveries.get(original.id)!;
        store.workTransaction(() => { for (let n=0;n<9999;n++) store.deliveries.save({...job,id:'historical-'+n,replayKey:'historical-'+n}); });
        expect((await f.request(`/projects/${p.id}/deliveries`,body,'over-audit-cap')).status).toBe(413);
        const archivePath = `/projects/${p.id}/delivery-jobs/${job.id}/archive`;
        const denied = await f.app.fetch(new Request('http://hub.test/hub/v1'+archivePath,{method:'POST',headers:{authorization:'Bearer '+f.config.agentToken,'content-type':'application/json','idempotency-key':'archive-agent'},body:JSON.stringify({expectedVersion:job.version,reason:'Not an operator'})}));
        expect(denied.status).toBe(403);
        const archived = await f.request(archivePath,{expectedVersion:job.version,reason:'Move reviewed completed history to preserved cold storage'},'archive-job');
        expect(archived.status).toBe(200);
        const reread = await (await f.request(`/projects/${p.id}/delivery-jobs/${job.id}`)).json();
        expect(reread.archival.actorId).toBe('human:operator');expect(reread.status).toBe('completed');
        expect(await (await f.request(`/projects/${p.id}/deliveries`,body,'archive-original')).json()).toEqual(original);expect(calls).toBe(1);
        expect((await f.request(`/projects/${p.id}/deliveries`,body,'after-audit-archive')).status).toBe(200);expect(calls).toBe(2);
        expect(store.load().deliveries.find(delivery => delivery.id === original.id)).toEqual(original);
    } finally {store.close();}
});


test('human inspection recovers the exact interrupted publication through the public API without a second push', async () => {
    const { hubGit, deliverRevision } = await import('./git-delivery');
    const root=mkdtempSync(join(tmpdir(),'hub-delivery-recovery-'));roots.push(root);
    await hubGit(root,['init','--bare','remote.git']);await hubGit(root,['init','seed']);
    const seed=join(root,'seed'), remoteUrl=join(root,'remote.git');
    writeFileSync(join(seed,'a.txt'),'base\n');await hubGit(seed,['add','.']);await hubGit(seed,['commit','-m','Base']);
    await hubGit(seed,['branch','-M','main']);await hubGit(seed,['push',remoteUrl,'main']);
    const base=String(await hubGit(seed,['rev-parse','HEAD'])).trim();
    let calls=0;const f=fixture(async request=>{calls++;return deliverRevision(request);});
    const {p,body}=await selected(f.request,base,remoteUrl);
    const published=await(await f.request(`/projects/${p.id}/deliveries`,body,'inspect-interruption')).json();expect(published.status).toBe('published');
    const store=openHubStore(f.config.dataDir);
    try {
        // Reconstruct the crash cut after Git's effect but before Hub's result
        // persistence. Recovery below uses only HTTP, never direct row repair.
        const job=store.deliveries.get(published.id)!;job.status='pending';delete job.result;delete job.response;delete job.httpStatus;
        store.workTransaction(()=>store.deliveries.save(job));
        store.writeTransaction(state=>{delete state.replays[job.replayKey];state.deliveries=state.deliveries.filter(d=>d.id!==job.id);});
        f.app.close();const restarted=createHubApplication(f.config);apps.push(restarted);
        const path=`/hub/v1/projects/${p.id}/delivery-jobs/${job.id}`;
        const detail=await(await restarted.fetch(new Request('http://hub.test'+path,{headers:{authorization:'Bearer '+token}}))).json();
        expect(detail.status).toBe('uncertain');
        const response=await restarted.fetch(new Request('http://hub.test'+path+'/reconcile',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'inspect-publication'},body:JSON.stringify({expectedVersion:detail.version,decision:'inspect-publication',reason:'Verify original remote marker before recording recovered publication'})}));
        expect(response.status).toBe(200);const recovered=await response.json();
        expect(recovered.result).toEqual({status:'published',branch:published.branch,commitSha:published.commitSha,treeSha:published.treeSha});
        expect(recovered.reconciliation.decision).toBe('inspect-publication');expect(calls).toBe(1);
        expect(String(await hubGit(root,['ls-remote',remoteUrl,`refs/heads/${published.branch}`]))).toStartWith(published.commitSha);
    } finally {store.close();}
});

test('restart finalizes an exact server-recorded result on original-key retries without invoking Git', async () => {
    let calls=0;const f=fixture(async()=>{calls++;return {status:'failed',error:'Must not rerun publication'};});
    const {p,r,body}=await selected(f.request), key='recorded-before-restart';
    const pathname=`/hub/v1/projects/${p.id}/deliveries`, digest=(value:string)=>createHash('sha256').update(value).digest('hex');
    const replayKey=digest(JSON.stringify(['human:operator','POST',pathname,key])), id='delivery-'+replayKey.slice(0,32);
    const store=openHubStore(f.config.dataDir);
    try {
        store.workTransaction(()=>store.deliveries.reserve({id,replayKey,actorId:'human:operator',projectId:p.id,requestDigest:digest(JSON.stringify(body)),expectedLineVersion:1,revisionId:r.id,remoteUrl:body.remoteUrl,baseBranch:body.baseBranch,status:'result',result:{status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)}}));
        f.app.close();const restarted=createHubApplication(f.config);apps.push(restarted);
        const retry=()=>restarted.fetch(new Request('http://hub.test'+pathname,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)}));
        const responses=await Promise.all([retry(),retry()]);expect(responses.every(response=>response.status===200||response.status===202)).toBe(true);
        expect((await retry()).status).toBe(200);expect(calls).toBe(0);
        expect(store.load().deliveries.filter(delivery=>delivery.id===id)).toHaveLength(1);
    } finally {store.close();}
});

test('a throwing publication adapter leaves an uncertain fence instead of inventing definitive failure', async () => {
    let externalEffects=0;
    const f=fixture(async()=>{externalEffects++;throw Error('Publication may have succeeded before the reply was lost');});
    const {p,body}=await selected(f.request), path=`/projects/${p.id}/deliveries`;
    const response=await f.request(path,body,'lost-publication-reply');
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:{code:'delivery-uncertain'}});
    expect((await f.request(path,body,'lost-publication-reply')).status).toBe(409);
    expect((await f.request(path,body,'must-not-republish')).status).toBe(409);
    expect(externalEffects).toBe(1);
    const jobs=await(await f.request(`/projects/${p.id}/delivery-jobs`)).json();expect(jobs.jobs[0].status).toBe('uncertain');
    const deliveries=await(await f.request(path)).json();expect(deliveries.deliveries).toEqual([]);
});
