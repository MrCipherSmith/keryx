import {expect,test} from 'bun:test';
import path from 'node:path';
import {bridgeHarness,wait,newFilePatch,gated,type Session,type ApprovalRequest,type MachineOptions} from './bridge.test-support';
import {okReply,callRound} from '../../commands/agent.test-helpers';
import {success,reviewerToken} from '../../hub/remote-v2/fixture.test-support';

const h=bridgeHarness();
const TERMINAL=['succeeded','failed','cancelled','rejected','lost','unknown'];
/** A turn whose first model round asks to create `file` through apply_patch; the native waiter goes to Hub. */
async function waiter(file:string,extra:Array<ReturnType<typeof callRound>>=[],options:MachineOptions={}){
 const m=await h.machine({...options,scripts:[callRound(`patch-${file}`,'apply_patch',newFilePatch(file,'approved')),okReply,...extra]});const s=m.session;const lease=(await s.claim()).lease;
 const turn=await s.turn(lease,`Create ${file} after approval`);const question=await s.approval(turn.runId!);return {m,s,lease,turn,runId:turn.runId!,question,file:path.join(m.state.cwd,file)};
}
const outcomes=async(s:Session,runId:string,question:ApprovalRequest)=>(await s.events(runId)).filter((e):e is Extract<typeof e,{kind:'approval-outcome'}>=>e.kind==='approval-outcome'&&e.approvalId===question.approvalId);
const projection=(h2:typeof h,approvalId:string)=>h2.hubState(db=>{const row=db.query<{body:string},[string]>('SELECT body FROM remote_approval_projection WHERE id=?').get(approvalId);return row?JSON.parse(row.body) as {status:string;decision?:string}:undefined;});

