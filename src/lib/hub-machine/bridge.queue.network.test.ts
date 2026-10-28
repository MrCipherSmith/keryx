import {expect,test} from 'bun:test';
import path from 'node:path';
import {bridgeHarness,wait,newFilePatch,type Session} from './bridge.test-support';
import {okReply,callRound} from '../../commands/agent.test-helpers';
import {success} from '../../hub/remote-v2/fixture.test-support';
import type {Control} from '../../remote-control/protocol';
import type {NativeCommandContribution} from '../../session/commands/handlers';

const h=bridgeHarness();
/** Retries a session mutation that re-reads its pins while Hub still applies the previous accepted operation or a version moved under it. */
async function settled(attempt:()=>Promise<Response>){let response!:Response;await wait(async()=>{response=await attempt();if(response.status!==409)return true;const body=await response.clone().json() as {error:{code:string;message:string}};return body.error.code!=='stale-version'&&!body.error.message.includes('waiting for machine application');},v=>v);return response;}
/** A workspace command that may wait for the idle boundary; it records each actual execution. */
function queuedWorkspaceCommand(log:string[]):NativeCommandContribution{return {entry:{commandName:'risk',summary:'Queued workspace fixture',handlerId:'native.fixture.risk',inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},resultSchema:{type:'string',maxLength:32768},mutationClass:'workspace',states:['idle'],busyPolicy:'queue-at-idle',confirmation:'none',availability:'available',reason:'explicit-test-fixture'},async execute(){log.push('command');return {actual:true};}};}
async function reauthorize(s:Session,lease:Control['ControllerLease'],item:Control['QueueItem']){return settled(async()=>{const current=await s.read();const page=await s.queue();const now=page.items.find(i=>i.queueItemId===item.queueItemId)!;return s.post(`/queue/${item.queueItemId}/reauthorize`,{expectedSessionVersion:current.version,expectedQueueVersion:page.queueVersion,expectedItemVersion:now.version,queueItemId:item.queueItemId,originalOperationId:item.operationId,expectedConfigVersion:current.config.configVersion,controller:s.binding(lease),association:{mode:'ad-hoc',profileConsentVersion:1}});});}

