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
    let concurrentFinished=false;
    const concurrent=f.request('/projects',{name:'Unrelated'}).then(response=>{concurrentFinished=true;return response;});
    await new Promise(resolve=>setTimeout(resolve,30));
    const wasBlocked=!concurrentFinished;
    release();
    expect((await pending).status).toBe(200);
    expect((await concurrent).status).toBe(200);
    expect(wasBlocked).toBe(false);
    expect((await f.request('/projects/'+p.id+'/deliveries',body,'delivery-one')).status).toBe(200);
    expect(calls).toBe(1);
});
test('delivery completion rechecks the current selected line without overwriting a newer selection', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve=>release=resolve), started = new Promise<void>(resolve=>entered=resolve);
    const f=fixture(async()=>{entered();await gate;return{status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};});
    const {p,r,body}=await selected(f.request);
    const pending=f.request('/projects/'+p.id+'/deliveries',body,'stale-delivery');await started;
    const store = (await import('./store')).openHubStore(f.config.dataDir);
    store.writeTransaction(state=>{const project=state.projects.find(project=>project.id===p.id)!;project.lineVersion++;project.lineRevisionId=null;});store.close();
    release();
    expect((await pending).status).toBe(409);
    const project=await(await f.request('/projects/'+p.id)).json();
    expect(project.lineVersion).toBe(2);expect(project.lineRevisionId).toBeNull();
    expect((await f.request('/projects/'+p.id+'/deliveries',body,'stale-delivery')).status).toBe(409);
    void r;
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
    // Operator/provider reconciliation supplies the known immutable result. A retry only finalizes it.
    const job=store.deliveries.get(id)!;job.status='result';job.result={status:'published',branch:'managed',commitSha:'b'.repeat(40),treeSha:'c'.repeat(40)};store.deliveries.save(job);
    const results=await Promise.all([request(),request()]);
    expect(results.map(response=>response.status)).toEqual([200,200]);expect(calls).toBe(0);
    const deliveries=store.load().deliveries.filter(delivery=>delivery.id===id);
    expect(deliveries).toHaveLength(1);
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
