import {afterEach,expect,test} from 'bun:test';
import {fixture,admittedSession,appliedController,success,hubRun,D,HEAD,type Fixture} from './fixture.test-support';
import type {Control,FrameOf} from '../../remote-control/protocol';
let f:Fixture|undefined;let browser:WebSocket|undefined;
afterEach(async()=>{browser?.close();browser=undefined;if(f)await f.close();f=undefined;});
const NativeWebSocket=WebSocket as unknown as {new(url:string,options:Bun.WebSocketOptions):WebSocket};
async function subscribe(fx:Fixture){
 browser=new NativeWebSocket(`${fx.origin.replace('http','ws')}/hub/v2/events/socket?projectId=${fx.project.id}`,{headers:{Cookie:fx.cookie,Origin:fx.origin}});
 const frames:Control['BrowserInvalidation'][]=[];browser.addEventListener('message',e=>frames.push(JSON.parse(String(e.data))));
 await new Promise<void>((resolve,reject)=>{browser!.addEventListener('open',()=>resolve(),{once:true});browser!.addEventListener('error',()=>reject(new Error('browser upgrade failed')),{once:true});});
 return frames;
}
async function until(check:()=>boolean,ms=3000){const end=Date.now()+ms;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));return check();}
async function startTurn(fx:Fixture){
 const s=await admittedSession(fx);const c=await appliedController(fx,s);
 const turn=await success<Control['TurnReceipt']>(await fx.call(`${s.path}/messages`,{method:'POST',cookie:fx.cookie,body:{expectedSessionVersion:c.sessionVersion,expectedConfigVersion:1,controller:{controllerLeaseId:c.lease.controllerLeaseId,expectedControllerVersion:c.lease.version},text:'t',interpretation:'literal-message',busyPolicy:'reject',association:{mode:'ad-hoc',profileConsentVersion:1}}}));
 const command=(await s.peer.next('command')).payload as FrameOf<'command'>['payload'];
 return {s,turn,command};
}

test('a start-turn the machine refuses before starting ends its run, fails its operation and leaves the session closable',async()=>{
 f=await fixture();const {s,turn,command}=await startTurn(f);
 s.peer.send('command-receipt',{commandId:command.commandId,hubSequence:command.hubSequence,runId:turn.runId,sessionId:s.session.sessionId,observedRunVersion:1,status:'rejected',errorCode:'checkout-dirty'});
 s.peer.send('heartbeat',{daemonId:'daemon-1'});await s.peer.next('heartbeat-ack');
 expect(s.peer.pendingFrames().filter(frame=>frame.type==='error')).toEqual([]);
 const run=hubRun(f.dataDir,turn.runId!)!;
 expect(run.state).toBe('rejected');expect(typeof run.terminalAt).toBe('string');
 const operation=await f.call(`${s.path}/operations/${turn.operationId}`,{cookie:f.cookie});
 expect({status:operation.status,body:await operation.json()}).toMatchObject({status:409,body:{error:{code:'checkout-dirty'}}});
 // An unended run would make Hub refuse the closed projection as recovery-required.
 const session=await success<Control['SessionRecord']>(await f.call(s.path,{cookie:f.cookie}));
 const seq=session.sessionEventCursor+1;
 s.peer.send('session-event',{sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:'checkout',sessionEventSeq:seq,observedAt:new Date().toISOString(),kind:'session-state',session:{...session,state:'closed',activeRunId:null,activeTurnId:null,sessionEventCursor:seq}});
 const ack=await s.peer.next('session-event-ack');
 expect(ack.payload).toMatchObject({sessionId:s.session.sessionId,sessionEventSeq:seq});
});

