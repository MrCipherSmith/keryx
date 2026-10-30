import {expect,test} from 'bun:test';
import {rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {allowAll,bridgeHarness,git,newFilePatch,wait} from './bridge.test-support';
import {callRound,okReply,scriptedProvider} from '../../commands/agent.test-helpers';
import type {MachineBridge} from './bridge';

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
 // A dirty checkout after a restart is shown dirty at its real HEAD, still a usable checkout: new work is refused as dirty, never as setup-required.
 await restart(started.bridge);writeFileSync(path.join(state.cwd,'untracked.txt'),'left behind\n');await restart(started.bridge);
 const dirty=await wait(read,v=>v.connected&&v.inventory!.checkouts[0]!.clean===false);
 expect(dirty.inventory!.inventoryVersion).toBeGreaterThan(committed.inventory!.inventoryVersion);expect(dirty.inventory!.checkouts[0]).toMatchObject({headSha:head,clean:false,available:true,agentProfiles:[{readiness:'ready',reason:'none'}]});
 const refused=await wait(async()=>{const response=await create(dirty,'Dirty checkout');return {status:response.status,body:await response.json() as {error?:{code?:string}}};},r=>r.body.error?.code!=='setup-required');
 expect(refused).toMatchObject({status:409,body:{error:{code:'checkout-dirty'}}});
 // Cleaning it again is one more change: the version still only grows.
 await started.bridge.stop();await wait(read,v=>!v.connected);rmSync(path.join(state.cwd,'untracked.txt'));await startBridge(state,{},provider);
 const clean=await wait(read,v=>v.connected&&v.inventory!.checkouts[0]!.clean);expect(clean.inventory!.inventoryVersion).toBeGreaterThan(dirty.inventory!.inventoryVersion);
 await created(clean,'Cleaned checkout');
},60000);
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
