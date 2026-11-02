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
const reviewerToken = 'reviewer-' + 'r'.repeat(64);
function fixture(adapter: GitDeliveryAdapter) {
    const dir = mkdtempSync(join(tmpdir(),'hub-delivery-queue-')); roots.push(dir);
    const config = { dataDir:dir, operatorToken:token, reviewerToken, agentToken:'agent-'+'y'.repeat(64), gitDelivery:adapter };
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
    const retry = await f.request('/projects/'+p.id+'/deliveries',body,'delivery-one');
    expect(retry.status).toBe(202); expect(await retry.json()).toMatchObject({status:'pending'}); expect(calls).toBe(1);
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
    const probe=Bun.spawn(['git','--version'],{stdout:'ignore',stderr:'ignore'});
    expect(await probe.exited).toBe(0);expect(settled).toBe(false);
    release();await settling;
    const store=openHubStore(f.config.dataDir);
    try { expect(store.deliveries.list(p.id)[0]).toMatchObject({status:'completed',result:{status:'failed'}}); } finally {store.close();}
    expect((await delivery).status).toBe(200);expect(settled).toBe(true);
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
        const archiveBody={expectedVersion:job.version,reason:'Move reviewed completed history to preserved cold storage'};
        const malformed=await f.request(archivePath,{...archiveBody,unexpected:true},'fresh-malformed-archive');
        expect(malformed.status).toBe(400);expect(await malformed.json()).toMatchObject({error:{code:'invalid-arguments'}});expect(store.deliveries.get(job.id)).toEqual(job);
        const archived = await f.request(archivePath,archiveBody,'archive-job');
        expect(archived.status).toBe(200);const archivedReceipt=await archived.json();
        const archiveReplay=await f.request(archivePath,archiveBody,'archive-job');expect(archiveReplay.status).toBe(200);expect(await archiveReplay.json()).toEqual(archivedReceipt);
        expect((await f.request(archivePath,{...archiveBody,reason:'Changed request'},'archive-job')).status).toBe(409);
        expect((await f.request(archivePath,{...archiveBody,unexpected:true},'archive-job')).status).toBe(409);
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

/** Leaves a reserved job behind and restarts the Hub, as a crash during the push does. */
async function interruptedRecovery(adapter: GitDeliveryAdapter, actorId = 'human:operator') {
    const f=fixture(adapter);
    const {p,r,body}=await selected(f.request);
    const pathname='/hub/v1/projects/'+p.id+'/deliveries', key='interrupted-key';
    const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
    const replayKey=digest(JSON.stringify([actorId,'POST',pathname,key]));
    const id='delivery-'+replayKey.slice(0,32);
    const store=openHubStore(f.config.dataDir);
    store.workTransaction(()=>store.deliveries.reserve({id,replayKey,actorId,projectId:p.id,requestDigest:digest(JSON.stringify(body)),expectedLineVersion:1,revisionId:r.id,remoteUrl:body.remoteUrl,baseBranch:body.baseBranch,status:'pending'}));
    f.app.close();
    const app=createHubApplication(f.config);apps.push(app);
    const request=(path: string, payload?: unknown, idempotencyKey='key-'+Math.random(), bearer=token)=>app.fetch(new Request('http://hub.test/hub/v1'+path,{method:payload===undefined?'GET':'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json','idempotency-key':idempotencyKey},...(payload===undefined?{}:{body:JSON.stringify(payload)})}));
    return {p,body,id,key,store,request,config:f.config};
}

