import {expect,test} from 'bun:test';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {bridgeHarness,wait,allowAll,newFilePatch,gated} from './bridge.test-support';
import {okReply,callRound} from '../../commands/agent.test-helpers';
import {success} from '../../hub/remote-v2/fixture.test-support';
import type {Control} from '../../remote-control/protocol';
import {openHubStore} from '../../hub/store';
import {expirePendingCommands} from '../../hub/remote-v2/delivery';

const h=bridgeHarness();
/** The owner socket path must stay short on macOS. */
const socketBase=process.platform==='darwin'?'/private/tmp':tmpdir();
const expire=async(lease:Control['ControllerLease'])=>{await Bun.sleep(Math.max(0,Date.parse(lease.expiresAt)-Date.now()+150));};

test('R1.2 a session released by the local owner is taken over, resumed and continues with the same native identity and history',async()=>{
 const m=await h.machine({base:socketBase,approve:allowAll,scripts:[okReply,callRound('patch-after-resume','apply_patch',newFilePatch('resumed.txt','resumed')),okReply]});const s=m.session;const owner=await h.owner(m.state,m.bridge);
 const lease=(await s.claim(3)).lease;const first=await s.turn(lease,'First turn before the local release');await s.waitRun(first.runId!,v=>v.state==='succeeded');
 const before=await wait(s.read,v=>v.state==='idle'&&v.activeRunId===null);let view=await owner.inspect();const nativeSessionId=view.sessions[0]!.nativeSessionId;
 await expire(lease);const released=await owner.release('owner-release',owner.target(view));if(!released.ok||released.value.kind!=='released-expired-idle')throw new Error(owner.code(released));
 const closed=await wait(s.read,v=>v.state==='closed'&&v.controller?.state==='released');expect(closed.historyVersion).toBe(before.historyVersion);
 const takeover=await success<Control['ControllerReceipt']>(await s.post('/controller/claim',{expectedSessionVersion:closed.version,expectedControllerVersion:released.value.controller.lease.version,requestedLeaseSeconds:60,mode:'takeover',previousReleaseReceiptId:released.value.controller.receiptId}));
 const held=await wait(s.read,v=>v.controller?.controllerLeaseId===takeover.lease.controllerLeaseId&&v.controller.state==='held');
 const resumed=await success<Control['SessionOperationReceipt']>(await s.post('/resume',{expectedSessionVersion:held.version,controller:s.binding(takeover.lease),expectedHistoryVersion:held.historyVersion,expectedWorkspaceBaseline:held.workspaceBaseline}));expect(resumed.kind).toBe('resume-session');
 const idle=await wait(s.read,v=>v.state==='idle');view=await owner.inspect();expect(view.sessions[0]!.nativeSessionId).toBe(nativeSessionId);expect(view.sessions[0]!.checkoutOwned).toBe(true);
 expect(m.provider.requests).toHaveLength(1);
 const next=await s.turn(takeover.lease,'Patch after the resume',{current:idle});await s.waitRun(next.runId!,v=>v.state==='succeeded');
 // One provider call per model round of the new turn, and the resumed native conversation carries the turn before the release.
 expect(m.provider.requests).toHaveLength(3);expect(JSON.stringify(m.provider.requests[1])).toContain('First turn before the local release');
 expect(await Bun.file(path.join(m.state.cwd,'resumed.txt')).text()).toBe('resumed\n');
 const after=await wait(s.read,v=>v.state==='idle'&&v.activeRunId===null);expect(after.historyVersion).toBeGreaterThan(idle.historyVersion);expect(after.historyCursor).toBeGreaterThan(before.historyCursor);expect(after.sessionId).toBe(s.sessionId);
 expect(m.runtimes).toHaveLength(1);
},40000);
const alive=(pid:number|undefined)=>{if(pid===undefined)return false;try{process.kill(pid,0);return true;}catch{return false;}};
/** Retries a session mutation that re-reads its pins while Hub still applies the previous accepted operation or a version moved under it. */
async function settled(attempt:()=>Promise<Response>){let response!:Response;await wait(async()=>{response=await attempt();if(response.status!==409)return true;const body=await response.clone().json() as {error:{code:string;message:string}};return body.error.code!=='stale-version'&&!body.error.message.includes('waiting for machine application');},v=>v);return response;}
test('R1.3 cancel-and-close while busy settles only after measured cessation, seals the queue, keeps same-holder renewal and resume reauthorizes the retained item once',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('busy-sleep','shell_exec',JSON.stringify({command:'sleep 30'})),okReply]});const s=m.session;
 let lease=(await s.claim()).lease;const turn=await s.turn(lease,'Busy with a supervised sleep');await s.waitRun(turn.runId!,v=>v.state==='running');
 const sleeper=await wait(async()=>m.runtimes[0]!.jobs.list().find(job=>job.status==='running'),v=>v!==undefined);
 const queued=await s.turn(lease,'Queued before the close');expect(queued.status).toBe('queued');await wait(s.queue,v=>v.items.some(i=>i.operationId===queued.operationId&&i.state==='queued'));
 const close=await success<Control['SessionOperationReceipt']>(await settled(async()=>{const current=await s.read();return s.post('/close',{expectedSessionVersion:current.version,controller:s.binding(lease),mode:'cancel-and-close'});}));expect(close.status).toBe('pending');
 // The same holder may renew while the close is pending; new work is refused.
 const renewed=await success<Control['ControllerReceipt']>(await settled(async()=>{const current=await s.read();return s.post('/controller/renew',{expectedSessionVersion:current.version,expectedControllerVersion:lease.version,controllerLeaseId:lease.controllerLeaseId,requestedLeaseSeconds:60,mode:'renew'});}));expect(renewed.lease.controllerLeaseId).toBe(lease.controllerLeaseId);lease=renewed.lease;
 expect((await s.message(lease,'After the close request')).status).toBe(409);
 // A closed snapshot appears only after the owned run measurably ceased.
 const closed=await wait(s.read,v=>v.state==='closed');expect(alive(sleeper!.pid)).toBe(false);expect((await s.run(turn.runId!)).state).toBe('cancelled');expect(closed.activeRunId).toBeNull();
 expect((await wait(()=>s.operation<Control['SessionOperationReceipt']>(close.operationId),v=>v.status!=='pending')).status).toBe('applied');
 const retained=await wait(s.queue,v=>v.items.some(i=>i.operationId===queued.operationId&&i.state==='suspended'));expect(retained.items.filter(i=>i.state==='queued')).toEqual([]);
 const resumed=await success<Control['SessionOperationReceipt']>(await settled(async()=>{const current=await s.read();return s.post('/resume',{expectedSessionVersion:current.version,controller:s.binding(lease),expectedHistoryVersion:current.historyVersion,expectedWorkspaceBaseline:current.workspaceBaseline});}));expect(resumed.kind).toBe('resume-session');
 await wait(s.read,v=>v.state==='idle');await Bun.sleep(300);expect(m.provider.requests).toHaveLength(1);
 // Only an explicit fresh reauthorization admits the retained item, exactly once.
 const page=await wait(s.queue,v=>v.items.some(i=>i.operationId===queued.operationId&&i.state==='suspended'));const item=page.items.find(i=>i.operationId===queued.operationId)!;
 const reauthorize=async()=>{const current=await s.read();return s.post(`/queue/${item.queueItemId}/reauthorize`,{expectedSessionVersion:current.version,expectedQueueVersion:page.queueVersion,expectedItemVersion:item.version,queueItemId:item.queueItemId,originalOperationId:item.operationId,expectedConfigVersion:current.config.configVersion,controller:s.binding(lease),association:{mode:'ad-hoc',profileConsentVersion:1}});};
 const replacement=await success<Control['SessionOperationReceipt']>(await settled(reauthorize));
 const admitted=await wait(()=>s.operation<Control['TurnReceipt']>(replacement.operationId),v=>v.status==='admitted'&&v.runId!==null);await s.waitRun(admitted.runId!,v=>v.state==='succeeded');
 expect(m.provider.requests).toHaveLength(2);expect(JSON.stringify(m.provider.requests[1])).toContain('Queued before the close');
 expect((await reauthorize()).status).toBe(409);await Bun.sleep(300);expect(m.provider.requests).toHaveLength(2);
},40000);
const closeCommand=async()=>(await h.hubCommands()).find(c=>c.envelope.kind==='close-session');
test('R1.3 close when-idle while busy is recorded pending, seals the queue and closes at the turn boundary before any queued work is admitted',async()=>{
 const m=await h.machine({scripts:[okReply,okReply]});const s=m.session;const release=gated(m.provider);
 const lease=(await s.claim()).lease;const turn=await s.turn(lease,'Busy until the test releases it');await s.waitRun(turn.runId!,v=>v.state==='running');
 const queued=await s.turn(lease,'Queued before the close');expect(queued.status).toBe('queued');await wait(s.queue,v=>v.items.some(i=>i.operationId===queued.operationId&&i.state==='queued'));
 try{
  const close=await success<Control['SessionOperationReceipt']>(await settled(async()=>{const current=await s.read();return s.post('/close',{expectedSessionVersion:current.version,controller:s.binding(lease),mode:'when-idle'});}));expect(close.status).toBe('pending');
  // The machine records the close as admitted while the turn still runs: it is neither refused nor reported applied early.
  expect((await wait(closeCommand,v=>v?.receipt!==undefined))!.receipt!.status).toBe('admitted');
  await Bun.sleep(300);expect((await s.run(turn.runId!)).state).toBe('running');expect((await s.operation<Control['SessionOperationReceipt']>(close.operationId)).status).toBe('pending');
  expect((await s.read()).state).toBe('busy');expect((await s.message(lease,'After the close request')).status).toBe(409);
  expect((await s.queue()).items.find(i=>i.operationId===queued.operationId)?.state).toBe('queued');
  release();
  await s.waitRun(turn.runId!,v=>v.state==='succeeded');const closed=await wait(s.read,v=>v.state==='closed');expect(closed.activeRunId).toBeNull();
  expect((await wait(()=>s.operation<Control['SessionOperationReceipt']>(close.operationId),v=>v.status!=='pending')).status).toBe('applied');expect((await closeCommand())!.status).toBe('applied');
  // The queued item was never admitted: it is suspended for an explicit later reauthorization and the model saw only the first turn.
  expect((await wait(s.queue,v=>v.items.some(i=>i.operationId===queued.operationId&&i.state==='suspended'))).items.filter(i=>i.state==='queued'||i.state==='admitted')).toEqual([]);
  await Bun.sleep(300);expect(m.provider.requests).toHaveLength(1);expect((await h.hubCommands()).filter(c=>c.envelope.kind==='start-turn')).toHaveLength(1);
 }finally{release();}
});
test('R1.3 an admitted when-idle close outlives the 60 s delivery TTL: the expiry sweep leaves it pending and the turn-boundary receipt settles it applied',async()=>{
 const m=await h.machine({scripts:[okReply]});const s=m.session;const release=gated(m.provider);
 const lease=(await s.claim()).lease;const turn=await s.turn(lease,'Busy past the close delivery TTL');await s.waitRun(turn.runId!,v=>v.state==='running');
 try{
  const close=await success<Control['SessionOperationReceipt']>(await settled(async()=>{const current=await s.read();return s.post('/close',{expectedSessionVersion:current.version,controller:s.binding(lease),mode:'when-idle'});}));expect(close.status).toBe('pending');
  expect((await wait(closeCommand,v=>v?.receipt!==undefined))!.receipt!.status).toBe('admitted');
  // Hub's own expiry sweep runs after the close delivery deadline while the turn still holds the session.
  const commandId=(await closeCommand())!.envelope.commandId;
  const expiresAt=await h.hubState(db=>(JSON.parse(db.query<{body:string},[string]>('SELECT body FROM remote_command WHERE id=?').get(commandId)!.body) as {envelope:{expiresAt:string}}).envelope.expiresAt);
  const store=openHubStore(h.hub().dataDir);try{store.writeTransaction((_state,repo)=>expirePendingCommands(repo,Date.parse(expiresAt)+1));}finally{store.close();}
  expect((await closeCommand())!.status).toBe('admitted');expect((await s.operation<Control['SessionOperationReceipt']>(close.operationId)).status).toBe('pending');
  expect((await s.run(turn.runId!)).state).toBe('running');
  release();
  await s.waitRun(turn.runId!,v=>v.state==='succeeded');expect((await wait(s.read,v=>v.state==='closed')).activeRunId).toBeNull();
  expect((await wait(()=>s.operation<Control['SessionOperationReceipt']>(close.operationId),v=>v.status!=='pending')).status).toBe('applied');expect((await closeCommand())!.status).toBe('applied');
 }finally{release();}
});
test('R10.3 a supervised shell write to a tracked file fences the session visibly, publishes no misattributed result and refuses the next turn',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch','apply_patch',newFilePatch('owned.txt','owned')),callRound('shell-write','shell_exec',JSON.stringify({command:'printf shell-change > seed.txt'})),okReply,okReply]});const s=m.session;
 const lease=(await s.claim()).lease;const turn=await s.turn(lease,'Patch then write through the shell');
 // The shell's write cannot be attributed to an owned effect: conservative truthfulness keeps the outcome unknown instead of guessing.
 const run=await s.waitRun(turn.runId!,v=>['succeeded','failed','cancelled','unknown'].includes(v.state));expect(run.state).toBe('unknown');
 expect((await s.events(turn.runId!)).filter(e=>e.kind==='state'&&e.state==='unknown')).toEqual([expect.objectContaining({reasonCode:'recovery-required'})]);
 const fenced=await wait(s.read,v=>v.state==='recovery-required');expect(fenced.activeRunId).toBeNull();
 await Bun.sleep(300);expect(run.result).toBeUndefined();expect((await s.run(turn.runId!)).result).toBeUndefined();
 const revisions=await h.hubState(db=>(JSON.parse(db.query<{body:string},[]>('SELECT body FROM hub_state WHERE id=1').get()!.body) as {revisions:unknown[]}).revisions);expect(revisions).toEqual([]);
 const next=await s.message(lease,'A next turn before resolution',{busyPolicy:'reject'});expect(next.status).toBe(409);expect(m.provider.requests).toHaveLength(2);
 // Nothing local is rewritten: the owned patch and the shell's change both stay for an explicit resolution.
 expect(await Bun.file(path.join(m.state.cwd,'seed.txt')).text()).toBe('shell-change');expect(await Bun.file(path.join(m.state.cwd,'owned.txt')).text()).toBe('owned\n');
},40000);
test('R10.1 rewind through Hub is refused visibly as setup-required on a bridge-hosted session and changes nothing',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch-one','apply_patch',newFilePatch('owned.txt','first')),okReply,callRound('patch-two','apply_patch',newFilePatch('second.txt','second')),okReply]});const s=m.session;
 const lease=(await s.claim()).lease;for(const text of ['First owned patch','Second owned patch']){const turn=await s.turn(lease,text);await s.waitRun(turn.runId!,v=>v.state==='succeeded');await wait(s.read,v=>v.state==='idle'&&v.activeRunId===null);}
 const entries=m.catalogue.entries.filter(e=>e.commandName.startsWith('rewind'));expect(entries.map(e=>[e.commandName,e.availability,e.reason])).toEqual([['rewind','setup-required','owned-native-rewind-port-required'],['rewind.preview','setup-required','owned-native-rewind-port-required'],['rewind.apply','setup-required','owned-native-rewind-port-required']]);
 const before=await s.read();
 const preview=await s.invoke(lease,'rewind.preview',{seq:1,mode:'files',expectedHistoryVersion:before.historyVersion});expect(preview.status).toBe(403);expect(await preview.json()).toMatchObject({error:{code:'forbidden'}});
 const apply=await s.invoke(lease,'rewind.apply',{seq:1,mode:'files',expectedHistoryVersion:before.historyVersion,previewDigest:'a'.repeat(64),workspaceBaseline:before.workspaceBaseline});expect(apply.status).toBe(403);
 const after=await s.read();expect(after.version).toBe(before.version);expect(after.state).toBe('idle');expect(after.workspaceBaseline).toBe(before.workspaceBaseline);
 expect(await Bun.file(path.join(m.state.cwd,'owned.txt')).text()).toBe('first\n');expect(await Bun.file(path.join(m.state.cwd,'second.txt')).text()).toBe('second\n');
});
test.todo('R10.1 rewind preview, exact confirmation and apply through Hub restore owned files and refuse a stale preview or a foreign edit',async()=>{
 // Open requirement: the machine catalogue ships rewind.preview/apply as setup-required (owned-native-rewind-port-required) until the native rewind port exists (P3 R10.2).
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch-one','apply_patch',newFilePatch('owned.txt','first')),okReply]});const s=m.session;
 const lease=(await s.claim()).lease;const turn=await s.turn(lease,'First owned patch');await s.waitRun(turn.runId!,v=>v.state==='succeeded');const before=await wait(s.read,v=>v.state==='idle');
 const preview=await success<Control['CommandOutcome']>(await s.invoke(lease,'rewind.preview',{seq:1,mode:'files',expectedHistoryVersion:before.historyVersion}));expect(preview.status).toBe('applied');
 const confirmation=await success<Control['CommandOutcome']>(await s.invoke(lease,'rewind.apply',{seq:1,mode:'files',expectedHistoryVersion:before.historyVersion,previewDigest:String((preview.result as {previewDigest?:string}|null)?.previewDigest),workspaceBaseline:before.workspaceBaseline}));
 expect(confirmation.status).toBe('confirmation-required');expect(await Bun.file(path.join(m.state.cwd,'owned.txt')).exists()).toBe(true);
});