test('a run resolved lost is terminal with terminalAt and announced to browsers',async()=>{
 f=await fixture();const {s,turn,command}=await startTurn(f);
 const base={runId:turn.runId,projectId:f.project.id,checkoutId:'checkout',sessionId:s.session.sessionId,turnId:turn.turnId};
 s.peer.send('run-event',{...base,localSeq:1,observedAt:new Date().toISOString(),kind:'state',state:'unknown',reasonCode:'recovery-required'});await s.peer.next('run-event-ack');
 const run=await success<{version:number}>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`,{cookie:f.cookie}));
 const report:Control['ReconciliationReport']={runId:turn.runId!,projectId:f.project.id,checkoutId:'checkout',ledgerId:'ledger-1',daemonId:'daemon-1',commandDigest:command.commandDigest,expectedRunVersion:run.version,observation:'confirmed-stopped',observedAt:new Date().toISOString(),sessionId:s.session.sessionId,turnId:turn.turnId!};
 const receipt=await success<Control['ReconciliationReceipt']>(await f.call(`/hub/v2/machines/${s.machine.machineId}/reconciliations`,{method:'POST',token:s.machine.secret,origin:null,body:report}));
 const frames=await subscribe(f);const before=hubRun(f.dataDir,turn.runId!)!.notificationVersion??0;
 await success(await f.call(`/hub/v2/machines/${s.machine.machineId}/resolve-run`,{method:'POST',cookie:f.cookie,body:{runId:turn.runId,expectedRunVersion:run.version,localReconciliationId:receipt.reconciliationId,decision:'lost',reason:'absent'}}));
 const after=hubRun(f.dataDir,turn.runId!)!;
 expect(after.state).toBe('lost');expect(typeof after.terminalAt).toBe('string');expect(after.notificationVersion).toBe(before+1);
 expect(await until(()=>frames.some(frame=>frame.resource==='run'&&frame.resourceId===turn.runId&&frame.version===before+1))).toBe(true);
});

test('an uploaded result is announced to browsers with a newer run version',async()=>{
 f=await fixture();const {s,turn,command}=await startTurn(f);
 await success(await f.call(`/hub/v2/machines/${s.machine.machineId}/commands/${command.commandId}/authorize`,{method:'POST',token:s.machine.secret,origin:null,body:{commandDigest:command.commandDigest,policyDigest:D,target:{scope:'run',sessionId:turn.sessionId,runId:turn.runId,turnId:turn.turnId,expectedRunVersion:1,expectedSessionVersion:turn.sessionVersion},controller:(command as Record<string,unknown>).controller}}));
 const event={runId:turn.runId,sessionId:turn.sessionId,turnId:turn.turnId,projectId:f.project.id,checkoutId:'checkout',observedAt:new Date().toISOString(),kind:'state',reasonCode:'none'};
 for(const [i,state] of ['received','starting','running','succeeded'].entries()){s.peer.send('run-event',{...event,localSeq:i+1,state,...(i>=2?{nativeIdentity:{sessionId:turn.sessionId,turnId:turn.turnId,daemonId:'daemon-1',supervisorHandleId:'supervisor-1'}}:{})});await s.peer.next('run-event-ack');}
 const run=await success<{version:number}>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`,{cookie:f.cookie}));
 const frames=await subscribe(f);const before=hubRun(f.dataDir,turn.runId!)!.notificationVersion??0;
 const body={expectedRunVersion:run.version,gitBaseSha:HEAD,outcome:'succeeded',partial:false,changes:[{path:'new.ts',contentBase64:Buffer.from('export const a = 1;\n').toString('base64'),mode:'100644'}],checks:[{checkId:'c',command:'x',exitCode:0,output:'ok'}],sessionId:turn.sessionId,turnId:turn.turnId,association:{mode:'ad-hoc',profileConsentVersion:1},workspaceBaseline:D};
 await success(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}/result`,{method:'POST',token:s.machine.secret,origin:null,key:'r1',body}));
 expect(hubRun(f.dataDir,turn.runId!)!.notificationVersion).toBe(before+1);
 expect(await until(()=>frames.some(frame=>frame.resource==='run'&&frame.resourceId===turn.runId&&frame.version===before+1))).toBe(true);
});
