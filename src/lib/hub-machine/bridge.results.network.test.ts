import {expect,test} from 'bun:test';
import path from 'node:path';
import {mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {bridgeHarness,wait,allowAll,newFilePatch,type Session} from './bridge.test-support';
import {okReply,callRound,type Script} from '../../commands/agent.test-helpers';
import {agentToken,success} from '../../hub/remote-v2/fixture.test-support';
import {criteriaDigest,type Control} from '../../remote-control/protocol';

const h=bridgeHarness();
const secret=`sk-${'a1B2c3D4e5'.repeat(3)}`;
test('R9.1 a result failing secret screening ends the run truthfully, stays local, is never uploaded and says why',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('secret','apply_patch',newFilePatch('leak.txt',secret)),okReply,okReply]});const s=m.session;const lease=(await s.claim()).lease;
 const turn=await s.turn(lease,'Write a secret-shaped token');const run=await s.waitRun(turn.runId!,v=>v.state==='succeeded');
 const events=await s.events(turn.runId!);expect(events.filter(e=>e.kind==='log'&&e.stream==='diagnostic'&&e.text.includes('secret-screening'))).toHaveLength(1);expect(events.some(e=>e.kind==='result-ready')).toBe(false);
 await Bun.sleep(500);expect(run.result).toBeUndefined();expect((await s.run(turn.runId!)).result).toBeUndefined();
 const revisions=await h.hubState(db=>(JSON.parse(db.query<{body:string},[]>('SELECT body FROM hub_state WHERE id=1').get()!.body) as {revisions:unknown[]}).revisions);expect(revisions).toEqual([]);
 const ledger=h.ledger(m.state);try{expect(ledger.pendingResults()).toEqual([]);}finally{ledger.close();}
 expect(await Bun.file(path.join(m.state.cwd,'leak.txt')).text()).toBe(`${secret}\n`);expect(h.notices).toContain('secret-screening');
 // The session stays usable: the next turn runs normally.
 const idle=await wait(s.read,v=>v.state==='idle'&&v.activeRunId===null);const next=await s.turn(lease,'A later ordinary turn',{current:idle});await s.waitRun(next.runId!,v=>v.state==='succeeded');expect(m.provider.requests).toHaveLength(3);
});
test('R9.3 a result upload whose receipt is lost replays the same operation once after a Hub restart and Hub keeps one revision',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch','apply_patch',newFilePatch('owned.txt','owned')),okReply]});const s=m.session;const lease=(await s.claim()).lease;
 // The first upload reaches Hub and is stored; its response is lost on the way back, as in a disconnect between upload and receipt.
 const fetchActual=globalThis.fetch;const uploads:string[]=[];
 globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=input instanceof Request?input.url:String(input);if(url.startsWith(h.hub().origin)&&url.endsWith('/result')){uploads.push(String(init?.body??''));const response=await fetchActual(input,init);if(uploads.length===1)throw new DOMException('The connection closed before the upload receipt arrived','AbortError');return response;}return fetchActual(input,init);},fetchActual);
 try{
  const turn=await s.turn(lease,'Owned patch with a lost upload receipt');await s.waitRun(turn.runId!,v=>v.state==='succeeded');await wait(async()=>uploads.length,v=>v>=1);
  await h.restartHub();await wait(async()=>m.bridge.connected,v=>v);
  const published=await s.waitRun(turn.runId!,v=>v.result!==undefined);await wait(async()=>(await s.events(turn.runId!)).some(e=>e.kind==='result-ready'),v=>v);
  expect(uploads.length).toBeGreaterThanOrEqual(2);expect(new Set(uploads).size).toBe(1);
  const revisions=await h.hubState(db=>(JSON.parse(db.query<{body:string},[]>('SELECT body FROM hub_state WHERE id=1').get()!.body) as {revisions:Array<{id:string}>}).revisions);expect(revisions.map(r=>r.id)).toEqual([published.result!.revisionId]);
  expect((await s.events(turn.runId!)).filter(e=>e.kind==='result-ready')).toHaveLength(1);
  const ledger=h.ledger(m.state);try{expect(ledger.pendingResults()).toEqual([]);}finally{ledger.close();}
 }finally{globalThis.fetch=fetchActual;}
},40000);
type Revision={id:string;message:string;files:Array<{path:string;contentBase64?:string}>};
type Evidence={flowId:string;subjectRevisionId:string;command:string;exitCode:number;provenance:string};
const hubAggregate=async()=>{
 const f=h.hub();const base=`/hub/v1/projects/${f.project.id}`;
 const {revisions,nextCursor}=await success<{revisions:Revision[];nextCursor?:string}>(await f.call(`${base}/revisions`,{cookie:f.cookie}));
 // Fixture histories fit one page; do not silently ignore a future second page.
 expect(nextCursor).toBeUndefined();
 const {flows}=await success<{flows:Array<{id:string}>}>(await f.call(`${base}/flows`,{cookie:f.cookie}));
 const pages=await Promise.all(flows.map(flow=>f.call(`${base}/flows/${flow.id}/evidence`,{cookie:f.cookie}).then(response=>success<{evidence:Evidence[]}>(response))));
 return {revisions,evidence:pages.flatMap(page=>page.evidence)};
};
const runChecks=(runId:string)=>h.hubState(db=>db.query<{n:number},[string]>("SELECT count(*) n FROM remote_run_check WHERE json_extract(body,'$.checkId') IS NOT NULL AND id LIKE ?").get(`${runId}:%`)!.n);
const resultEvents=async(s:Session,runId:string)=>(await s.events(runId)).filter((e):e is Extract<typeof e,{kind:'result-ready'}>=>e.kind==='result-ready');
const providerError:Script=[{kind:'provider_error',error:{kind:'unknown',retryable:false,message:'upstream 503'}}];
test('R9.1 a failed run publishes its owned change as a labeled partial result and reports no invented checks',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch','apply_patch',newFilePatch('partial.txt','partial')),providerError]});const s=m.session;const lease=(await s.claim()).lease;
 const turn=await s.turn(lease,'Patch, then the provider fails');
 const run=await s.waitRun(turn.runId!,v=>v.result!==undefined);expect(run.state).toBe('failed');expect(run.partial).toBe(true);expect(run.result).toMatchObject({partial:true,checksKind:'RunChecks',flowId:null,evidenceId:null});
 expect((await resultEvents(s,turn.runId!)).map(e=>e.partial)).toEqual([true]);
 const revision=(await hubAggregate()).revisions.find(r=>r.id===run.result!.revisionId)!;expect(revision.files.map(f=>[f.path,Buffer.from(f.contentBase64??'','base64').toString()])).toEqual([['partial.txt','partial\n']]);
 expect(revision.message).toContain('failed');expect(await runChecks(turn.runId!)).toBe(0);
 const ledger=h.ledger(m.state);try{expect(ledger.pendingResults()).toEqual([]);}finally{ledger.close();}
 // The failed run leaves the session usable for the next turn.
 expect((await wait(s.read,v=>v.state==='idle'&&v.activeRunId===null)).state).toBe('idle');
});
const outside=mkdtempSync(path.join(tmpdir(),'result-outside-'));process.on('exit',()=>rmSync(outside,{recursive:true,force:true}));
const SNAPSHOT_QUOTA=20*1024*1024;
for(const [label,target,seed,code] of [
 ['an ignored path','ignored.txt',(cwd:string)=>{writeFileSync(path.join(cwd,'.gitignore'),'ignored.txt\n');},'unsupported-ignored-path'],
 ['a path outside the checkout','../escaped.txt',()=>{},'unsafe-workspace-path'],
 ['a path through an ignored local symlink','linked/escaped.txt',(cwd:string)=>{writeFileSync(path.join(cwd,'.gitignore'),'linked\n');symlinkSync(outside,path.join(cwd,'linked'));},'unsafe-workspace-path'],
 // The patch itself is small; the checkout snapshot it would produce exceeds the 20 MiB snapshot quota, so it is refused before anything is written.
 ['a file that would take the checkout snapshot over its quota','over-quota.txt',(cwd:string)=>{writeFileSync(path.join(cwd,'large.bin'),Buffer.alloc(SNAPSHOT_QUOTA-8,1));},'quota-exceeded'],
] as const)
test(`R9.1 an owned patch to ${label} is refused before any write, the run ends truthfully, nothing is uploaded and the session stays usable`,async()=>{
 const m=await h.machine({approve:allowAll,seed,scripts:[callRound('unsafe','apply_patch',newFilePatch(target,'escaped')),okReply,okReply]});const s=m.session;const lease=(await s.claim()).lease;
 const turn=await s.turn(lease,`Patch ${target}`);
 // The refusal ends only that tool call: the model sees it and finishes the turn, which is what the run reports. No false recovery.
 const run=await s.waitRun(turn.runId!,v=>['succeeded','failed','cancelled','unknown'].includes(v.state)&&v.result!==undefined);expect(run.state).toBe('succeeded');
 const events=await s.events(turn.runId!);expect(events.flatMap(e=>e.kind==='log'?[e.text]:[])).toContain(`apply_patch: refused (${code})`);
 expect(events.some(e=>e.kind==='state'&&e.state==='unknown')).toBe(false);
 // The published result is the run's actual change set: empty, since nothing was written.
 expect((await hubAggregate()).revisions.find(r=>r.id===run.result!.revisionId)!.files).toEqual([]);
 const ledger=h.ledger(m.state);try{expect(ledger.pendingResults()).toEqual([]);}finally{ledger.close();}
 for(const file of [path.join(m.state.root,'escaped.txt'),path.join(outside,'escaped.txt'),path.join(m.state.cwd,'ignored.txt'),path.join(m.state.cwd,'over-quota.txt')])expect(await Bun.file(file).exists()).toBe(false);
 const idle=await wait(s.read,v=>v.state==='idle'&&v.activeRunId===null);
 const next=await s.turn(lease,'A later ordinary turn',{current:idle});expect((await s.waitRun(next.runId!,v=>['succeeded','failed','cancelled','unknown'].includes(v.state))).state).toBe('succeeded');expect(m.provider.requests).toHaveLength(3);
},40000);

