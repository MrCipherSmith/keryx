import {expect,test} from 'bun:test';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {bridgeHarness,wait} from './bridge.test-support';
import {success} from '../../hub/remote-v2/fixture.test-support';
import {okReply} from '../../commands/agent.test-helpers';

const h=bridgeHarness();

test('R11.1 a start-turn message refused after its pool claim ends failed, releases only its own slot and leaves the session not busy',async()=>{
 const m=await h.machine({scripts:[okReply]});const s=m.session;const lease=(await s.claim()).lease;
 // The checkout changes only while the bridge awaits this turn's grant: after its pool claim and pre-checks, before the host verifies its workspace and refuses admission.
 const fetchActual=globalThis.fetch;let armed=true;
 globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=input instanceof Request?input.url:String(input);if(armed&&url.startsWith(h.hub().origin)&&url.endsWith('/authorize')){armed=false;writeFileSync(path.join(m.state.cwd,'developer-edit.txt'),'external change');}return fetchActual(input,init);},fetchActual);
 try{
  const turn=await s.turn(lease,'Refused at the host after the pool claim',{busyPolicy:'reject'});expect(turn.status).toBe('admitted');
  const run=await s.waitRun(turn.runId!,v=>['failed','rejected','succeeded'].includes(v.state));expect(armed).toBe(false);expect(run.state).toBe('failed');expect(m.provider.requests).toHaveLength(0);
  const events=await s.events(turn.runId!);expect(events.some(e=>e.kind==='state'&&e.state==='starting')).toBe(true);expect(events.filter(e=>e.kind==='state'&&e.state==='failed')).toHaveLength(1);
  expect(await h.poolRows(m.state)).toBe(0);const ledger=h.ledger(m.state);try{expect(ledger.unresolved()).toEqual([]);}finally{ledger.close();}
  const after=await wait(s.read,v=>v.activeRunId===null&&v.state!=='busy');expect(after.activeTurnId).toBeNull();expect(after.state).not.toBe('recovery-required');
  const {acquireCheckoutLease}=await import('./checkout-lease');expect(()=>acquireCheckoutLease(m.state.cwd,{hubId:'other-hub',runId:'foreign-run',daemonId:'foreign-daemon'})).toThrow('checkout-busy');expect(await Bun.file(path.join(m.state.cwd,'developer-edit.txt')).text()).toBe('external change');
 }finally{globalThis.fetch=fetchActual;}
});
import {callRound} from '../../commands/agent.test-helpers';
import {allowAll,type Session} from './bridge.test-support';
import type {Control} from '../../remote-control/protocol';
type Task={taskId:string;status:string;phase:string;description:string};
/** The session's own job registry as Hub sees it through the read-only `tasks` command. */
async function tasksOf(s:Session,lease:Control['ControllerLease']):Promise<Task[]>{for(;;){const response=await s.invoke(lease,'tasks');if(response.status===409){await Bun.sleep(20);continue;}const invoked=await response.json() as Control['CommandOutcome'];const applied=await wait(()=>s.operation<Control['CommandOutcome']>(invoked.operationId),v=>v.status!=='queued'&&v.status!=='confirmation-required');const parsed=JSON.parse(String(applied.result)) as {ok:boolean;data:Task[]};return parsed.data;}}
async function owned(s:Session,lease:Control['ControllerLease'],commandName:string,args:Record<string,unknown>){const response=await s.invoke(lease,commandName,args);const body=await response.json() as Control['CommandOutcome']&{error?:{code:string}};if(response.status!==200)return {http:response.status,code:body.error?.code};const outcome=await wait(()=>s.operation<Control['CommandOutcome']>(body.operationId),v=>v.status!=='queued');return {http:200,status:outcome.status,errorCode:outcome.errorCode,result:outcome.result};}
const alive=(pid:number|undefined)=>{if(pid===undefined)return false;try{process.kill(pid,0);return true;}catch{return false;}};
test('R6.1 owned task controls stop only the exact own task and refuse foreign resources without stopping anything',async()=>{
 const m=await h.machine({checkouts:2,approve:allowAll,scripts:[callRound('sleep-a','shell_exec',JSON.stringify({command:'sleep 30'})),callRound('sleep-b','shell_exec',JSON.stringify({command:'sleep 30'})),okReply]});const [a,b]=m.sessions as [Session,Session];
 const la=(await a.claim()).lease,lb=(await b.claim()).lease;const [ra,rb]=[m.runtimes[0]!,m.runtimes[1]!];
 const ta=await a.turn(la,'Sleep in A');const aTask=(await wait(()=>tasksOf(a,la),v=>v.some(t=>t.status==='running'))).find(t=>t.status==='running')!.taskId;
 const tb=await b.turn(lb,'Sleep in B');const bTask=(await wait(()=>tasksOf(b,lb),v=>v.some(t=>t.status==='running'))).find(t=>t.status==='running')!.taskId;
 const aPid=ra.jobs.get(aTask)!.pid,bPid=rb.jobs.get(bTask)!.pid;expect(alive(aPid)&&alive(bPid)).toBe(true);
 // A live task in A's own registry that belongs to a different run.
 const other=await ra.jobs.start('sleep 30',{phase:'foreground',owner:{kind:'run',identity:'another-run'}});if(!other.ok)throw new Error('foreign-run task did not start');const otherPid=ra.jobs.get(other.jobId)!.pid;
 try{
  for(const [name,args] of [['tasks.kill',{taskId:bTask}],['demote',{taskId:bTask}],['tasks.kill',{taskId:other.jobId}],['demote',{taskId:other.jobId}],['tasks.kill',{taskId:'task-on-another-machine'}]] as const){const r=await owned(a,la,name,args);expect(r.http).toBe(200);expect(r.status).toBe('rejected');}
  expect(alive(bPid)).toBe(true);expect(alive(otherPid)).toBe(true);expect(alive(aPid)).toBe(true);expect(rb.jobs.get(bTask)!.status).toBe('running');expect(ra.jobs.get(other.jobId)!.status).toBe('running');
  // An observer is refused at the Hub before any machine delivery.
  const {reviewerToken}=await import('../../hub/remote-v2/fixture.test-support');const reviewer=await h.hub().login(reviewerToken);const current=await a.read();
  const observer=await h.hub().call(`${a.path}/commands/invoke`,{method:'POST',cookie:reviewer,body:{expectedSessionVersion:current.version,expectedConfigVersion:current.config.configVersion,controller:a.binding(la),catalogueDigest:m.catalogue.catalogueDigest,commandName:'tasks.kill',arguments:{taskId:aTask},busyPolicy:'reject'}});expect(observer.status).toBe(403);expect(alive(aPid)).toBe(true);
  // The controller's own task: only its process group stops.
  const kill=await owned(a,la,'tasks.kill',{taskId:aTask});expect(kill).toMatchObject({http:200,status:'applied'});
  await wait(async()=>alive(aPid),v=>!v);expect(alive(bPid)).toBe(true);expect(alive(otherPid)).toBe(true);
  await a.waitRun(ta.runId!,v=>v.state==='succeeded');
  const late=await owned(a,la,'tasks.kill',{taskId:aTask});expect(late.status).not.toBe('applied');// Each refusal settled in Hub: the session still accepts ordinary work.
  expect((await tasksOf(a,la)).find(task=>task.taskId===aTask)?.status).not.toBe('running');expect(alive(bPid)).toBe(true);
  expect((await b.run(tb.runId!)).state).toBe('running');
 }finally{await ra.jobs.kill(other.jobId,'operator');}
 await b.cancel(lb,tb.runId!);await b.waitRun(tb.runId!,v=>v.state==='cancelled');expect(alive(bPid)).toBe(false);
},60000);
test('R6.1 interrupt stops only the active turn of its own session and is refused without an active run or for an observer',async()=>{
 const m=await h.machine({checkouts:2,approve:allowAll,scripts:[callRound('sleep-a','shell_exec',JSON.stringify({command:'sleep 30'})),callRound('sleep-b','shell_exec',JSON.stringify({command:'sleep 30'})),okReply]});const [a,b]=m.sessions as [Session,Session];
 const la=(await a.claim()).lease,lb=(await b.claim()).lease;const [ra,rb]=[m.runtimes[0]!,m.runtimes[1]!];
 expect((await a.invoke(la,'interrupt')).status).toBe(409);
 const ta=await a.turn(la,'Sleep in A');const aTask=(await wait(()=>tasksOf(a,la),v=>v.some(t=>t.status==='running'))).find(t=>t.status==='running')!.taskId;
 const tb=await b.turn(lb,'Sleep in B');const bTask=(await wait(()=>tasksOf(b,lb),v=>v.some(t=>t.status==='running'))).find(t=>t.status==='running')!.taskId;
 const aPid=ra.jobs.get(aTask)!.pid,bPid=rb.jobs.get(bTask)!.pid;
 // The schema of the shipped interrupt names no run; a run identity it does not declare is refused before any delivery.
 expect((await a.invoke(la,'interrupt',{runId:ta.runId,turnId:ta.turnId})).status).toBe(400);
 const {reviewerToken}=await import('../../hub/remote-v2/fixture.test-support');const reviewer=await h.hub().login(reviewerToken);const current=await a.read();
 expect((await h.hub().call(`${a.path}/commands/invoke`,{method:'POST',cookie:reviewer,body:{expectedSessionVersion:current.version,expectedConfigVersion:current.config.configVersion,controller:a.binding(la),catalogueDigest:m.catalogue.catalogueDigest,commandName:'interrupt',arguments:{},busyPolicy:'reject'}})).status).toBe(403);expect(alive(aPid)).toBe(true);
 const stopped=await owned(a,la,'interrupt',{});expect(stopped).toMatchObject({http:200,status:'applied'});
 const ended=await a.waitRun(ta.runId!,v=>['succeeded','failed','cancelled'].includes(v.state));expect(ended.state).toBe('cancelled');await wait(async()=>alive(aPid),v=>!v);
 expect(alive(bPid)).toBe(true);expect((await b.run(tb.runId!)).state).toBe('running');expect(m.runtimes).toHaveLength(2);
 const idle=await wait(a.read,v=>v.state==='idle'&&v.activeRunId===null);expect(idle.activeTurnId).toBeNull();
 await b.cancel(lb,tb.runId!);await b.waitRun(tb.runId!,v=>v.state==='cancelled');
},60000);
test('R11.2 an uncertain run-scoped command outcome keeps its pool capacity and nonce end to end and never re-executes',async()=>{
 const {superviseSpawnedProcess}=await import('../../harness/tool/builtin/background-job-registry');const {MachineExecutionPool}=await import('./pool');
 const children:Array<ReturnType<typeof Bun.spawn>>=[];h.onCleanup(async()=>{for(const child of children){try{process.kill(-child.pid,'SIGKILL');}catch{/* The group is already gone. */}await child.exited;}});
 let executions=0;let runtimeOf:()=>import('../../session/native-runtime').NativeSessionRuntime=()=>{throw new Error('runtime missing');};
 const contribution:import('../../session/commands/handlers').NativeCommandContribution={entry:{commandName:'risk',summary:'Leaves an unkillable owned task',handlerId:'native.fixture.risk',inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},resultSchema:{type:'string',maxLength:32768},mutationClass:'workspace',states:['idle'],busyPolicy:'reject',confirmation:'none',availability:'available',reason:'explicit-test-fixture'},
  async execute(){executions++;const started=await runtimeOf().jobs.start('owned unkillable fixture',{phase:'foreground'});if(!started.ok)throw new Error('owned task did not start');return {actual:true};}};
 // A failed OS stop port: the actual process stays alive, so cessation can never be proven.
 const m=await h.machine({contributions:[contribution],spawner:()=>{const proc=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'pipe',stderr:'pipe',detached:true});children.push(proc);return superviseSpawnedProcess(proc,{kill(){/* never stops */}});}});
 runtimeOf=()=>m.runtimes[0]!;const s=m.session;const lease=(await s.claim()).lease;
 const invoked=await success<Control['CommandOutcome']>(await s.invoke(lease,'risk',{},{association:{mode:'ad-hoc',profileConsentVersion:1}}));expect(invoked.runId).not.toBeNull();const runId=invoked.runId!;
 const run=await s.waitRun(runId,v=>!['dispatching','received','starting','running'].includes(v.state));expect(run.state).toBe('unknown');expect(executions).toBe(1);
 const outcome=await wait(()=>s.operation<Control['CommandOutcome']>(invoked.operationId),v=>v.status!=='queued');expect(outcome.status).toBe('recovery-required');
 // The slot and its nonce stay reserved for this exact run; nothing releases them on an unproven outcome.
 const pool=new MachineExecutionPool(path.join(m.state.configDir,'hub-machines','executions.sqlite'));try{expect(pool.reservations(m.state.hubId).map(row=>row.runId)).toEqual([runId]);}finally{pool.close();}
 expect((await s.events(runId)).filter(e=>e.kind==='state'&&e.state==='unknown')).toEqual([expect.objectContaining({reasonCode:'recovery-required'})]);
 const fenced=await wait(s.read,v=>v.state==='recovery-required');expect(fenced.activeRunId===null||fenced.activeRunId===runId).toBe(true);
 expect(alive(children[0]!.pid)).toBe(true);
 // A further launch is refused and the uncertain command is never executed again, also not after a Hub reconnect replay.
 expect((await s.message(lease,'Another turn',{busyPolicy:'reject'})).status).toBe(409);
 await h.restartHub();await wait(async()=>m.bridge.connected,v=>v);await Bun.sleep(300);expect(executions).toBe(1);
 const again=new MachineExecutionPool(path.join(m.state.configDir,'hub-machines','executions.sqlite'));try{expect(again.reservations(m.state.hubId).map(row=>row.runId)).toEqual([runId]);}finally{again.close();}
 expect((await s.run(runId)).state).toBe('unknown');
},40000);
