import {expect,test} from 'bun:test';
import {bridgeHarness,wait,type RunEvent} from './bridge.test-support';
import {success} from '../../hub/remote-v2/fixture.test-support';
import type {Control} from '../../remote-control/protocol';
import type {NativeCommandContribution} from '../../session/commands/handlers';

const h=bridgeHarness();
test('R4.4 a log flood across a Hub restart keeps the terminal event, one contiguous gap range and never advances a cursor past unsent events',async()=>{
 let resume!:()=>void;const restarted=new Promise<void>(resolve=>{resume=resolve;});let reached!:()=>void;const midway=new Promise<void>(resolve=>{reached=resolve;});
 const flood:NativeCommandContribution={entry:{commandName:'risk',summary:'Log flood fixture',handlerId:'native.fixture.risk',inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},resultSchema:{type:'string',maxLength:32768},mutationClass:'workspace',states:['idle'],busyPolicy:'reject',confirmation:'none',availability:'available',reason:'explicit-test-fixture'},
  async execute(context){for(let n=0;n<60;n++){if(n===20){reached();await restarted;}context.effect!.progress('x'.repeat(8192));}return {actual:true};}};
 const m=await h.machine({contributions:[flood],runLogByteLimit:262144});const s=m.session;const lease=(await s.claim()).lease;
 const invoked=await success<Control['CommandOutcome']>(await s.invoke(lease,'risk',{},{association:{mode:'ad-hoc',profileConsentVersion:1}}));const runId=invoked.runId!;
 await midway;await h.stopHub();await wait(async()=>m.bridge.connected,v=>!v);
 // The flood continues while Hub is down; the machine only buffers and never treats an unsent range as delivered.
 resume();await wait(()=>h.sqlite(h.ledgerFile(m.state),db=>db.query<{n:number},[string]>("SELECT count(*) n FROM machine_events WHERE stream=? AND json_extract(payload,'$.kind')='state' AND json_extract(payload,'$.state')='succeeded'").get(`run:${runId}`)!.n),v=>v===1);
 const offline=await h.sqlite(h.ledgerFile(m.state),db=>db.query<{seq:number;sent:number;acked:number},[string]>('SELECT seq,sent,acked FROM machine_events WHERE stream=? ORDER BY seq').all(`run:${runId}`));
 const ackedOffline=offline.filter(row=>row.acked===1).map(row=>row.seq);expect(ackedOffline).toEqual(ackedOffline.length?Array.from({length:ackedOffline.length},(_,i)=>offline[0]!.seq+i):[]);
 await h.restartHub();await wait(async()=>m.bridge.connected,v=>v);
 const run=await s.waitRun(runId,v=>v.state==='succeeded',1500);
 const events:RunEvent[]=[];for(let after=0;;){const page=await s.events(runId,after);if(page.length===0)break;events.push(...page);after=page.at(-1)!.localSeq;if(after>=run.lastLocalSeq!)break;}
 // Hub holds every sequence number exactly once: each retained event, or a gap event covering exactly the next discarded range.
 let next=1;for(const e of events){if(e.kind==='log-gap'){expect(e.fromSeq).toBe(next);expect(e.localSeq).toBe(e.toSeq+1);}else expect(e.localSeq).toBe(next);next=e.localSeq+1;}expect(next-1).toBe(run.lastLocalSeq!);
 const gaps=events.filter((e):e is Extract<RunEvent,{kind:'log-gap'}>=>e.kind==='log-gap');expect(gaps.length).toBeGreaterThanOrEqual(1);
 for(const gap of gaps)expect(events.some(e=>e.localSeq>=gap.fromSeq&&e.localSeq<=gap.toSeq)).toBe(false);
 expect(events.filter(e=>e.kind==='state'&&e.state==='succeeded')).toHaveLength(1);
 const local=await h.sqlite(h.ledgerFile(m.state),db=>db.query<{seq:number;acked:number},[string]>('SELECT seq,acked FROM machine_events WHERE stream=? ORDER BY seq').all(`run:${runId}`));
 await wait(async()=>(await h.sqlite(h.ledgerFile(m.state),db=>db.query<{n:number},[string]>('SELECT count(*) n FROM machine_events WHERE stream=? AND acked=0').get(`run:${runId}`)!.n)),v=>v===0);expect(Math.max(...local.map(row=>row.seq))).toBeLessThanOrEqual(run.lastLocalSeq!);
},40000);
import {newFilePatch} from './bridge.test-support';
import {callRound,okReply,type Script} from '../../commands/agent.test-helpers';
import path from 'node:path';
const chunk='y'.repeat(8192);
const flood=(n:number):Script=>Array.from({length:n},()=>({kind:'text_delta' as const,text:chunk}));
/** Every Hub run event up to at least `atLeast`, and the invariant that each local sequence number appears exactly once: retained, or inside the one gap that covers it. */
async function contiguous(s:import('./bridge.test-support').Session,runId:string,atLeast:number){
 const events:RunEvent[]=[];for(let after=0;;){const page=await s.events(runId,after);if(page.length===0)break;events.push(...page);after=page.at(-1)!.localSeq;}
 let next=1;for(const e of events){if(e.kind==='log-gap'){expect(e.fromSeq).toBe(next);expect(e.localSeq).toBe(e.toSeq+1);}else expect(e.localSeq).toBe(next);next=e.localSeq+1;}
 expect(next-1).toBeGreaterThanOrEqual(atLeast);
 return events;
}
test('R4.4 an approval raised after a log flood across a Hub restart stays critical, is delivered once outside every gap and applies after the restart',async()=>{
 const m=await h.machine({runLogByteLimit:262144,scripts:[[...flood(40),...callRound('patch-flood','apply_patch',newFilePatch('flood.txt','approved'))],[...flood(40),...okReply]]});const s=m.session;const lease=(await s.claim()).lease;
 // The first model round stops halfway through its flood until Hub is down, and again before its tool call until Hub is back.
 const gate=()=>{let open!:()=>void;const opened=new Promise<void>(resolve=>{open=resolve;});return {open,opened};};const [midway,flooded,resumed,reconnected]=[gate(),gate(),gate(),gate()];
 const original=m.provider.provider.stream;let round=0;m.provider.provider.stream=(request,options)=>{const events=original(request,options);const current=++round;return (async function*(){let n=0;for await(const event of events){n++;if(current===1&&n===21){midway.open();await resumed.opened;}if(current===1&&n===41){flooded.open();await reconnected.opened;}yield event;}})();};
 const turn=await s.turn(lease,'Flood, then ask to patch');const runId=turn.runId!;
 await midway.opened;await h.stopHub();await wait(async()=>m.bridge.connected,v=>!v);
 // The rest of the flood lands while Hub is away: beyond the 256 KiB run quota it becomes durable gap metadata on the machine.
 resumed.open();await flooded.opened;expect(await h.sqlite(h.ledgerFile(m.state),db=>db.query<{n:number},[string]>('SELECT count(*) n FROM machine_discarded_logs WHERE stream=?').get(`run:${runId}`)!.n)).toBeGreaterThan(0);
 // The approval is raised only once Hub is back, while the buffered flood and its gap are being replayed.
 await h.restartHub();await wait(async()=>m.bridge.connected,v=>v);reconnected.open();
 const question=await s.approval(runId);const run=await s.run(runId);expect(run.state).toBe('waiting-approval');
 const before=await contiguous(s,runId,run.lastLocalSeq!);const requests=before.filter(e=>e.kind==='approval-request');expect(requests).toHaveLength(1);
 const gaps=before.filter((e):e is Extract<RunEvent,{kind:'log-gap'}>=>e.kind==='log-gap');expect(gaps.length).toBeGreaterThanOrEqual(1);
 for(const gap of gaps)expect(question.localSeq<gap.fromSeq||question.localSeq>gap.toSeq).toBe(true);
 expect(await Bun.file(path.join(m.state.cwd,'flood.txt')).exists()).toBe(false);
 expect((await success<{status:string}>(await s.answer(lease,runId,question,'allow-once'))).status).toBe('recorded');
 const ended=await s.waitRun(runId,v=>v.state==='succeeded'&&v.result!==undefined);expect(await Bun.file(path.join(m.state.cwd,'flood.txt')).text()).toBe('approved\n');
 const after=await contiguous(s,runId,ended.lastLocalSeq!);
 expect(after.filter(e=>e.kind==='approval-outcome').map(e=>(e as Extract<RunEvent,{kind:'approval-outcome'}>).application)).toEqual(['applied']);expect(after.filter(e=>e.kind==='state'&&e.state==='succeeded')).toHaveLength(1);
 // The second round's flood only adds discarded ranges: no critical event of the run was ever covered.
 for(const gap of after.filter((e):e is Extract<RunEvent,{kind:'log-gap'}>=>e.kind==='log-gap'))expect(after.some(e=>e.kind!=='log'&&e.kind!=='log-gap'&&e.localSeq>=gap.fromSeq&&e.localSeq<=gap.toSeq)).toBe(false);
 await wait(()=>h.sqlite(h.ledgerFile(m.state),db=>db.query<{n:number},[string]>('SELECT count(*) n FROM machine_events WHERE stream=? AND acked=0').get(`run:${runId}`)!.n),v=>v===0);expect(m.provider.requests).toHaveLength(2);
},60000);
test('R4.4 the machine run-log quota and Hub run-log storage agree at the exact 10 MiB boundary across a Hub restart: Hub refuses nothing and one gap covers the rest',async()=>{
 const QUOTA=10*1024*1024,CHUNK=8192,FILL=QUOTA/CHUNK,EXTRA=5;
 const gate=()=>{let open!:()=>void;const opened=new Promise<void>(resolve=>{open=resolve;});return {open,opened};};const [midway,resumed]=[gate(),gate()];
 const filler:NativeCommandContribution={entry:{commandName:'risk',summary:'Exact quota flood fixture',handlerId:'native.fixture.risk',inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},resultSchema:{type:'string',maxLength:32768},mutationClass:'workspace',states:['idle'],busyPolicy:'reject',confirmation:'none',availability:'available',reason:'explicit-test-fixture'},
  async execute(context){for(let n=0;n<FILL+EXTRA;n++){if(n===FILL/2){midway.open();await resumed.opened;}context.effect!.progress('z'.repeat(CHUNK));}return {actual:true};}};
 // The machine keeps its default 10 MiB per-run log quota, the same bound Hub enforces on stored run logs.
 const m=await h.machine({contributions:[filler]});const s=m.session;const lease=(await s.claim()).lease;
 const invoked=await success<Control['CommandOutcome']>(await s.invoke(lease,'risk',{},{association:{mode:'ad-hoc',profileConsentVersion:1}}));const runId=invoked.runId!;
 await midway.opened;await h.restartHub();resumed.open();await wait(async()=>m.bridge.connected,v=>v);
 const run=await s.waitRun(runId,v=>v.state==='succeeded'&&v.result!==undefined,3000);
 const events=await contiguous(s,runId,run.lastLocalSeq!);const logs=events.filter((e):e is Extract<RunEvent,{kind:'log'}>=>e.kind==='log');
 expect(logs.reduce((sum,e)=>sum+Buffer.byteLength(e.text),0)).toBe(QUOTA);expect(logs).toHaveLength(FILL);
 const gaps=events.filter((e):e is Extract<RunEvent,{kind:'log-gap'}>=>e.kind==='log-gap');expect(gaps.map(g=>g.toSeq-g.fromSeq+1)).toEqual([EXTRA]);
 expect(events.filter(e=>e.kind==='state'&&e.state==='succeeded')).toHaveLength(1);expect(h.notices.filter(code=>code==='quota-exceeded')).toEqual([]);
 await wait(()=>h.sqlite(h.ledgerFile(m.state),db=>db.query<{n:number},[string]>('SELECT count(*) n FROM machine_events WHERE stream=? AND acked=0').get(`run:${runId}`)!.n),v=>v===0);
},90000);
test('R4.4 Hub counts each run-log chunk by the bytes the machine sent and retained, so its own ingestion mask growing a chunk never refuses a retained chunk at the 10 MiB boundary',async()=>{
 const QUOTA=10*1024*1024,CHUNK=8192,FILL=QUOTA/CHUNK,EXTRA=3;
 // The machine keeps this text as is; Hub's ingestion mask stores every short bearer token as "Bearer [REDACTED]", about twice the bytes sent.
 const text=`${'Bearer x '.repeat(910)}zz`;expect(Buffer.byteLength(text)).toBe(CHUNK);
 const filler:NativeCommandContribution={entry:{commandName:'risk',summary:'Masked quota flood fixture',handlerId:'native.fixture.risk',inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},resultSchema:{type:'string',maxLength:32768},mutationClass:'workspace',states:['idle'],busyPolicy:'reject',confirmation:'none',availability:'available',reason:'explicit-test-fixture'},
  async execute(context){for(let n=0;n<FILL+EXTRA;n++)context.effect!.progress(text);return {actual:true};}};
 const m=await h.machine({contributions:[filler]});const s=m.session;const lease=(await s.claim()).lease;
 const invoked=await success<Control['CommandOutcome']>(await s.invoke(lease,'risk',{},{association:{mode:'ad-hoc',profileConsentVersion:1}}));const runId=invoked.runId!;
 const run=await s.waitRun(runId,v=>v.state==='succeeded'&&v.result!==undefined,3000);
 const events=await contiguous(s,runId,run.lastLocalSeq!);const logs=events.filter((e):e is Extract<RunEvent,{kind:'log'}>=>e.kind==='log');
 // Hub stored every chunk the machine retained, masked, and the one gap covers exactly the chunks the machine discarded at its own quota.
 expect(logs).toHaveLength(FILL);expect(logs.every(e=>e.text.startsWith('Bearer [REDACTED] '))).toBe(true);
 const gaps=events.filter((e):e is Extract<RunEvent,{kind:'log-gap'}>=>e.kind==='log-gap');expect(gaps.map(g=>g.toSeq-g.fromSeq+1)).toEqual([EXTRA]);
 expect(events.filter(e=>e.kind==='state'&&e.state==='succeeded')).toHaveLength(1);expect(h.notices.filter(code=>code==='quota-exceeded')).toEqual([]);
 await wait(()=>h.sqlite(h.ledgerFile(m.state),db=>db.query<{n:number},[string]>('SELECT count(*) n FROM machine_events WHERE stream=? AND acked=0').get(`run:${runId}`)!.n),v=>v===0);
},90000);