type Flow={id:string;version:number;specDocumentId:string;specContentDigest:string;criteria:string[];status:string};
/** A frozen, started managed Flow over the real Hub Flow store, and its spec document. */
async function managedFlow(){
 const f=h.hub();const projectPath=`/hub/v1/projects/${f.project.id}`;
 const project=await success<{version:number}>(await f.call(projectPath,{cookie:f.cookie}));
 const imported=await success<{documents:Array<{id:string;version:number}>}>(await f.call(`${projectPath}/import`,{method:'POST',token:agentToken,body:{expectedVersion:project.version,sourceRevision:'source',documents:[{path:'spec.md',kind:'spec',content:'# Managed execution\nActual check.'}]}}));
 let flow=await success<Flow>(await f.call(`${projectPath}/flows`,{method:'POST',cookie:f.cookie,body:{title:'Managed remote result',specDocumentId:imported.documents[0]!.id,criteria:['Actual check']}}));
 for(const action of ['freeze','start'])flow=await success<Flow>(await f.call(`${projectPath}/flows/${flow.id}/${action}`,{method:'POST',cookie:f.cookie,body:{expectedVersion:flow.version}}));
 const association:Control['FlowAssociation']={mode:'flow',flowId:flow.id,expectedFlowVersion:flow.version,specDigest:flow.specContentDigest,criteriaDigest:criteriaDigest(flow.criteria)};
 /** An accepted human change of the spec document: the Flow's pinned spec no longer matches. */
 const changeSpec=async()=>{const document=imported.documents[0]!;const proposal=await success<{id:string;version:number;contentDigest:string}>(await f.call(`${projectPath}/proposals`,{method:'POST',token:agentToken,body:{documentId:document.id,baseVersion:document.version,content:'# Managed execution\nA changed check.',reason:'Spec changed during the turn'}}));
  await success(await f.call(`${projectPath}/proposals/${proposal.id}/review`,{method:'POST',cookie:f.cookie,body:{expectedVersion:proposal.version,contentDigest:proposal.contentDigest,decision:'accepted'}}));};
 const submit=(revisionId:string,version:number)=>f.call(`${projectPath}/flows/${flow.id}/submit-for-review`,{method:'POST',cookie:f.cookie,body:{expectedVersion:version,subjectRevisionId:revisionId}});
 return {flow,association,changeSpec,submit};
}
test('R9.2 a Flow spec change between start and upload keeps the original result pins, marks the drift visibly and blocks review submission',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch','apply_patch',newFilePatch('managed.txt','managed')),callRound('check','shell_exec',JSON.stringify({command:'echo checked'})),okReply]});const s=m.session;const lease=(await s.claim()).lease;
 const {flow,association,changeSpec,submit}=await managedFlow();
 // The spec changes after the turn's last authorized action, while its result is on the way to Hub.
 const fetchActual=globalThis.fetch;let changed=false;
 globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=input instanceof Request?input.url:String(input);if(!changed&&url.startsWith(h.hub().origin)&&url.endsWith('/result')){changed=true;await changeSpec();}return fetchActual(input,init);},fetchActual);
 try{
  const turn=await s.turn(lease,'Managed patch and check',{association});
  const run=await s.waitRun(turn.runId!,v=>v.result!==undefined);expect(changed).toBe(true);expect(run.state).toBe('succeeded');
  // Original pins: the result is the run's own pinned snapshot, attributed as self-reported Flow Evidence for that subject.
  expect(run.association).toEqual(association);expect(run.result).toMatchObject({checksKind:'FlowEvidence',flowId:flow.id,partial:false});expect(run.result!.evidenceId).not.toBeNull();
  const aggregate=await hubAggregate();expect(aggregate.evidence.filter(e=>e.subjectRevisionId===run.result!.revisionId).map(e=>[e.flowId,e.command,e.exitCode,e.provenance])).toEqual([[flow.id,'echo checked',0,'self-reported']]);
  // The drift is visible on the run and on its review-only revision.
  expect(run.pinDrift).toEqual(['spec']);expect(aggregate.revisions.find(r=>r.id===run.result!.revisionId)!.message).toContain('spec changed during execution');
  // Review submission of the drifted result is refused; the Flow stays in progress.
  const current=await success<Flow>(await h.hub().call(`/hub/v1/projects/${h.hub().project.id}/flows/${flow.id}`,{cookie:h.hub().cookie}));
  const refused=await submit(run.result!.revisionId,current.version);expect(refused.status).toBe(409);expect(await refused.json()).toMatchObject({error:{code:'spec-changed'}});
  expect((await success<Flow>(await h.hub().call(`/hub/v1/projects/${h.hub().project.id}/flows/${flow.id}`,{cookie:h.hub().cookie}))).status).toBe('in-progress');
 }finally{globalThis.fetch=fetchActual;}
},40000);
test('R9.2 a Flow spec change before the turn\'s last action stops the run at its next action: it ends failed with the drift visible, keeps the original pins and never hangs paused',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch','apply_patch',newFilePatch('managed.txt','managed')),callRound('check','shell_exec',JSON.stringify({command:'echo checked'})),callRound('after-drift','shell_exec',JSON.stringify({command:'echo late > after-drift.txt'})),okReply]});const s=m.session;const lease=(await s.claim()).lease;
 const {flow,association,changeSpec,submit}=await managedFlow();
 // The spec changes while the third model round streams: its tool call is the first action after the drift.
 const original=m.provider.provider.stream;let round=0;m.provider.provider.stream=(request,options)=>{const current=++round;const events=original(request,options);return (async function*(){if(current===3)await changeSpec();yield* events;})();};
 const turn=await s.turn(lease,'Managed patch and check, then one more action',{association});
 const run=await s.waitRun(turn.runId!,v=>['succeeded','failed','cancelled','unknown'].includes(v.state)&&v.result!==undefined);expect(run.state).toBe('failed');
 const events=await s.events(turn.runId!);expect(events.filter(e=>e.kind==='state'&&e.state==='failed').map(e=>e.kind==='state'?e.reasonCode:null)).toEqual(['stale-reference']);
 expect(events.some(e=>e.kind==='log'&&e.stream==='diagnostic'&&e.text.includes('pinned Flow changed'))).toBe(true);expect(events.some(e=>e.kind==='state'&&e.state==='unknown')).toBe(false);
 // The action after the drift never ran, and no further model round was asked for.
 expect(await Bun.file(path.join(m.state.cwd,'after-drift.txt')).exists()).toBe(false);expect(m.provider.requests).toHaveLength(3);
 // The labeled partial result keeps the run's original pins and its pre-drift Evidence; the drift is marked and review submission is refused.
 expect(run.association).toEqual(association);expect(run.pinDrift).toEqual(['spec']);expect(run.result).toMatchObject({checksKind:'FlowEvidence',flowId:flow.id,partial:true});
 const aggregate=await hubAggregate();expect(aggregate.revisions.find(r=>r.id===run.result!.revisionId)!.files.map(f=>f.path)).toEqual(['managed.txt']);expect(aggregate.evidence.filter(e=>e.subjectRevisionId===run.result!.revisionId).map(e=>e.command)).toEqual(['echo checked']);
 const current=await success<Flow>(await h.hub().call(`/hub/v1/projects/${h.hub().project.id}/flows/${flow.id}`,{cookie:h.hub().cookie}));
 const refused=await submit(run.result!.revisionId,current.version);expect(refused.status).toBe(409);expect(await refused.json()).toMatchObject({error:{code:'spec-changed'}});
 // The required human step stays in the session history, and the session is usable for a turn with current pins.
 const idle=await wait(s.read,v=>v.state==='idle'&&v.activeRunId===null);
 const history=await h.get<Control['HistoryPage']>(`${s.path}/history`);expect(history.messages.some(message=>message.role==='system-receipt'&&message.runId===turn.runId&&message.text.includes('pinned Flow changed'))).toBe(true);
 expect(idle.state).toBe('idle');
},40000);
test('R9.2 a Flow spec change caught at a model action also ends the run failed with the drift visible, never unknown or paused',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch','apply_patch',newFilePatch('managed.txt','managed')),callRound('check','shell_exec',JSON.stringify({command:'echo checked'})),okReply]});const s=m.session;const lease=(await s.claim()).lease;
 const {association,changeSpec}=await managedFlow();
 // The spec changes once the check finished, just before the machine's authority read for the third model round.
 const fetchActual=globalThis.fetch;let changed=false;
 globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=input instanceof Request?input.url:String(input);
  if(!changed&&url.endsWith(s.path)&&new Headers(init?.headers).has('authorization')&&m.runtimes[0]!.jobs.list().some(job=>job.status==='completed')){changed=true;await changeSpec();}return fetchActual(input,init);},fetchActual);
 try{
  const turn=await s.turn(lease,'Managed patch and check, then a final model round',{association});
  const run=await s.waitRun(turn.runId!,v=>['succeeded','failed','cancelled','unknown'].includes(v.state)&&v.result!==undefined);expect(changed).toBe(true);expect(run.state).toBe('failed');
  expect((await s.events(turn.runId!)).filter(e=>e.kind==='state'&&e.state==='failed').map(e=>e.kind==='state'?e.reasonCode:null)).toEqual(['stale-reference']);
  expect(m.provider.requests).toHaveLength(2);expect(run.pinDrift).toEqual(['spec']);expect(run.result).toMatchObject({checksKind:'FlowEvidence',partial:true});
  expect((await wait(s.read,v=>v.state==='idle'&&v.activeRunId===null)).state).toBe('idle');
 }finally{globalThis.fetch=fetchActual;}
},40000);
test('R9.2 an undrifted managed result carries no drift marker',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch','apply_patch',newFilePatch('managed.txt','managed')),callRound('check','shell_exec',JSON.stringify({command:'echo checked'})),okReply]});const s=m.session;const lease=(await s.claim()).lease;
 const {association}=await managedFlow();const turn=await s.turn(lease,'Managed patch and check',{association});
 const run=await s.waitRun(turn.runId!,v=>v.result!==undefined);expect(run.pinDrift).toBeUndefined();
 expect((await hubAggregate()).revisions.find(r=>r.id===run.result!.revisionId)!.message).not.toContain('changed during execution');
},40000);
const cancelCommands=async()=>(await h.hubCommands()).filter(c=>c.envelope.kind==='cancel-run');
test('R9.3 a cancel racing the in-flight result upload is refused as too late, cancels nothing and Hub keeps exactly one result',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch','apply_patch',newFilePatch('raced.txt','raced')),okReply]});const s=m.session;const lease=(await s.claim()).lease;
 // The upload leaves the machine after Hub acknowledged the terminal state, and is held there while the cancel arrives.
 const fetchActual=globalThis.fetch;let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let uploads=0;
 globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=input instanceof Request?input.url:String(input);if(url.startsWith(h.hub().origin)&&url.endsWith('/result')){uploads++;await held;}return fetchActual(input,init);},fetchActual);
 try{
  const turn=await s.turn(lease,'Owned patch whose upload races a cancel');await wait(async()=>uploads,v=>v>=1);
  expect((await s.run(turn.runId!)).state).toBe('succeeded');expect((await s.run(turn.runId!)).result).toBeUndefined();
  const late=await s.cancel(lease,turn.runId!);expect(late.status).toBe(409);expect(await late.json()).toMatchObject({error:{code:'cancel-too-late'}});
  release();
  const run=await s.waitRun(turn.runId!,v=>v.result!==undefined);expect(run.state).toBe('succeeded');expect(run.result!.partial).toBe(false);
  await Bun.sleep(300);expect(uploads).toBe(1);expect(await cancelCommands()).toEqual([]);expect((await resultEvents(s,turn.runId!))).toHaveLength(1);
  expect((await hubAggregate()).revisions.map(r=>r.id)).toEqual([run.result!.revisionId]);
  expect((await s.events(turn.runId!)).some(e=>e.kind==='state'&&(e.state==='cancelling'||e.state==='cancelled'))).toBe(false);
  const ledger=h.ledger(m.state);try{expect(ledger.pendingResults()).toEqual([]);}finally{ledger.close();}
 }finally{globalThis.fetch=fetchActual;release();}
},40000);
test('R9.3 a cancel that wins before the upload ends the run cancelled and publishes its owned change once as a labeled partial result',async()=>{
 const m=await h.machine({approve:allowAll,scripts:[callRound('patch','apply_patch',newFilePatch('cancelled.txt','cancelled')),callRound('sleep','shell_exec',JSON.stringify({command:'sleep 30'})),okReply]});const s=m.session;const lease=(await s.claim()).lease;
 const turn=await s.turn(lease,'Owned patch, then a long sleep');
 await wait(async()=>m.runtimes[0]!.jobs.list().some(job=>job.status==='running'),v=>v);
 expect((await success<{status:string}>(await s.cancel(lease,turn.runId!))).status).toBe('requested');
 const run=await s.waitRun(turn.runId!,v=>v.result!==undefined);expect(run.state).toBe('cancelled');expect(run.result!.partial).toBe(true);
 const revision=(await hubAggregate()).revisions.find(r=>r.id===run.result!.revisionId)!;expect(revision.files.map(f=>f.path)).toEqual(['cancelled.txt']);expect(revision.message).toContain('cancelled');
 await Bun.sleep(300);expect((await resultEvents(s,turn.runId!)).map(e=>e.partial)).toEqual([true]);expect((await cancelCommands()).map(c=>c.receipt?.status)).toEqual(['applied']);
 expect((await hubAggregate()).revisions).toHaveLength(1);
},40000);