test('adapted remote recovery preserves inspection, no-effect replay, validation and project-fence exit', async()=>{
    let calls=0;
    const f=await interruptedRecovery(async()=>{calls++;return{status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};});
    try {
        const deliveries='/projects/'+f.p.id+'/deliveries', path='/projects/'+f.p.id+'/delivery-jobs/'+f.id;
        expect((await f.request(deliveries,f.body,f.key)).status).toBe(409);
        expect((await f.request(deliveries,f.body,'fresh-key')).status).toBe(409);
        const inspected=await f.request(path);expect(inspected.status).toBe(200);
        const job=await inspected.json();expect(job).toMatchObject({id:f.id,status:'uncertain',revisionId:f.body.revisionId,remoteUrl:f.body.remoteUrl,baseBranch:'main'});
        const body={expectedVersion:job.version,decision:'confirm-no-effect',reason:'Operator verified no original publication'};
        expect((await f.request(path+'/reconcile',body,'resolve-agent','agent-'+'y'.repeat(64))).status).toBe(403);
        expect((await f.request(path+'/reconcile',{...body,decision:'erase'},'invalid-resolution')).status).toBe(400);
        const resolved=await f.request(path+'/reconcile',body,'resolve-no-effect');expect(resolved.status).toBe(200);
        const receipt=await resolved.json();expect(receipt).toMatchObject({id:f.id,status:'completed',reconciliation:{actorId:'human:operator',decision:'confirm-no-effect',reason:body.reason}});
        const replay=await f.request(path+'/reconcile',body,'resolve-no-effect');expect(replay.status).toBe(200);expect(await replay.json()).toEqual(receipt);
        expect((await f.request(path+'/reconcile',{...body,reason:'Changed payload'},'resolve-no-effect')).status).toBe(409);
        expect((await f.request(path+'/reconcile',{...body,decision:'invalid'},'resolve-no-effect')).status).toBe(409);
        expect((await f.request(path+'/reconcile',body,'resolve-no-effect','agent-'+'y'.repeat(64))).status).toBe(403);
        expect((await f.request(path+'/reconcile',body,'fresh-resolution')).status).toBe(409);
        const original=await f.request(deliveries,f.body,f.key);expect(original.status).toBe(409);expect((await original.json()).error.code).toBe('delivery-no-effect');expect(calls).toBe(0);
        expect((await f.request(deliveries,f.body,'fresh-after-reconciliation')).status).toBe(200);expect(calls).toBe(1);
        f.config.operatorToken='rotated-'+'z'.repeat(64);
        expect((await f.request(path+'/reconcile',body,'resolve-no-effect')).status).toBe(401);expect(calls).toBe(1);
    } finally {f.store.close();}
});

test('adapted remote departed-actor recovery finalizes recorded publication once without reissuing Git', async()=>{
    let calls=0;
    const f=await interruptedRecovery(async()=>{calls++;return{status:'failed',error:'Must not rerun'};},'human:departed');
    try {
        const job=f.store.deliveries.get(f.id)!;job.status='result';job.result={status:'published',branch:'managed',commitSha:'d'.repeat(40),treeSha:'c'.repeat(40)};f.store.deliveries.save(job);
        const deliveries='/projects/'+f.p.id+'/deliveries',path='/projects/'+f.p.id+'/delivery-jobs/'+f.id;
        expect((await f.request(deliveries,f.body,'fresh-before-reconciliation')).status).toBe(409);
        const current=await(await f.request(path)).json(),body={expectedVersion:current.version,decision:'finalize-recorded-result',reason:'Current operator accepts the immutable recorded publication'};
        const response=await f.request(path+'/reconcile',body,'recorded-result');expect(response.status).toBe(200);
        const result=await response.json();expect(result).toMatchObject({id:f.id,status:'completed',result:job.result,reconciliation:{actorId:'human:operator'}});expect(calls).toBe(0);
        const replay=await f.request(path+'/reconcile',body,'recorded-result');expect(replay.status).toBe(200);expect(await replay.json()).toEqual(result);expect(calls).toBe(0);
        expect((await(await f.request(deliveries)).json()).deliveries).toHaveLength(1);
        expect((await f.request(deliveries,f.body,'fresh-after-recorded-reconciliation')).status).toBe(200);expect(calls).toBe(1);
    } finally {f.store.close();}
});

