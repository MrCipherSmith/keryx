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
