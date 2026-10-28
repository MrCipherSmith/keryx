import {afterEach,expect,setDefaultTimeout} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fixture,success,operatorToken,reviewerToken,agentToken,type Fixture} from '../../hub/remote-v2/fixture.test-support';
import {startHub} from '../../hub/server';
import {MachineBridge,type MachineBridgeOptions} from './bridge';
import {hubIdentity,machineStateDir,saveEnrollment,loadEnrollment,allowCheckout} from './config';
import {MachineLedger} from './ledger';
import {enrollMachine} from './client';
import {canonicalDigest,type Control,type FrameOf} from '../../remote-control/protocol';
import {createNativeSessionRuntime,type NativeRuntimeOptions,type NativeSessionRuntime} from '../../session/native-runtime';
import {createMachineCommandCatalogue} from './production';
import {scriptedProvider,type Script} from '../../commands/agent.test-helpers';
import {startMachineOwnerControl} from './startup';
import {requestLocalOwnerControl,type LocalOwnerValue} from './local-control';
import type {NativeCommandContribution} from '../../session/commands/handlers';

/** Real Hub v2 routes, a real MachineBridge over real sockets, real native runtimes and real temp Git checkouts; nothing under test is mocked. */
export type RunEvent=FrameOf<'run-event'>['payload'];
export type ApprovalRequest=Extract<RunEvent,{kind:'approval-request'}>;
export type Inspection=Extract<LocalOwnerValue,{kind:'inspection'}>;
type Provider=ReturnType<typeof scriptedProvider>;
/** Git without the developer's global/system config or template hooks. */
const gitEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
export const git=(cwd:string,...args:string[])=>{const out=Bun.spawnSync(['git','-C',cwd,'-c','user.name=Fixture','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{env:gitEnv});return {exitCode:out.exitCode,stdout:out.stdout.toString()};};
/** A new-file unified diff for apply_patch. */
export const newFilePatch=(file:string,line:string)=>JSON.stringify({patch:`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`});
export const allowAll:NonNullable<NativeRuntimeOptions['approve']>=async(_name,_input,meta)=>({approved:true,...(meta?{fingerprint:meta.fingerprint}:{})});
export const localCandidate:Control['RoutingAvailability']['candidates'][number]={candidateId:'scripted:m',providerId:'scripted',modelId:'m',reasoningEfforts:['none','low'],available:true,reason:'none',privacyClass:'local',costClass:'local'};
const ledgerPath=(configDir:string,hubId:string)=>path.join(machineStateDir(configDir,hubId),'control.sqlite');
// Real processes and sockets under a loaded parallel run can take seconds to settle. Every wait expects success, so the budget is time-based and generous; a passing wait returns on the first matching read.
export async function wait<T>(read:()=>Promise<T>,done:(value:T)=>boolean,attempts=150):Promise<T>{const deadline=Date.now()+Math.max(attempts*10,10_000);for(;;){const value=await read();if(done(value))return value;if(Date.now()>=deadline)throw new Error('bridge observation timeout');await Bun.sleep(10);}}
/** Blocks every model round of `provider` until the returned release is called: the test decides when a running turn may finish. */
export function gated(provider:{provider:Provider['provider']}):()=>void{let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const original=provider.provider.stream;provider.provider.stream=(request,options)=>(async function*(){await gate;yield* original(request,options);})();return release;}

export interface MachineOptions{
 scripts?:Script[];provider?:Provider;approve?:NativeRuntimeOptions['approve'];contributions?:NativeCommandContribution[];spawner?:NativeRuntimeOptions['spawner'];
 candidates?:Control['RoutingAvailability']['candidates'];runLogByteLimit?:number;decisionTtlMs?:number;base?:string;checkouts?:number;maxConcurrentRuns?:number;bridge?:Partial<Pick<MachineBridgeOptions,'runLogByteLimit'>>;
 /** Extra committed content of every checkout, written before its fixture commit (for example a .gitignore or a tracked symlink). */
 seed?:(cwd:string)=>void;
}
/** One test file's harness: registers cleanup and the default time budget, and owns every Hub, bridge, owner socket and temp root it creates. */
export function bridgeHarness(){
 let f:Fixture|undefined;let replacement:ReturnType<typeof startHub>|undefined;const roots:string[]=[];const bridges:MachineBridge[]=[];const owners:Array<{stop():Promise<void>}>=[];const cleanups:Array<()=>Promise<void>|void>=[];
 /** Every bridge notice of a test, shutdown included. The generic fallback means an unclassified failure source, so it fails the test. */
 const notices:string[]=[];const recordNotice=(code:string)=>{notices.push(code);};
 setDefaultTimeout(30_000);
 afterEach(async()=>{for(const c of cleanups.splice(0).reverse())await c();for(const o of owners.splice(0))await o.stop();for(const b of bridges.splice(0))await b.stop();await replacement?.stop(true);replacement=undefined;await f?.close();f=undefined;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
  expect(notices.splice(0).filter(code=>code==='machine-state-unavailable')).toEqual([]);});
 const hub=()=>{if(!f)throw new Error('hub fixture missing');return f;};
 const get=async<T>(url:string)=>success<T>(await hub().call(url,{cookie:hub().cookie}));
 const post=(url:string,body:unknown,key?:string,method='POST')=>hub().call(url,{method,cookie:hub().cookie,body,...(key?{key}:{})});
 /** Enrolls one machine with `checkouts` clean committed checkouts, each mapped to the fixture profile. */
 async function local(options:{base?:string;checkouts?:number;maxConcurrentRuns?:number;seed?:(cwd:string)=>void}={}){
  f=await fixture();const root=mkdtempSync(path.join(options.base??tmpdir(),'machine-bridge-'));roots.push(root);const configDir=path.join(root,'config');const hubId=hubIdentity(f.origin);
  const ids=Array.from({length:options.checkouts??1},(_,n)=>n===0?'checkout':`checkout-${n+1}`);const cwds=ids.map(id=>path.join(root,id));
  for(const cwd of cwds){expect(Bun.spawnSync(['git','init','-q',cwd],{env:gitEnv}).exitCode).toBe(0);writeFileSync(path.join(cwd,'seed.txt'),'seed');options.seed?.(cwd);git(cwd,'add','.');expect(git(cwd,'commit','-qm','fixture').exitCode).toBe(0);}
  const ledger=new MachineLedger(ledgerPath(configDir,hubId));
  const pair=await success<{code:string}>(await f.call('/hub/v2/machines/pairings',{method:'POST',cookie:f.cookie,body:{displayName:'Native machine',projectIds:[f.project.id]}}));const machine=await enrollMachine(f.origin,{code:pair.code,agentVersion:'test-native',ledgerId:ledger.ledgerId});ledger.close();saveEnrollment(configDir,{hubUrl:f.origin,...machine});
  ids.forEach((checkoutId,n)=>allowCheckout(configDir,{projectId:f!.project.id,checkoutId,cwd:cwds[n]!,profileId:'fixture'}));
  const policy:Control['LocalMachinePolicy']={version:2,hubId,enabled:true,maxConcurrentRuns:options.maxConcurrentRuns??2,checkouts:ids.map((checkoutId,n)=>({projectId:f!.project.id,checkoutId,localBindingId:`binding-${n}`,path:cwds[n]!,profileIds:['fixture']})),allowAdHocSessions:true,allowedCandidateIds:['scripted:m'],profiles:[{profileId:'fixture',allowAdHocTurns:true,consentVersion:1,allowedCandidateIds:['scripted:m']}]};
  return {root,cwd:cwds[0]!,cwds,checkoutIds:ids,configDir,hubId,machine,policy};
 }
 type Local=Awaited<ReturnType<typeof local>>;
 /** A started MachineBridge on `state` whose native runtimes use a deterministic provider; runtimes are recorded per created session. */
 async function startBridge(state:Local,options:MachineOptions,provider:Provider){
  const digest=canonicalDigest(state.policy);const routing:Control['RoutingAvailability']={version:1,policyDigest:digest,capabilityDigest:digest,profileIds:['local'],candidates:options.candidates??[localCandidate]};const runtimes:NativeSessionRuntime[]=[];
  const catalogue=createMachineCommandCatalogue(digest,options.contributions??[]);
  const bridge=new MachineBridge({...(options.runLogByteLimit!==undefined?{runLogByteLimit:options.runLogByteLimit}:{}),...(options.decisionTtlMs!==undefined?{decisionTtlMs:options.decisionTtlMs}:{}),onNotice:recordNotice,configDir:state.configDir,enrollment:loadEnrollment(state.configDir)!,policy:state.policy,resolveProfile:async mapping=>({ok:true,value:{profileId:'fixture',policyDigest:digest,capabilityDigest:digest,catalogue,routing,createRuntime:async()=>{const runtime=createNativeSessionRuntime({cwd:mapping.cwd,provider:provider.provider,providerId:'scripted',modelId:'m',availability:routing,...(options.approve?{approve:options.approve}:{}),...(options.spawner?{spawner:options.spawner}:{}),...(options.contributions?{commandContributions:options.contributions}:{})});runtimes.push(runtime);return {ok:true,value:runtime};}}})});
  bridges.push(bridge);await bridge.start();return {bridge,digest,routing,runtimes,catalogue};
 }
 /** Machine + bridge + one idle native session per checkout. */
 async function machine(options:MachineOptions={}){
  const state=await local(options);const provider=options.provider??scriptedProvider(options.scripts??[]);const started=await startBridge(state,options,provider);
  const inventory=await wait(()=>get<{inventory:{inventoryVersion:number;checkouts:Array<{checkoutId:string;headSha:string}>}|null}>(`/hub/v2/machines/${state.machine.machineId}`),v=>v.inventory!==null&&v.inventory.checkouts.length===state.checkoutIds.length);
  const sessions=[];for(const checkoutId of state.checkoutIds){const head=inventory.inventory!.checkouts.find(c=>c.checkoutId===checkoutId)!.headSha;
   const created=await success<Control['SessionOperationReceipt']>(await post(`/hub/v2/projects/${hub().project.id}/sessions`,{machineId:state.machine.machineId,checkoutId,agentProfileId:'fixture',expectedInventoryVersion:inventory.inventory!.inventoryVersion,expectedHeadSha:head,capabilityDigest:started.digest,policyDigest:started.digest,title:`Native ${checkoutId}`}));
   const s=sessionHandle(created.sessionId,started.catalogue.catalogueDigest);await wait(s.read,v=>v.state==='idle');sessions.push(s);}
  return {state,provider,...started,sessions,session:sessions[0]!,restartBridge:async()=>startBridge(state,options,provider)};
 }
 /** Hub HTTP operations against one session. Each mutation re-reads the current versions unless the caller pins them. */
 function sessionHandle(sessionId:string,catalogueDigest:string){
  const projectId=hub().project.id;const sessionPath=`/hub/v2/projects/${projectId}/sessions/${sessionId}`;
  const read=()=>get<Control['SessionRecord']>(sessionPath);
  const binding=(lease:Control['ControllerLease'])=>({controllerLeaseId:lease.controllerLeaseId,expectedControllerVersion:lease.version});
  const claim=async(seconds=60,mode:'claim'|'takeover'='claim',extra:Record<string,unknown>={})=>{const current=await read();const receipt=await success<Control['ControllerReceipt']>(await post(`${sessionPath}/controller/claim`,{expectedSessionVersion:current.version,expectedControllerVersion:current.controller?.version??0,requestedLeaseSeconds:seconds,mode,...extra}));await wait(read,v=>v.controller?.controllerLeaseId===receipt.lease.controllerLeaseId&&v.controller.state==='held');return receipt;};
  const message=async(lease:Control['ControllerLease'],text:string,options:{key?:string;busyPolicy?:'enqueue'|'reject';association?:Control['FlowAssociation'];current?:Control['SessionRecord']}={})=>{const current=options.current??await read();return post(`${sessionPath}/messages`,{expectedSessionVersion:current.version,expectedConfigVersion:current.config.configVersion,controller:binding(lease),text,interpretation:'literal-message',busyPolicy:options.busyPolicy??'enqueue',association:options.association??{mode:'ad-hoc',profileConsentVersion:1}},options.key);};
  const turn=async(lease:Control['ControllerLease'],text:string,options:Parameters<typeof message>[2]={})=>success<Control['TurnReceipt']>(await message(lease,text,options));
  const invoke=async(lease:Control['ControllerLease'],commandName:string,args:Record<string,unknown>={},options:{association?:Control['FlowAssociation'];busyPolicy?:'reject'|'queue-at-idle';current?:Control['SessionRecord']}={})=>{const current=options.current??await read();return post(`${sessionPath}/commands/invoke`,{expectedSessionVersion:current.version,expectedConfigVersion:current.config.configVersion,controller:binding(lease),catalogueDigest,commandName,arguments:args,busyPolicy:options.busyPolicy??'reject',...(options.association?{association:options.association}:{})});};
  const operation=<T=Record<string,unknown>>(operationId:string)=>get<T>(`${sessionPath}/operations/${operationId}`);
  const queue=()=>get<Control['QueuePage']>(`${sessionPath}/queue`);
  const run=(runId:string)=>get<{state:string;version:number;result?:Control['ResultReceipt'];lastLocalSeq?:number;partial?:boolean;association?:Control['FlowAssociation'];pinDrift?:string[]}>(`/hub/v2/projects/${projectId}/runs/${runId}`);
  const events=async(runId:string,after=0)=>(await get<{events:RunEvent[]}>(`/hub/v2/projects/${projectId}/runs/${runId}/events${after?`?after=${after}`:''}`)).events;
  const approval=async(runId:string)=>(await wait(()=>events(runId),v=>v.some(e=>e.kind==='approval-request'))).find((e):e is ApprovalRequest=>e.kind==='approval-request')!;
  const answer=async(lease:Control['ControllerLease'],runId:string,question:ApprovalRequest,decision:'allow-once'|'deny',pins:{actionFingerprint?:string;policyDigest?:string;key?:string}={})=>{const r=await run(runId);const current=await read();return post(`/hub/v2/projects/${projectId}/runs/${runId}/approvals/${question.approvalId}/answer`,{expectedRunVersion:r.version,expectedSessionVersion:current.version,controller:binding(lease),actionFingerprint:pins.actionFingerprint??question.actionFingerprint,policyDigest:pins.policyDigest??question.policyDigest,decision},pins.key);};
  const cancel=async(lease:Control['ControllerLease'],runId:string,reason='Stop this run')=>{const r=await run(runId);const current=await read();return post(`/hub/v2/projects/${projectId}/runs/${runId}/cancel`,{expectedRunVersion:r.version,expectedSessionVersion:current.version,controller:binding(lease),reason});};
  const waitRun=(runId:string,done:(v:Awaited<ReturnType<typeof run>>)=>boolean,attempts?:number)=>wait(()=>run(runId),done,attempts);
  return {sessionId,projectId,path:sessionPath,read,binding,claim,message,turn,invoke,operation,queue,run,events,approval,answer,cancel,waitRun,post:(suffix:string,body:unknown,key?:string,method?:string)=>post(`${sessionPath}${suffix}`,body,key,method)};
 }
 /** The real owner-only Unix socket for local recovery. */
 async function owner(state:Local,bridge:MachineBridge){
  const control=await startMachineOwnerControl(state.configDir,new Map([[state.hubId,bridge]]));owners.push(control);let n=0;
  const ask=(input:unknown)=>requestLocalOwnerControl(state.configDir,input);
  const inspect=async(sessionId?:string):Promise<Inspection>=>{const result=await ask({v:1,requestId:`owner-inspect-${++n}`,operation:'inspect',hubId:state.hubId,...(sessionId?{sessionId}:{})});if(!result.ok||result.value.kind!=='inspection')throw new Error(result.ok?'unexpected owner value':result.error.code);return result.value;};
  const target=(view:Inspection,index=0)=>{const entry=view.sessions[index]!;return {sessionId:entry.session.sessionId,nativeSessionId:entry.nativeSessionId,controllerLeaseId:entry.session.controller!.controllerLeaseId,controllerVersion:entry.session.controller!.version,expectedSessionVersion:entry.session.version,expectedHistoryVersion:entry.session.historyVersion,expectedWorkspaceBaseline:entry.session.workspaceBaseline};};
  const release=(requestId:string,pins:ReturnType<typeof target>)=>ask({v:1,requestId,operation:'release-expired-idle',hubId:state.hubId,target:pins});
  return {ask,inspect,target,release,code:(result:Awaited<ReturnType<typeof ask>>)=>result.ok?'applied':result.error.code};
 }
 /** Stops the current Hub process and starts a replacement on the same port and data directory. */
 async function restartHub(between?:()=>Promise<void>|void){const current=hub();const port=Number(new URL(current.origin).port);if(replacement){await replacement.stop(true);replacement=undefined;}else await current.server.stop(true);await between?.();replacement=startHub({dataDir:current.dataDir,host:'127.0.0.1',port,operatorToken,reviewerToken,agentToken});}
 async function stopHub(){const current=hub();if(replacement){await replacement.stop(true);replacement=undefined;}else await current.server.stop(true);}
 const ledger=(state:Local)=>new MachineLedger(ledgerPath(state.configDir,state.hubId));
 /** Read-only views of the machine's own durable stores. */
 const sqlite=async<T>(file:string,query:(db:import('bun:sqlite').Database)=>T):Promise<T>=>{const {Database}=await import('bun:sqlite');const db=new Database(file,{readonly:true});try{return query(db);}finally{db.close();}};
 const poolRows=(state:Local)=>sqlite(path.join(state.configDir,'hub-machines','executions.sqlite'),db=>db.query<{n:number},[]>('SELECT count(*) n FROM execution_pool').get()!.n);
 const hubState=<T>(query:(db:import('bun:sqlite').Database)=>T)=>sqlite(path.join(hub().dataDir,'hub.sqlite'),query);
 const hubCommands=()=>hubState(db=>db.query<{body:string},[]>('SELECT body FROM remote_command').all().map(row=>JSON.parse(row.body) as {envelope:{kind:string;runId?:string;commandId:string;target?:{sessionId?:string}};status?:string;receipt?:{status:string;errorCode:string|null}}));
 return {hub,get,post,local,machine,startBridge,sessionHandle,owner,restartHub,stopHub,ledger,ledgerFile:(state:Local)=>ledgerPath(state.configDir,state.hubId),sqlite,poolRows,hubState,hubCommands,notices,onCleanup:(c:()=>Promise<void>|void)=>{cleanups.push(c);},digest:canonicalDigest};
}
export type BridgeHarness=ReturnType<typeof bridgeHarness>;
export type Machine=Awaited<ReturnType<BridgeHarness['machine']>>;
export type Session=Machine['session'];
