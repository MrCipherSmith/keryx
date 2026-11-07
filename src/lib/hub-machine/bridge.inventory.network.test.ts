import {expect,test} from 'bun:test';
import {readFileSync,rmSync,truncateSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {allowAll,bridgeHarness,git,newFilePatch,wait} from './bridge.test-support';
import {callRound,okReply,scriptedProvider} from '../../commands/agent.test-helpers';
import {success} from '../../hub/remote-v2/fixture.test-support';
import type {Control} from '../../remote-control/protocol';
import type {MachineBridge} from './bridge';
import {machineStateDir} from './config';
import {MachineLedger} from './ledger';
import {SNAPSHOT_QUOTA} from './checkout-lease';

const {get,post,hub,local,startBridge,machine,sessionHandle}=bridgeHarness();
type Checkout={checkoutId:string;headSha:string;clean:boolean;available:boolean;agentProfiles:Array<{readiness:string;reason:string}>};
type MachineView={connected:boolean;inventory:{inventoryVersion:number;checkouts:Checkout[]}|null};

test('a checkout changed between connections reaches Hub as a higher inventory version, and an unchanged one replays its version',async()=>{
 const state=await local();const provider=scriptedProvider([]);
 const read=()=>get<MachineView>(`/hub/v2/machines/${state.machine.machineId}`);
 let started=await startBridge(state,{},provider);const digest=started.digest;
 const restart=async(bridge:MachineBridge)=>{await bridge.stop();await wait(read,v=>!v.connected);started=await startBridge(state,{},provider);};
 const create=(view:MachineView,title:string)=>post(`/hub/v2/projects/${hub().project.id}/sessions`,{machineId:state.machine.machineId,checkoutId:'checkout',agentProfileId:'fixture',expectedInventoryVersion:view.inventory!.inventoryVersion,expectedHeadSha:view.inventory!.checkouts[0]!.headSha,capabilityDigest:digest,policyDigest:digest,title});
 /** A refused create has no side effect, so it is retried until Hub admitted the reconnected machine's inventory frame; the session then opens on the machine. */
 const created=async(view:MachineView,title:string)=>{const response=await wait(async()=>{const r=await create(view,title);return {status:r.status,body:await r.json() as {sessionId?:string}};},r=>r.status===200);
  await wait(()=>get<{state:string}>(`/hub/v2/projects/${hub().project.id}/sessions/${response.body.sessionId}`),s=>s.state==='idle');};
 const first=await wait(read,v=>v.connected&&v.inventory!==null);const version=first.inventory!.inventoryVersion;
 expect(first.inventory!.checkouts[0]).toMatchObject({headSha:git(state.cwd,'rev-parse','HEAD').stdout.trim(),clean:true,available:true,agentProfiles:[{readiness:'ready',reason:'none'}]});
 // An unchanged checkout replays the same version after a daemon restart, and a session is admitted against it.
 await restart(started.bridge);expect((await wait(read,v=>v.connected)).inventory!.inventoryVersion).toBe(version);
 await created(first,'Unchanged checkout');
 // A developer commit while serve is down: the reconnected machine publishes it as the next version, so Hub shows the new HEAD and admits a session on it.
 await started.bridge.stop();await wait(read,v=>!v.connected);
 writeFileSync(path.join(state.cwd,'committed.txt'),'a developer commit\n');expect(git(state.cwd,'add','committed.txt').exitCode).toBe(0);expect(git(state.cwd,'commit','-qm','developer commit').exitCode).toBe(0);
 const head=git(state.cwd,'rev-parse','HEAD').stdout.trim();expect(head).not.toBe(first.inventory!.checkouts[0]!.headSha);
 started=await startBridge(state,{},provider);
 const committed=await wait(read,v=>v.connected&&v.inventory!.checkouts[0]!.headSha===head);
 expect(committed.inventory!.inventoryVersion).toBeGreaterThan(version);expect(committed.inventory!.checkouts[0]).toMatchObject({clean:true,available:true,agentProfiles:[{readiness:'ready'}]});
 await created(committed,'Committed checkout');
 // A dirty checkout after a restart is shown dirty at its real HEAD and still admits a session.
 await restart(started.bridge);writeFileSync(path.join(state.cwd,'untracked.txt'),'left behind\n');await restart(started.bridge);
 const dirty=await wait(read,v=>v.connected&&v.inventory!.checkouts[0]!.clean===false);
 expect(dirty.inventory!.inventoryVersion).toBeGreaterThan(committed.inventory!.inventoryVersion);expect(dirty.inventory!.checkouts[0]).toMatchObject({headSha:head,clean:false,available:true,agentProfiles:[{readiness:'ready',reason:'none'}]});
 await created(dirty,'Dirty checkout');
 // Cleaning it again is one more change: the version still only grows.
 await started.bridge.stop();await wait(read,v=>!v.connected);rmSync(path.join(state.cwd,'untracked.txt'));await startBridge(state,{},provider);
 const clean=await wait(read,v=>v.connected&&v.inventory!.checkouts[0]!.clean);expect(clean.inventory!.inventoryVersion).toBeGreaterThan(dirty.inventory!.inventoryVersion);
 await created(clean,'Cleaned checkout');
},60000);

test('a new session on an edited checkout preserves its index and keeps full-file results local',async()=>{
 const state=await local();
 const tracked=path.join(state.cwd,'seed.txt');
 const scratch=path.join(state.cwd,'scratch.txt');
 const index=path.join(state.cwd,'.git','index');
 writeFileSync(tracked,'staged owner text\n');
 expect(git(state.cwd,'add','seed.txt').exitCode).toBe(0);
 const original='staged owner text\nunstaged owner text\n';
 writeFileSync(tracked,original);
 writeFileSync(scratch,'untracked owner text\n');
 const staged=readFileSync(index);
 const patch=JSON.stringify({patch:'diff --git a/seed.txt b/seed.txt\n--- a/seed.txt\n+++ b/seed.txt\n@@ -1,2 +1,3 @@\n staged owner text\n unstaged owner text\n+agent edit\n'});
 const provider=scriptedProvider([callRound('patch','apply_patch',patch),okReply]);
 const started=await startBridge(state,{approve:allowAll},provider);
 const read=()=>get<MachineView>(`/hub/v2/machines/${state.machine.machineId}`);
 const dirty=await wait(read,v=>v.connected&&v.inventory?.checkouts[0]?.clean===false);
 const created=await success<Control['SessionOperationReceipt']>(await post(`/hub/v2/projects/${hub().project.id}/sessions`,{
  machineId:state.machine.machineId,checkoutId:'checkout',agentProfileId:'fixture',expectedInventoryVersion:dirty.inventory!.inventoryVersion,
  expectedHeadSha:dirty.inventory!.checkouts[0]!.headSha,capabilityDigest:started.digest,policyDigest:started.digest,title:'Keep owner changes local',
 }));
 const session=sessionHandle(created.sessionId,started.catalogue.catalogueDigest);
 await wait(session.read,v=>v.state==='idle');
 expect(readFileSync(tracked,'utf8')).toBe(original);
 expect(readFileSync(scratch,'utf8')).toBe('untracked owner text\n');
 expect(readFileSync(index)).toEqual(staged);
 const lease=(await session.claim()).lease;
 const turn=await session.turn(lease,'Edit the file with existing changes');
 const run=await session.waitRun(turn.runId!,v=>v.state==='succeeded');
 expect(run.result).toBeUndefined();
 expect((await session.events(turn.runId!)).some(e=>e.kind==='log'&&e.text.includes('Result stays on this machine'))).toBe(true);
 expect(readFileSync(tracked,'utf8')).toBe(`${original}agent edit\n`);
 expect(readFileSync(scratch,'utf8')).toBe('untracked owner text\n');
 expect(readFileSync(index)).toEqual(staged);
 await started.bridge.stop();
 const ledger=new MachineLedger(path.join(machineStateDir(state.configDir,state.hubId),'control.sqlite'));
 try{expect(ledger.sessionResultsStayLocal(created.sessionId)).toBe(true);}finally{ledger.close();}
},40000);
test('while serve stays connected a developer commit reaches Hub at the bounded re-measure as the next version, and an unchanged checkout publishes nothing new',async()=>{
 const state=await local();const provider=scriptedProvider([okReply]);
 const read=()=>get<MachineView>(`/hub/v2/machines/${state.machine.machineId}`);
 const started=await startBridge(state,{inventoryIntervalMs:200},provider);
 const first=await wait(read,v=>v.connected&&v.inventory!==null);const version=first.inventory!.inventoryVersion;
 // Several re-measures of an unchanged checkout keep Hub at the version it has.
 await Bun.sleep(1000);expect((await read()).inventory!.inventoryVersion).toBe(version);
 writeFileSync(path.join(state.cwd,'committed.txt'),'a developer commit\n');expect(git(state.cwd,'add','committed.txt').exitCode).toBe(0);expect(git(state.cwd,'commit','-qm','developer commit').exitCode).toBe(0);
 const head=git(state.cwd,'rev-parse','HEAD').stdout.trim();
 const committed=await wait(read,v=>v.inventory!.checkouts[0]!.headSha===head);
 // No reconnect carried it: the same connected bridge published it once, as exactly the next version.
 expect({connected:committed.connected,version:committed.inventory!.inventoryVersion}).toEqual({connected:true,version:version+1});expect(started.bridge.connected).toBe(true);
 expect(committed.inventory!.checkouts[0]).toMatchObject({clean:true,available:true,agentProfiles:[{readiness:'ready',reason:'none'}]});
 // A session starts on the new HEAD and runs a turn there.
 const response=await wait(async()=>{const r=await post(`/hub/v2/projects/${hub().project.id}/sessions`,{machineId:state.machine.machineId,checkoutId:'checkout',agentProfileId:'fixture',expectedInventoryVersion:committed.inventory!.inventoryVersion,expectedHeadSha:head,capabilityDigest:started.digest,policyDigest:started.digest,title:'Session on the new HEAD'});return {status:r.status,body:await r.json() as {sessionId?:string}};},r=>r.status===200);
 const s=sessionHandle(response.body.sessionId!,started.catalogue.catalogueDigest);await wait(s.read,v=>v.state==='idle');
 const lease=(await s.claim()).lease;const turn=await s.turn(lease,'Work on the committed HEAD',{busyPolicy:'reject'});await s.waitRun(turn.runId!,v=>v.state==='succeeded');expect(provider.requests).toHaveLength(1);
 await Bun.sleep(600);expect((await read()).inventory!.inventoryVersion).toBe(version+1);
},40000);
test('a run that dirties its checkout republishes the inventory at its run-end boundary, before its session reports idle',async()=>{
 // The re-measure interval is at its 60 s bound, so only the run-end boundary can publish the change within this test.
 const m=await machine({inventoryIntervalMs:60000,approve:allowAll,scripts:[callRound('patch','apply_patch',newFilePatch('owned.txt','owned')),okReply,okReply]});const s=m.session;
 const read=()=>get<MachineView>(`/hub/v2/machines/${m.state.machine.machineId}`);
 const before=(await read()).inventory!;expect(before.checkouts[0]).toMatchObject({clean:true});
 const lease=(await s.claim()).lease;const turn=await s.turn(lease,'Write an owned file',{busyPolicy:'reject'});await s.waitRun(turn.runId!,v=>v.state==='succeeded');
 await wait(s.read,v=>v.state==='idle'&&v.activeRunId===null);
 const after=(await read()).inventory!;
 expect({version:after.inventoryVersion,checkout:after.checkouts[0]}).toMatchObject({version:before.inventoryVersion+1,checkout:{headSha:before.checkouts[0]!.headSha,clean:false,available:true,agentProfiles:[{readiness:'ready',reason:'none'}]}});
 // The owning session keeps working on its own dirty checkout, and an unchanged dirty checkout is not published again.
 const next=await s.turn(lease,'A next turn on the same session',{busyPolicy:'reject'});await s.waitRun(next.runId!,v=>v.state==='succeeded');
 await wait(s.read,v=>v.state==='idle'&&v.activeRunId===null);expect((await read()).inventory!.inventoryVersion).toBe(after.inventoryVersion);
},40000);

test('inventory reports the actual blocker and recovers when a still-dirty checkout shrinks', async () => {
 const state = await local();
 const file = path.join(state.cwd, 'large.bin');
 writeFileSync(file, '');
 truncateSync(file, SNAPSHOT_QUOTA.bytes + 1);
 const started = await startBridge(state, { inventoryIntervalMs: 200 }, scriptedProvider([]));
 const read = () => get<MachineView>(`/hub/v2/machines/${state.machine.machineId}`);
 const blocked = await wait(read, v => v.inventory?.checkouts[0]?.agentProfiles[0]?.reason === 'checkout-too-large');
 expect(blocked.inventory!.checkouts[0]).toMatchObject({ clean: false, available: false });
 truncateSync(file, 21 * 1024 * 1024);
 const ready = await wait(read, v => v.inventory?.checkouts[0]?.available === true);
 expect(ready.inventory!.checkouts[0]).toMatchObject({ clean: false, agentProfiles: [{ readiness: 'ready', reason: 'none' }] });
 expect(ready.inventory!.inventoryVersion).toBeGreaterThan(blocked.inventory!.inventoryVersion);
 const created = await success<Control['SessionOperationReceipt']>(await post(`/hub/v2/projects/${hub().project.id}/sessions`, {
  machineId: state.machine.machineId, checkoutId: 'checkout', agentProfileId: 'fixture',
  expectedInventoryVersion: ready.inventory!.inventoryVersion, expectedHeadSha: ready.inventory!.checkouts[0]!.headSha,
  capabilityDigest: started.digest, policyDigest: started.digest, title: 'Larger dirty checkout',
 }));
 await wait(sessionHandle(created.sessionId, started.catalogue.catalogueDigest).read, v => v.state === 'idle');
}, 40000);
