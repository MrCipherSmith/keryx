import { createHash } from 'node:crypto';
import { openHubStore } from './store';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
async function selected(request: ReturnType<typeof fixture>['request']) {
    const p = await (await request('/projects',{name:'Delivery'})).json();
    const r = await (await request('/projects/'+p.id+'/revisions',{baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'Work',changes:[{path:'a.txt',contentBase64:'YQ=='}]})).json();
    await request('/projects/'+p.id+'/line',{revisionId:r.id,expectedVersion:0});
    return {p,r,body:{revisionId:r.id,expectedLineVersion:1,remoteUrl:'https://github.com/team/repo.git',baseBranch:'main'}};
}
test('external Git delivery never holds the global mutation queue and same-key retry never starts it twice', async () => {
    let release!: () => void, entered!: () => void, calls=0;
    const gate = new Promise<void>(resolve=>release=resolve), started = new Promise<void>(resolve=>entered=resolve);
    const f = fixture(async()=>{ calls++; entered(); await gate; return {status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)}; });
    const {p,body} = await selected(f.request);
    const pending = f.request('/projects/'+p.id+'/deliveries',body,'delivery-one');
    await started;
    // The delivery gate stays closed until the unrelated write settles: a held queue cannot finish it, a slow disk only delays it.
    const concurrent=f.request('/projects',{name:'Unrelated'});
    let guard: ReturnType<typeof setTimeout> | undefined;
    const finished=await Promise.race([concurrent.then(()=>true),new Promise<boolean>(resolve=>{guard=setTimeout(()=>resolve(false),5000);})]);
    clearTimeout(guard);
    release();
    expect((await pending).status).toBe(200);
    expect((await concurrent).status).toBe(200);
    expect(finished).toBe(true);
    expect((await f.request('/projects/'+p.id+'/deliveries',body,'delivery-one')).status).toBe(200);
    expect(calls).toBe(1);
});
test('a line change during the push keeps the published result and never overwrites the newer selection', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve=>release=resolve), started = new Promise<void>(resolve=>entered=resolve);
    const f=fixture(async()=>{entered();await gate;return{status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};});
    const {p,r,body}=await selected(f.request);
    const pending=f.request('/projects/'+p.id+'/deliveries',body,'stale-delivery');await started;
    expect((await f.request('/projects/'+p.id+'/line',{revisionId:r.id,expectedVersion:1})).status).toBe(200);
    release();
    const response=await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({status:'published',branch:'managed',commitSha:'b'.repeat(40),lineChanged:true});
    const project=await(await f.request('/projects/'+p.id)).json();
    expect(project.lineVersion).toBe(2);expect(project.lineRevisionId).toBe(r.id);
    const {deliveries}=await(await f.request('/projects/'+p.id+'/deliveries')).json();
    expect(deliveries).toHaveLength(1);expect(deliveries[0]).toMatchObject({branch:'managed',commitSha:'b'.repeat(40),lineChanged:true});
    const replay=await f.request('/projects/'+p.id+'/deliveries',body,'stale-delivery');
    expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({commitSha:'b'.repeat(40)});
});

test('restart refuses an interrupted external effect and resumes a durably recorded result without rerunning Git', async () => {
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
    // A crash after the adapter result was persisted leaves 'result'. A retry only finalizes it.
    const job=store.deliveries.get(id)!;job.status='result';job.result={status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};store.deliveries.save(job);
    const results=await Promise.all([request(),request()]);
    expect(results.map(response=>response.status)).toEqual([200,200]);expect(calls).toBe(0);
    const deliveries=store.load().deliveries.filter(delivery=>delivery.id===id);
    expect(deliveries).toHaveLength(1);
    store.close();
});
/** Leaves a reserved job behind and restarts the Hub, as a crash during the push does. */
async function interrupted(adapter: GitDeliveryAdapter, actorId = 'human:operator') {
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
    return {p,body,id,key,store,request};
}
test('an interrupted delivery is inspectable and an operator abandon clears the project fence', async () => {
    let calls=0;
    const f=await interrupted(async()=>{calls++;return{status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};});
    const deliveries='/projects/'+f.p.id+'/deliveries';
    expect((await f.request(deliveries,f.body,f.key)).status).toBe(409);
    expect((await f.request(deliveries,f.body,'fresh-key')).status).toBe(409);
    const inspected=await f.request(deliveries+'/'+f.id);
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({operationId:f.id,status:'uncertain',revisionId:f.body.revisionId,remoteUrl:f.body.remoteUrl,baseBranch:'main'});
    expect((await f.request(deliveries+'/'+f.id+'/resolve',{action:'abandon'},'resolve-1','agent-'+'y'.repeat(64))).status).toBe(403);
    expect((await f.request(deliveries+'/'+f.id+'/resolve',{action:'erase'},'resolve-0')).status).toBe(400);
    const resolved=await f.request(deliveries+'/'+f.id+'/resolve',{action:'abandon'},'resolve-2');
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({operationId:f.id,status:'completed'});
    expect((await f.request(deliveries+'/'+f.id+'/resolve',{action:'abandon'},'resolve-2')).status).toBe(200);
    expect((await f.request(deliveries+'/'+f.id+'/resolve',{action:'abandon'},'resolve-3')).status).toBe(409);
    const original=await f.request(deliveries,f.body,f.key);
    expect(original.status).toBe(409);expect((await original.json()).error.code).toBe('delivery-abandoned');
    expect(calls).toBe(0);
    expect((await f.request(deliveries,f.body,'fresh-key-2')).status).toBe(200);
    expect(calls).toBe(1);
    const events=(await(await f.request('/projects/'+f.p.id+'/events')).json()).events.map((event:{type:string})=>event.type);
    expect(events).toContain('delivery-abandoned');
    f.store.close();
});
test('an operator retry reconciles an interrupted delivery through the idempotent adapter and records it once', async () => {
    const seen: string[]=[];
    const f=await interrupted(async request=>{seen.push(request.operationId);return{status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};});
    const deliveries='/projects/'+f.p.id+'/deliveries';
    const resolved=await f.request(deliveries+'/'+f.id+'/resolve',{action:'retry'},'resolve-retry');
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({id:f.id,status:'published',commitSha:'b'.repeat(40)});
    expect(seen).toEqual([f.id]);
    const original=await f.request(deliveries,f.body,f.key);
    expect(original.status).toBe(200);expect(await original.json()).toMatchObject({id:f.id,commitSha:'b'.repeat(40)});
    expect((await(await f.request(deliveries)).json()).deliveries).toHaveLength(1);
    expect(seen).toHaveLength(1);
    f.store.close();
});
test('an operator retry finalizes a recorded result whose original actor can no longer finish it, without rerunning Git', async () => {
    let calls=0;
    const f=await interrupted(async()=>{calls++;return{status:'failed',error:'Must not rerun'};},'human:departed');
    const job=f.store.deliveries.get(f.id)!;job.status='result';job.result={status:'published',branch:'managed',commitSha:'d'.repeat(40),treeSha:'c'.repeat(40)};f.store.deliveries.save(job);
    const deliveries='/projects/'+f.p.id+'/deliveries';
    expect((await f.request(deliveries,f.body,'fresh-key')).status).toBe(409);
    const resolved=await f.request(deliveries+'/'+f.id+'/resolve',{action:'retry'},'resolve-result');
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({id:f.id,status:'published',commitSha:'d'.repeat(40),receipt:{actorId:'human:operator'}});
    expect(calls).toBe(0);
    expect((await f.request(deliveries,f.body,'fresh-key-2')).status).toBe(200);
    f.store.close();
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
