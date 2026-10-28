import {expect,test} from 'bun:test';
import path from 'node:path';
import {bridgeHarness,wait,allowAll,newFilePatch} from './bridge.test-support';
import {okReply,callRound} from '../../commands/agent.test-helpers';

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
test.todo('R9.1 a failed run publishes a labeled partial result; ignored, outside-checkout and symlink paths and snapshot quota excess are refused visibly and stay local; checks are never invented',()=>{
 // Open: only secret screening is proven end to end above. The fixture cannot yet produce a failing owned run or an ignored/symlinked owned path without an unattributed shell write, which is fenced as recovery-required first.
});
test.todo('R9.2 a Flow spec change during a managed turn keeps the original result pins, marks the drift visibly and blocks automatic review submission',()=>{
 // Open: not built in this package; needs a managed Flow association with spec pins over the real Hub Flow store.
});