const states=async(s:Session)=>(await s.queue()).items.filter(i=>i.state!=='removed').sort((a,b)=>a.position-b.position).map(i=>[i.kind,i.state]);
test('R2.1 a mixed queue across a controller generation change keeps FIFO, suspends every item and applies each exactly once after fresh grants',async()=>{
 const log:string[]=[];
 const m=await h.machine({contributions:[queuedWorkspaceCommand(log)],scripts:[callRound('patch-waiting','apply_patch',newFilePatch('held.txt','held')),okReply,okReply]});const s=m.session;
 const first=(await s.claim()).lease;const turn=await s.turn(first,'Busy behind an approval');await s.approval(turn.runId!);
 // Behind the busy run: a literal message, a queued configuration and a queued workspace command, then a replacement of the message.
 const message=await s.turn(first,'Queued literal message');expect(message.status).toBe('queued');
 expect((await success<Control['ConfigReceipt']>(await settled(async()=>{const c=await s.read();return s.post('/config',{expectedSessionVersion:c.version,expectedConfigVersion:1,controller:s.binding(first),baselineCandidateId:'scripted:m',reasoningEffort:'low',routing:c.config.routing,busyPolicy:'queue-at-idle'},undefined,'PUT');}))).status).toBe('queued');
 expect((await success<Control['CommandOutcome']>(await settled(()=>s.invoke(first,'risk',{},{busyPolicy:'queue-at-idle',association:{mode:'ad-hoc',profileConsentVersion:1}})))).status).toBe('queued');
 const original=(await wait(s.queue,v=>v.items.length>=3)).items.find(i=>i.operationId===message.operationId)!;
 await success(await settled(async()=>{const c=await s.read();const p=await s.queue();const it=p.items.find(i=>i.queueItemId===original.queueItemId)!;return s.post(`/queue/${original.queueItemId}`,{expectedSessionVersion:c.version,controller:s.binding(first),expectedQueueVersion:p.queueVersion,expectedItemVersion:it.version,text:'Replacement literal message',queueItemId:original.queueItemId},undefined,'PATCH');}));
 expect(await wait(()=>states(s),v=>v.length===3&&v.every(([,state])=>state==='queued'))).toEqual([['message','queued'],['config','queued'],['command','queued']]);
 // The generation changes: an applied release and a takeover. The waiting approval is denied and the paused run is cancelled by the new holder.
 const released=await success<Control['ControllerReceipt']>(await settled(async()=>{const c=await s.read();return s.post('/controller/release',{expectedSessionVersion:c.version,controller:s.binding(first)});}));await wait(s.read,v=>v.controller?.state==='released');
 const second=(await s.claim(60,'takeover',{previousReleaseReceiptId:released.receiptId})).lease;expect(second.controllerLeaseId).not.toBe(first.controllerLeaseId);
 await wait(s.read,v=>v.state==='paused');await success(await s.cancel(second,turn.runId!));await s.waitRun(turn.runId!,v=>v.state==='cancelled');
 expect(await wait(()=>states(s),v=>v.every(([,state])=>state==='suspended'))).toEqual([['message','suspended'],['config','suspended'],['command','suspended']]);
 expect(m.provider.requests).toHaveLength(1);expect(log).toEqual([]);expect((await s.read()).config.configVersion).toBe(1);expect(await Bun.file(path.join(m.state.cwd,'held.txt')).exists()).toBe(false);
 // Fresh grants in reverse order: the suspended head still fences every later item.
 const suspended=(await s.queue()).items.filter(i=>i.state==='suspended').sort((a,b)=>a.position-b.position);
 for(const item of [suspended[2]!,suspended[1]!])expect((await reauthorize(s,second,item)).status).toBe(200);
 await Bun.sleep(500);expect(await states(s)).toEqual([['message','suspended'],['config','queued'],['command','queued']]);expect(m.provider.requests).toHaveLength(1);expect(log).toEqual([]);expect((await s.read()).config.configVersion).toBe(1);
 expect((await reauthorize(s,second,suspended[0]!)).status).toBe(200);
 // The message turn runs once with the replacement text, then the configuration applies once; the command pinned to the old configuration is suspended again.
 await wait(()=>states(s),v=>v[1]?.[1]==='applied'&&v[2]?.[1]==='suspended');const config=await s.read();expect(config.config.configVersion).toBe(2);expect(config.config.reasoningEffort).toBe('low');
 expect(m.provider.requests).toHaveLength(2);expect(JSON.stringify(m.provider.requests[1])).toContain('Replacement literal message');expect(JSON.stringify(m.provider.requests[1])).not.toContain('Queued literal message');expect(log).toEqual([]);
 const pinned=(await s.queue()).items.find(i=>i.kind==='command'&&i.state==='suspended')!;expect((await reauthorize(s,second,pinned)).status).toBe(200);
 await wait(async()=>log.length,v=>v===1);const admitted=await wait(async()=>(await s.queue()).items.find(i=>i.kind==='command'&&i.state==='admitted'),v=>v!==undefined);expect((await wait(()=>s.operation<Control['CommandOutcome']>(admitted!.operationId),v=>v.status==='applied')).result).toBe('{"actual":true}');await Bun.sleep(300);
 expect(log).toEqual(['command']);expect(m.provider.requests).toHaveLength(2);expect((await s.read()).config.configVersion).toBe(2);
 expect((await h.hubCommands()).filter(c=>c.receipt?.errorCode==='recovery-required')).toEqual([]);
},60000);
import {localCandidate} from './bridge.test-support';
const metered:Control['RoutingAvailability']['candidates'][number]={candidateId:'metered',providerId:'scripted',modelId:'metered',reasoningEfforts:['none'],available:true,reason:'none',privacyClass:'approved-egress',costClass:'metered'};
async function card(s:Session,lease:Control['ControllerLease'],busyPolicy:'reject'|'queue-at-idle'='reject'){
 const pending=await success<Control['ConfigReceipt']>(await settled(async()=>{const c=await s.read();return s.post('/config',{expectedSessionVersion:c.version,expectedConfigVersion:c.config.configVersion,controller:s.binding(lease),baselineCandidateId:'metered',reasoningEffort:'none',routing:{enabled:false,profileId:'local',candidateIds:['metered'],fallbackCandidateId:'metered'},busyPolicy},undefined,'PUT');}));
 return {pending,card:busyPolicy==='reject'?await wait(()=>s.operation<Control['ConfigReceipt']>(pending.operationId),v=>v.status==='confirmation-required'):undefined};}