test('R5.1 stale bindings, an observer and a signed-out actor are refused, and a duplicate answer applies exactly once',async()=>{
 const {m,s,lease,runId,question,file}=await waiter('approved.txt');
 // Without a composition override the native decision window is the frozen 120 s.
 const window=Date.parse(question.expiresAt)-Date.parse(question.observedAt);expect(window).toBeGreaterThan(115_000);expect(window).toBeLessThanOrEqual(120_000);
 for(const pins of [{actionFingerprint:'f'.repeat(64)},{policyDigest:'e'.repeat(64)}]){const stale=await s.answer(lease,runId,question,'allow-once',pins);expect(stale.status).toBe(409);expect(await stale.json()).toMatchObject({error:{code:'approval-expired'}});}
 const body=async()=>{const r=await s.run(runId);const current=await s.read();return {expectedRunVersion:r.version,expectedSessionVersion:current.version,controller:s.binding(lease),actionFingerprint:question.actionFingerprint,policyDigest:question.policyDigest,decision:'allow-once'};};
 const answerPath=`/hub/v2/projects/${s.projectId}/runs/${runId}/approvals/${question.approvalId}/answer`;
 const observer=await h.hub().call(answerPath,{method:'POST',cookie:await h.hub().login(reviewerToken),body:await body()});expect(observer.status).toBe(403);
 const {operatorToken}=await import('../../hub/remote-v2/fixture.test-support');const other=await h.hub().login(operatorToken);await h.hub().call('/hub/v1/session',{method:'DELETE',cookie:other});
 const signedOut=await h.hub().call(answerPath,{method:'POST',cookie:other,body:await body()});expect([401,403]).toContain(signedOut.status);
 expect(await Bun.file(file).exists()).toBe(false);expect(m.provider.requests).toHaveLength(1);expect((await projection(h,question.approvalId))?.status).toBe('waiting');
 const recorded=await success<{status:string;receiptId:string}>(await s.answer(lease,runId,question,'allow-once',{key:'answer-once'}));expect(recorded.status).toBe('recorded');
 expect(await success<typeof recorded>(await s.answer(lease,runId,question,'allow-once',{key:'answer-once'}))).toEqual(recorded);
 expect((await s.answer(lease,runId,question,'deny',{key:'answer-changed'})).status).toBe(409);
 await s.waitRun(runId,v=>v.state==='succeeded');expect(await Bun.file(file).text()).toBe('approved\n');expect(m.provider.requests).toHaveLength(2);
 expect((await outcomes(s,runId,question)).map(o=>[o.decision,o.application])).toEqual([['allow-once','applied']]);
 // A later duplicate only reads back the immutable original receipt; nothing applies again.
 expect(await success<typeof recorded>(await s.answer(lease,runId,question,'allow-once',{key:'answer-late'}))).toEqual(recorded);await Bun.sleep(200);expect(m.provider.requests).toHaveLength(2);expect(await outcomes(s,runId,question)).toHaveLength(1);
});
test('R5.1 deny leaves the tool unexecuted and the run reports it truthfully',async()=>{
 const {m,s,lease,runId,question,file}=await waiter('denied.txt');
 expect((await success<{status:string}>(await s.answer(lease,runId,question,'deny'))).status).toBe('recorded');
 const run=await s.waitRun(runId,v=>TERMINAL.includes(v.state));expect(run.state).toBe('succeeded');expect(await Bun.file(file).exists()).toBe(false);
 expect((await outcomes(s,runId,question)).map(o=>[o.decision,o.application])).toEqual([['deny','applied']]);expect(m.provider.requests).toHaveLength(2);
 // The denied patch is not in the published result.
 const published=await s.waitRun(runId,v=>v.result!==undefined);const revisions=await h.hubState(db=>(JSON.parse(db.query<{body:string},[]>('SELECT body FROM hub_state WHERE id=1').get()!.body) as {revisions:Array<{id:string;files:Array<{path:string}>}>}).revisions);
 expect(revisions.find(r=>r.id===published.result!.revisionId)?.files.map(f=>f.path)??[]).not.toContain('denied.txt');
});
test('R5.1 an answer while the machine is disconnected is only recorded and applies only after actual delivery',async()=>{
 const {m,s,lease,runId,question,file}=await waiter('offline.txt');
 // Two failed reconnect attempts leave a backoff window in which Hub serves humans while the machine stays disconnected.
 await h.stopHub();await wait(async()=>m.bridge.connected,v=>!v);await Bun.sleep(3400);await h.restartHub();
 const recorded=await success<{status:string}>(await s.answer(lease,runId,question,'allow-once'));expect(m.bridge.connected).toBe(false);expect(recorded.status).toBe('recorded');
 expect((await projection(h,question.approvalId))?.status).toBe('recorded');expect(await Bun.file(file).exists()).toBe(false);expect(m.provider.requests).toHaveLength(1);
 expect((await outcomes(s,runId,question))).toEqual([]);
 await wait(async()=>m.bridge.connected,v=>v);await s.waitRun(runId,v=>v.state==='succeeded');
 expect(await Bun.file(file).text()).toBe('approved\n');expect((await outcomes(s,runId,question)).map(o=>o.application)).toEqual(['applied']);expect(m.provider.requests).toHaveLength(2);
},40000);
test('R5.1 an approval left unanswered past its natural expiry denies, the tool never runs and a late answer is refused',async()=>{
 // A shortened native decision window: the broker's own deadline expires the waiter, no test-side timer resolves it.
 const {m,s,lease,runId,question,file}=await waiter('expired.txt',[],{decisionTtlMs:3000});
 expect(Date.parse(question.expiresAt)-Date.parse(question.observedAt)).toBeLessThanOrEqual(3000);expect((await projection(h,question.approvalId))?.status).toBe('waiting');
 const run=await s.waitRun(runId,v=>TERMINAL.includes(v.state));expect(run.state).toBe('succeeded');expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(question.expiresAt));
 expect(await Bun.file(file).exists()).toBe(false);expect((await outcomes(s,runId,question)).map(o=>o.decision)).toEqual(['deny']);expect(m.provider.requests).toHaveLength(2);
 const late=await s.answer(lease,runId,question,'allow-once');expect(late.status).toBe(409);expect(await late.json()).toMatchObject({error:{code:'approval-expired'}});
 await Bun.sleep(200);expect(await Bun.file(file).exists()).toBe(false);expect(await outcomes(s,runId,question)).toHaveLength(1);
});
import {allowAll} from './bridge.test-support';
import {tmpdir} from 'node:os';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
const cancelReceipts=async()=>(await h.hubCommands()).filter(c=>c.envelope.kind==='cancel-run').map(c=>({status:c.status,errorCode:c.receipt?.errorCode??null}));
test('R5.2 a natural terminal result observed before cancel wins: Hub reports cancel-too-late and nothing is cancelled',async()=>{
 const m=await h.machine({scripts:[okReply]});const s=m.session;const lease=(await s.claim()).lease;
 const turn=await s.turn(lease,'Finishes on its own');await s.waitRun(turn.runId!,v=>v.state==='succeeded'&&v.result!==undefined);
 const late=await s.cancel(lease,turn.runId!);expect(late.status).toBe(409);expect(await late.json()).toMatchObject({error:{code:'cancel-too-late'}});
 expect((await s.run(turn.runId!)).state).toBe('succeeded');expect(await cancelReceipts()).toEqual([]);
});
test('R5.2 a run that finishes after the cancel grant but before its stop applies stays succeeded and the cancel is a known non-application',async()=>{
 const m=await h.machine({scripts:[okReply]});const s=m.session;const release=gated(m.provider);const lease=(await s.claim()).lease;
 const turn=await s.turn(lease,'Finishes as the cancel arrives');await s.waitRun(turn.runId!,v=>v.state==='running');
 // The machine holds the cancel's fresh grant; the turn ends before the host applies the stop.
 const fetchActual=globalThis.fetch;let armed=true;
 globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=input instanceof Request?input.url:String(input);if(armed&&url.startsWith(h.hub().origin)&&url.endsWith('/authorize')){armed=false;const response=await fetchActual(input,init);release();await wait(async()=>(await s.run(turn.runId!)).state,v=>v==='succeeded');return response;}return fetchActual(input,init);},fetchActual);
 try{
  expect((await success<{status:string}>(await s.cancel(lease,turn.runId!))).status).toBe('requested');
  await wait(cancelReceipts,v=>v.some(r=>r.status==='not-applied'));expect(armed).toBe(false);
  expect(await cancelReceipts()).toEqual([{status:'not-applied',errorCode:'stale-reference'}]);
  const run=await s.run(turn.runId!);expect(run.state).toBe('succeeded');expect((await s.events(turn.runId!)).some(e=>e.kind==='state'&&(e.state==='cancelling'||e.state==='cancelled'))).toBe(false);
  expect((await wait(s.read,v=>v.state==='idle')).activeRunId).toBeNull();
  await s.waitRun(turn.runId!,v=>v.result!==undefined);const again=await s.cancel(lease,turn.runId!);expect(again.status).toBe(409);expect(await again.json()).toMatchObject({error:{code:'cancel-too-late'}});
 }finally{globalThis.fetch=fetchActual;release();}
});
const descendants=(pids:string)=>`trap "" TERM; sleep 30 & echo $! >> ${pids}; sleep 30 & echo $! >> ${pids}; wait`;
const escaping=(pids:string)=>`trap "" TERM; perl -e 'setpgrp(0,0); sleep 30' & echo $! >> ${pids}; sleep 30 & echo $! >> ${pids}; wait`;
for(const [label,script,expected] of [['TERM-ignoring descendants in the owned group are killed after the five-second grace and the run is cancelled',descendants,'cancelled'],['a descendant that left the owned process group survives and the cancel reports unknown, never cancelled',escaping,'unknown']] as const)
test(`R5.2 ${label}`,async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'cancel-pids-'));const pids=path.join(dir,'pids');let list:number[]=[];
 const m=await h.machine({approve:allowAll,scripts:[callRound('tree','shell_exec',JSON.stringify({command:script(pids)})),okReply]});const s=m.session;const lease=(await s.claim()).lease;
 const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
 try{
  const turn=await s.turn(lease,'Spawn descendants that ignore TERM');await wait(async()=>{try{return readFileSync(pids,'utf8').trim().split('\n').length;}catch{return 0;}},v=>v>=2);list=readFileSync(pids,'utf8').trim().split('\n').map(Number);
  const started=Date.now();await success(await s.cancel(lease,turn.runId!));
  const run=await s.waitRun(turn.runId!,v=>TERMINAL.includes(v.state),2000);const elapsed=Date.now()-started;expect(run.state).toBe(expected);
  if(expected==='cancelled'){expect(elapsed).toBeGreaterThanOrEqual(5000);expect(list.map(alive)).toEqual([false,false]);expect(await cancelReceipts()).toEqual([{status:'applied',errorCode:'none'}]);expect((await wait(s.read,v=>v.state==='idle')).activeRunId).toBeNull();}
  else{expect(alive(list[0]!)).toBe(true);expect(alive(list[1]!)).toBe(false);expect((await wait(s.read,v=>v.state==='recovery-required')).state).toBe('recovery-required');expect(await cancelReceipts()).not.toContainEqual({status:'applied',errorCode:'none'});}
 }finally{for(const pid of list){try{process.kill(pid,'SIGKILL');}catch{/* already gone */}}rmSync(dir,{recursive:true,force:true});}
},40000);
