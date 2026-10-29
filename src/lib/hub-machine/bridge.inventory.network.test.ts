import {expect,test} from 'bun:test';
import {rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {bridgeHarness,git,wait} from './bridge.test-support';
import {scriptedProvider} from '../../commands/agent.test-helpers';
import type {MachineBridge} from './bridge';

const {get,post,hub,local,startBridge}=bridgeHarness();
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