const confirm=(s:Session,lease:Control['ControllerLease'],c:Control['ConfigReceipt'],digest:string,key?:string)=>s.post('/config/confirm',{expectedSessionVersion:c.sessionVersion,controller:s.binding(lease),confirmationId:c.confirmation!.confirmationId,operationDigest:c.confirmation!.operationDigest,policyDigest:digest,decision:'allow-once'},key);
test('R2.3 two concurrent answers to one native confirmation card apply it at most once',async()=>{
 const m=await h.machine({candidates:[localCandidate,metered],scripts:[okReply]});const s=m.session;const lease=(await s.claim()).lease;
 const {pending,card:shown}=await card(s,lease);expect((await s.read()).config.baselineCandidateId).toBe('scripted:m');
 const answers=await Promise.all([confirm(s,lease,shown!,m.digest,'confirm-one'),confirm(s,lease,shown!,m.digest,'confirm-two')]);
 expect(answers.map(a=>a.status).sort()).toEqual([200,409]);
 const applied=await wait(()=>s.operation<Control['ConfigReceipt']>(pending.operationId),v=>v.status==='applied');expect(applied.configVersion).toBe(2);
 await Bun.sleep(300);const config=(await s.read()).config;expect(config.configVersion).toBe(2);expect(config.baselineCandidateId).toBe('metered');expect(m.provider.requests).toHaveLength(0);
 // A late repeat of the applied answer changes nothing.
 expect((await confirm(s,lease,shown!,m.digest,'confirm-three')).status).toBe(409);expect((await s.read()).config.configVersion).toBe(2);
});
test('R2.3 an answer after the controller changed is refused for the old and the new holder and the card never applies',async()=>{
 const m=await h.machine({candidates:[localCandidate,metered],scripts:[okReply]});const s=m.session;const first=(await s.claim()).lease;const {pending,card:shown}=await card(s,first);
 const released=await success<Control['ControllerReceipt']>(await settled(async()=>{const c=await s.read();return s.post('/controller/release',{expectedSessionVersion:c.version,controller:s.binding(first)});}));await wait(s.read,v=>v.controller?.state==='released');
 const second=(await s.claim(60,'takeover',{previousReleaseReceiptId:released.receiptId})).lease;
 const answer=async(lease:Control['ControllerLease'])=>{const current=await s.read();return s.post('/config/confirm',{expectedSessionVersion:current.version,controller:s.binding(lease),confirmationId:shown!.confirmation!.confirmationId,operationDigest:shown!.confirmation!.operationDigest,policyDigest:m.digest,decision:'allow-once'});};
 for(const lease of [first,second]){const refused=await answer(lease);expect(refused.status).toBe(409);}
 expect((await confirm(s,first,shown!,m.digest)).status).toBe(409);
 await Bun.sleep(300);expect((await s.read()).config.configVersion).toBe(1);expect((await s.read()).config.baselineCandidateId).toBe('scripted:m');expect((await s.operation<Control['ConfigReceipt']>(pending.operationId)).status).not.toBe('applied');
});
test('R2.3 an answer after the confirmation card naturally expired is refused and the card never applies',async()=>{
 // A shortened native decision window: the host computes the card deadline, and Hub refuses the late answer on its own clock.
 const m=await h.machine({decisionTtlMs:3000,candidates:[localCandidate,metered],scripts:[okReply]});const s=m.session;const lease=(await s.claim()).lease;const {pending,card:shown}=await card(s,lease);
 const deadline=Date.parse(shown!.confirmation!.expiresAt);expect(deadline-Date.now()).toBeLessThanOrEqual(3000);
 await Bun.sleep(Math.max(0,deadline-Date.now()+300));
 const late=await confirm(s,lease,shown!,m.digest);expect(late.status).toBe(409);expect(await late.json()).toMatchObject({error:{code:'approval-expired'}});
 await Bun.sleep(300);const after=await s.read();expect(after.config.configVersion).toBe(1);expect(after.config.baselineCandidateId).toBe('scripted:m');
 expect((await s.operation<Control['ConfigReceipt']>(pending.operationId)).status).not.toBe('applied');expect((await h.hubCommands()).filter(c=>c.envelope.kind==='confirm-command')).toEqual([]);
});
test('R2.3 without a composition override a native confirmation card stays answerable for the frozen 120 s',async()=>{
 const m=await h.machine({candidates:[localCandidate,metered],scripts:[okReply]});const s=m.session;const lease=(await s.claim()).lease;const before=Date.now();const {card:shown}=await card(s,lease);
 const window=Date.parse(shown!.confirmation!.expiresAt)-before;expect(window).toBeGreaterThan(115_000);expect(window).toBeLessThanOrEqual(120_000+5_000);
});