test('recovery and archive receipts roll back atomically with their job transition before commit', async()=>{
    const {createDeliveryService}=await import('./delivery-service');
    const f=await interruptedRecovery(async()=>{throw Error('No publication is allowed');});
    try {
        const actor={id:'human:operator',kind:'human' as const,role:'operator' as const};
        const failingStore:typeof f.store={...f.store,writeTransaction:action=>f.store.writeTransaction((state,repo)=>{action(state,repo);throw Error('Injected failure before commit');})};
        const service=(store:typeof f.store)=>createDeliveryService({store,dataDir:f.config.dataDir,serialized:async action=>action(),deliver:async()=>{throw Error('Git must not run');},inspect:async()=>{throw Error('Inspection must not run');}});
        const job=f.store.deliveries.get(f.id)!;
        const body={expectedVersion:job.version,decision:'confirm-no-effect',reason:'Verified no original effect'};
        const input={actor,reauthorize:async()=>actor,projectId:f.p.id,jobId:f.id,body,key:'atomic-recovery',digest:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
        const before=Object.keys(f.store.load().replays);
        await expect(service(failingStore).reconcile(input)).rejects.toThrow('Injected failure before commit');
        expect(f.store.deliveries.get(f.id)).toEqual(job);expect(Object.keys(f.store.load().replays)).toEqual(before);
        const recovered=await service(f.store).reconcile(input);expect(await service(f.store).reconcile(input)).toEqual(recovered);
        const completed=f.store.deliveries.get(f.id)!;
        const archiveBody={expectedVersion:completed.version,reason:'Keep exact cold history'};
        const archiveInput={...input,body:archiveBody,key:'atomic-archive',digest:createHash('sha256').update(JSON.stringify(archiveBody)).digest('hex')};
        const receipts=Object.keys(f.store.load().replays);
        await expect(service(failingStore).archive(archiveInput)).rejects.toThrow('Injected failure before commit');
        expect(f.store.deliveries.get(f.id)).toEqual(completed);expect(f.store.deliveries.list(f.p.id)).toHaveLength(1);expect(Object.keys(f.store.load().replays)).toEqual(receipts);
        const archived=await service(f.store).archive(archiveInput);expect(await service(f.store).archive(archiveInput)).toEqual(archived);expect(f.store.deliveries.list(f.p.id)).toHaveLength(0);
    } finally {f.store.close();}
});

test('replayed publication inspection uses its durable receipt without a second inspector call', async()=>{
    const {createDeliveryService}=await import('./delivery-service');
    const f=await interruptedRecovery(async()=>{throw Error('Publication must not run');});
    try {
        let inspections=0;
        const actor={id:'human:operator',kind:'human' as const,role:'operator' as const};
        const service=createDeliveryService({store:f.store,dataDir:f.config.dataDir,serialized:async action=>action(),deliver:async()=>{throw Error('Publication must not run');},inspect:async()=>{inspections++;return{status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};}});
        const body={expectedVersion:f.store.deliveries.get(f.id)!.version,decision:'inspect-publication',reason:'Read-only exact original marker proof'};
        const input={actor,reauthorize:async()=>actor,projectId:f.p.id,jobId:f.id,body,key:'once-inspection',digest:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
        const completed=await service.reconcile(input);expect(inspections).toBe(1);
        expect(await service.reconcile(input)).toEqual(completed);expect(inspections).toBe(1);
        expect(f.store.load().deliveries.filter(delivery=>delivery.id===f.id)).toHaveLength(1);
    } finally {f.store.close();}
});


test('reviewer may publish while recovery routes remain operator-only and publication reauthorizes after Git', async () => {
    let release!:()=>void, entered!:()=>void, calls=0;
    const gate=new Promise<void>(resolve=>release=resolve), started=new Promise<void>(resolve=>entered=resolve);
    const f=fixture(async()=>{calls++;entered();await gate;return {status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};});
    const {p,body}=await selected(f.request), path=`/projects/${p.id}`;
    const request=(suffix:string,payload:unknown,bearer:string,key:string)=>f.app.fetch(new Request('http://hub.test/hub/v1'+path+suffix,{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(payload)}));
    const pending=request('/deliveries',body,reviewerToken,'reviewer-publish');
    try {
        const first=await Promise.race([started.then(()=>null),pending.then(response=>response)]);
        expect(first).toBeNull();
        const jobs=await(await f.request(path+'/delivery-jobs')).json(); const job=jobs.jobs[0];
        const get=await f.app.fetch(new Request('http://hub.test/hub/v1'+path+'/delivery-jobs/'+job.id,{headers:{authorization:'Bearer '+reviewerToken}}));expect(get.status).toBe(403);
        expect((await request('/delivery-jobs/'+job.id+'/reconcile',{expectedVersion:job.version,decision:'confirm-no-effect',reason:'Review'},reviewerToken,'reviewer-reconcile')).status).toBe(403);
        expect((await request('/delivery-jobs/'+job.id+'/archive',{expectedVersion:job.version,reason:'Review'},reviewerToken,'reviewer-archive')).status).toBe(403);
    } finally {release();}
    expect((await pending).status).toBe(200);expect(calls).toBe(1);
    expect((await request('/deliveries',body,f.config.agentToken,'agent-publish')).status).toBe(403);
});

test('delivery list retains old active jobs ahead of more than fifty completed jobs', async()=>{
    const f=fixture(async()=>({status:'failed',error:'No publication'}));
    const {p,body}=await selected(f.request);const original=await(await f.request(`/projects/${p.id}/deliveries`,body,'list-seed')).json();
    const store=openHubStore(f.config.dataDir);
    try {
        const job=store.deliveries.get(original.id)!;
        store.workTransaction(()=>{store.deliveries.save({...job,id:'old-active',replayKey:'old-active',status:'uncertain'});for(let n=0;n<55;n++)store.deliveries.save({...job,id:'finished-'+n,replayKey:'finished-'+n});});
        const page=await(await f.request(`/projects/${p.id}/delivery-jobs`)).json();
        expect(page.jobs).toHaveLength(50);expect(page.jobs[0]).toMatchObject({id:'old-active',status:'uncertain'});
    } finally {store.close();}
});

test('reconciliation advances the exact job version and rejects stale archive CAS', async()=>{
    const f=await interruptedRecovery(async()=>{throw Error('must not publish');});
    try {
        const path=`/projects/${f.p.id}/delivery-jobs/${f.id}`, before=await(await f.request(path)).json();
        const response=await f.request(path+'/reconcile',{expectedVersion:before.version,decision:'confirm-no-effect',reason:'Verified no publication'},'version-transition');
        expect(response.status).toBe(200);const after=await response.json();expect(after.version).toBe(before.version+1);
        const stale=await f.request(path+'/archive',{expectedVersion:before.version,reason:'Stale version'},'stale-version-archive');
        expect(stale.status).toBe(409);expect((await stale.json()).error.code).toBe('version-conflict');expect(await(await f.request(path)).json()).toEqual(after);
    } finally {f.store.close();}
});

test('at most two independent publication inspections may run concurrently', async()=>{
    const {createDeliveryService}=await import('./delivery-service');
    const f=await interruptedRecovery(async()=>{throw Error('must not publish');});
    try {
        const original=f.store.deliveries.get(f.id)!;
        f.store.workTransaction(()=>{for(const id of ['inspection-two','inspection-three']) f.store.deliveries.save({...original,id,replayKey:id});});
        let release!:()=>void, entered!:()=>void, thirdEntered!:()=>void, count=0;
        const gate=new Promise<void>(resolve=>release=resolve), both=new Promise<void>(resolve=>entered=resolve), thirdStarted=new Promise<void>(resolve=>thirdEntered=resolve);
        const actor={id:'human:operator',kind:'human' as const,role:'operator' as const};
        const service=createDeliveryService({store:f.store,dataDir:f.config.dataDir,serialized:async action=>action(),deliver:async()=>{throw Error('must not publish');},inspect:async()=>{if(++count===2)entered();if(count===3)thirdEntered();await gate;return {status:'failed',error:'No publication'};}});
        const input=(id:string)=>{const job=f.store.deliveries.get(id)!;const body={expectedVersion:job.version,decision:'inspect-publication',reason:'Inspect original publication'};return {actor,reauthorize:async()=>actor,projectId:f.p.id,jobId:id,body,key:id,digest:createHash('sha256').update(JSON.stringify(body)).digest('hex')};};
        const a=service.reconcile(input(f.id)).catch(error=>error), b=service.reconcile(input('inspection-two')).catch(error=>error);
        try {
            await both;
            const third=service.reconcile(input('inspection-three')).then(()=>null,error=>error);
            const outcome=await Promise.race([third,thirdStarted.then(()=>null)]);
            expect(outcome).toMatchObject({status:503,code:'hub-busy'});expect(count).toBe(2);
        } finally {release();await Promise.all([a,b]);}
    } finally {f.store.close();}
});


test('reviewer authority is rechecked after publication and its result remains recoverable', async()=>{
    let release!:()=>void, entered!:()=>void;
    const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    const f=fixture(async()=>{entered();await gate;return {status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};});
    const {p,body}=await selected(f.request);
    const pending=f.app.fetch(new Request(`http://hub.test/hub/v1/projects/${p.id}/deliveries`,{method:'POST',headers:{authorization:'Bearer '+reviewerToken,'content-type':'application/json','idempotency-key':'reviewer-revoke'},body:JSON.stringify(body)}));
    try {const first=await Promise.race([started.then(()=>null),pending.then(response=>response)]);expect(first).toBeNull();f.config.reviewerToken='rotated-'+'q'.repeat(64);} finally {release();}
    expect((await pending).status).toBe(401);
    const jobs=await(await f.request(`/projects/${p.id}/delivery-jobs`)).json();expect(jobs.jobs[0]).toMatchObject({status:'result',result:{status:'published'}});
});
