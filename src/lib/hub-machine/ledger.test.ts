import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MachineLedger } from './ledger';
import type {Control} from '../../remote-control/protocol';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true }); });
function file() { const d = mkdtempSync(path.join(tmpdir(), 'machine-ledger-')); dirs.push(d); return path.join(d, 'control.sqlite'); }
const command = { hubId: 'hub-a', commandId: 'command-a', digest: 'a'.repeat(64), runId: 'run-a', checkoutId: 'checkout-a' };
test('SQLite command claim survives restart and conflicts on changed payload', () => {
    const f = file();
    let l = new MachineLedger(f);
    expect(l.claim(command)).toEqual({ status: 'claimed' });
    l.close();
    l = new MachineLedger(f);
    expect(l.claim(command)).toEqual({ status: 'replay', phase: 'received' });
    expect(() => l.claim({ ...command, digest: 'b'.repeat(64) })).toThrow('payload-conflict');
    l.close();
});
test('the inventory publication version replays for identical content and only grows on change, across daemon restarts', () => {
    const f = file(), first = 'a'.repeat(64), changed = 'b'.repeat(64);
    let l = new MachineLedger(f);
    expect(l.publicationVersion(first)).toBe(1);
    expect(l.publicationVersion(first)).toBe(1);
    l.close();
    l = new MachineLedger(f);
    expect(l.publicationVersion(first)).toBe(1);
    expect(l.publicationVersion(changed)).toBe(2);
    l.close();
    l = new MachineLedger(f);
    // Content that returns to an earlier state is still a change: the version never goes back.
    expect(l.publicationVersion(first)).toBe(3);
    expect(l.publicationVersion(first)).toBe(3);
    l.close();
});
test('prestart tombstone becomes unknown on restart and is never an automatic retry', () => {
    const f = file();
    let l = new MachineLedger(f);
    l.claim(command);
    l.markStarting(command.hubId, command.commandId, 'daemon-a');
    l.close();
    l = new MachineLedger(f);
    expect(l.claim(command)).toEqual({ status: 'replay', phase: 'unknown' });
    expect(() => l.markStarting(command.hubId, command.commandId, 'daemon-b')).toThrow('recovery-required');
    l.close();
});
test('critical outbox append is durable and acknowledges only events actually sent', () => {
    const f = file();
    let l = new MachineLedger(f);
    expect(l.appendEvent('run-a', { type: 'state', state: 'running' })).toBe(1);
    l.close();
    l = new MachineLedger(f);
    expect(l.pendingEvents('run-a')).toEqual([{ seq: 1, payload: { type: 'state', state: 'running' } }]);
    expect(() => l.ackEvents('run-a', 1)).toThrow('unsent');
    l.markSent('run-a', 1);
    l.ackEvents('run-a', 1);
    expect(l.pendingEvents('run-a')).toEqual([]);
    l.close();
});
test('two separate processes cannot both claim a command', async () => {
    const f = file();
    const modulePath = path.join(import.meta.dir, 'ledger.ts');
    const script = `import {MachineLedger} from ${JSON.stringify(modulePath)};const l=new MachineLedger(process.argv[1]);console.log(l.claim(${JSON.stringify(command)}).status);l.close();`;
    const children = [Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', '-e', script, f], { stdout: 'pipe', stderr: 'pipe' }), Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', '-e', script, f], { stdout: 'pipe', stderr: 'pipe' })];
    const outcomes = await Promise.all(children.map(async (c) => { const out = await new Response(c.stdout).text(); const err = await new Response(c.stderr).text(); expect(err).toBe(''); expect(await c.exited).toBe(0); return out.trim(); }));
    expect(outcomes.sort()).toEqual(['claimed', 'replay']);
});
test('stable ledger identity is retained across daemon restart', () => { const f = file(); let l = new MachineLedger(f); const identity = l.ledgerId; expect(identity).toMatch(/^[a-z0-9-]{20,}$/); l.close(); l = new MachineLedger(f); expect(l.ledgerId).toBe(identity); l.close(); });
test('command claim receipt and replay cursor are atomic and never move beyond a sequence gap',()=>{
 const f=file();const l=new MachineLedger(f);l.claim({...command,hubSequence:2,envelope:{name:'two'}});expect(l.lastHubSequence).toBe(0);l.claim({...command,commandId:'one',hubSequence:1,envelope:{name:'one'}});expect(l.lastHubSequence).toBe(2);l.recordReceipt(command.hubId,command.commandId,{status:'received'});expect(l.commandReceipt(command.hubId,command.commandId)).toEqual({status:'received'});l.close();const restored=new MachineLedger(f);expect(restored.lastHubSequence).toBe(2);expect(restored.commandReceipt(command.hubId,command.commandId)).toEqual({status:'received'});restored.close();
});
test('outbox preserves explicit event sequences and stream namespaces across restart',()=>{
 const f=file();let l=new MachineLedger(f);l.persistEvent('session:s',1,{kind:'message'});expect(()=>l.persistEvent('session:s',1,{kind:'changed'})).toThrow('payload-conflict');expect(()=>l.persistEvent('session:s',3,{kind:'gap'})).toThrow('replay-gap');l.persistEvent('run:r',1,{kind:'state'});l.markSent('session:s',1);l.ackEvents('session:s',1);l.close();l=new MachineLedger(f);expect(l.cursors()).toEqual([{stream:'run:r',ack:0},{stream:'session:s',ack:1}]);expect(l.pendingEvents('run:r')).toHaveLength(1);l.close();
});
test('result draft and sealed version survive restart and cannot change on replay',()=>{
 const f=file();let l=new MachineLedger(f);const draft:Omit<Control['ResultUpload'],'expectedRunVersion'>={sessionId:'s',turnId:'t',association:{mode:'ad-hoc',profileConsentVersion:1},gitBaseSha:'a'.repeat(40),workspaceBaseline:'b'.repeat(64),outcome:'succeeded',partial:false,changes:[],checks:[]};l.stageResultDraft('r',draft);const sealed=l.sealResultVersion('r',5);expect(sealed.expectedRunVersion).toBe(5);l.close();l=new MachineLedger(f);expect(l.sealResultVersion('r',8)).toEqual(sealed);expect(()=>l.stageResultDraft('r',{...draft,partial:true})).toThrow('payload-conflict');expect(l.pendingResults()).toEqual([{runId:'r',draft,upload:sealed}]);l.close();
});
test('queued original operation identity keeps its scoped original digest across new delivery commands',()=>{const f=file();let l=new MachineLedger(f);l.rememberOperation('op',{sessionId:'s',digest:'a'.repeat(64),kind:'submit-message',body:{text:'literal'}});l.close();l=new MachineLedger(f);expect(l.operation('op','s')).toEqual({sessionId:'s',digest:'a'.repeat(64),kind:'submit-message',body:{text:'literal'}});expect(l.operation('op','foreign')).toBeNull();expect(()=>l.rememberOperation('op',{sessionId:'s',digest:'b'.repeat(64),kind:'submit-message',body:{text:'changed'}})).toThrow('payload-conflict');l.close();});
test('restored Hub cursors reopen retained events for replay but cannot acknowledge unsent or fabricated ranges',()=>{const f=file();const l=new MachineLedger(f);l.persistEvent('session:s',1,{kind:'state'});l.persistEvent('session:s',2,{kind:'state'});l.markSent('session:s',1);l.markSent('session:s',2);l.ackEvents('session:s',2);l.reconcileCursor('session:s',0);expect(l.pendingEvents('session:s')).toHaveLength(2);expect(()=>l.reconcileCursor('session:s',3)).toThrow('replay-gap');expect(()=>l.reconcileCursor('session:s',1)).toThrow('unsent');l.close();});
test('discarded log-only records form a durable exact gap while critical events remain replayable',()=>{
 const f=file();let ledger=new MachineLedger(f);ledger.persistEvent('run:r',1,{kind:'state'});ledger.appendDiscardedLog('run:r',{kind:'log',text:'discard one'});ledger.appendDiscardedLog('run:r',{kind:'log',text:'discard two'});expect(()=>ledger.appendDiscardedLog('run:r',{kind:'state'})).toThrow('invalid-log-discard');
 const seq=ledger.flushDiscardedLogs('run:r',(localSeq,fromSeq,toSeq)=>({kind:'log-gap',localSeq,fromSeq,toSeq,reason:'local-quota'}));expect(seq).toBe(4);ledger.persistEvent('run:r',5,{kind:'state',state:'succeeded'});ledger.close();ledger=new MachineLedger(f);expect(ledger.pendingEvents('run:r').map(e=>e.seq)).toEqual([1,4,5]);expect(ledger.discardedLogs('run:r')).toMatchObject([{seq:2,gapSeq:4},{seq:3,gapSeq:4}]);expect(()=>ledger.ackEvents('run:r',5)).toThrow('unsent-event-ack');for(const item of ledger.pendingEvents('run:r'))ledger.markSent('run:r',item.seq);ledger.ackEvents('run:r',5);expect(ledger.cursors()).toEqual([{stream:'run:r',ack:5}]);expect(()=>ledger.reconcileCursor('run:r',2)).toThrow('replay-gap');ledger.close();
});
test('default durable run log quota retains exactly ten MiB then stores only discard metadata',()=>{
 const f=file(),ledger=new MachineLedger(f),chunk='x'.repeat(8192);try{for(let n=0;n<1280;n++)expect(ledger.appendRunLog('run:default',{kind:'log',text:chunk}).retained).toBe(true);const overflow=ledger.appendRunLog('run:default',{kind:'log',text:'overflow must not persist'});expect(overflow.retained).toBe(false);expect(ledger.retainedLogBytes('run:default')).toBe(10*1024*1024);expect(ledger.discardedLogs('run:default')).toHaveLength(1);expect(()=>ledger.appendRunLog('run:default',{kind:'log',text:chunk},10*1024*1024+1)).toThrow('invalid-log-quota');}finally{ledger.close();}
});
test('local owner recovery claims are durable before stop and uncertain claims cannot replay or be renamed',()=>{
 const f=file();let ledger=new MachineLedger(f);expect(ledger.claimLocalRecovery('owner-1','a'.repeat(64),'session-1')).toEqual({status:'claimed'});ledger.close();ledger=new MachineLedger(f);try{expect(ledger.claimLocalRecovery('owner-1','a'.repeat(64),'session-1')).toEqual({status:'unknown'});expect(()=>ledger.claimLocalRecovery('owner-1','b'.repeat(64),'session-1')).toThrow('payload-conflict');expect(()=>ledger.claimLocalRecovery('owner-2','a'.repeat(64),'session-1')).toThrow('recovery-required');}finally{ledger.close();}
});
test('completed local owner recovery replays only the exact durable result without another stop',()=>{
 const f=file();const ledger=new MachineLedger(f);try{const result={ok:true,value:{stopped:true}};expect(ledger.claimLocalRecovery('owner-done','a'.repeat(64),'session-done').status).toBe('claimed');ledger.finishLocalRecovery('owner-done','a'.repeat(64),result);expect(ledger.claimLocalRecovery('owner-done','a'.repeat(64),'session-done')).toEqual({status:'replay',result});expect(()=>ledger.finishLocalRecovery('owner-done','a'.repeat(64),{ok:false})).toThrow('payload-conflict');}finally{ledger.close();}
});
test('seven-day retention retires only acknowledged log content of long-terminal runs behind exact durable ranges',async()=>{
 const {canonicalDigest}=await import('../../remote-control/protocol');const f=file();let ledger=new MachineLedger(f);const day=86400000;
 const log=(seq:number,text:string)=>({kind:'log',stream:'assistant',text,localSeq:seq});
 const deliver=(stream:string)=>{const pending=ledger.pendingEvents(stream);for(const item of pending)ledger.markSent(stream,item.seq);ledger.ackEvents(stream,pending.at(-1)?.seq??0);};
 try{
  ledger.claim(command);ledger.persistEvent('run:old',1,{kind:'state',state:'running'});ledger.persistEvent('run:old',2,log(2,'old one'));ledger.persistEvent('run:old',3,log(3,'old two'));ledger.persistEvent('run:old',4,{kind:'state',state:'succeeded'});deliver('run:old');
  ledger.persistEvent('run:unsent',1,log(1,'never acknowledged'));ledger.persistEvent('run:unsent',2,{kind:'state',state:'failed'});
  ledger.persistEvent('run:live',1,{kind:'state',state:'running'});ledger.persistEvent('run:live',2,log(2,'still running'));deliver('run:live');
  ledger.persistEvent('session:s',1,{kind:'session-state'});deliver('session:s');
  ledger.recordDaemon({daemonId:'daemon-old',lockNonce:'nonce-old',pid:4242,pgid:4242,startedAt:'lstart:x'});
  expect(ledger.retireExpiredLogs(Date.now()+6*day)).toBe(0);
  const retiredDigest=canonicalDigest([canonicalDigest(log(2,'old one')),canonicalDigest(log(3,'old two'))]);
  expect(ledger.retireExpiredLogs(Date.now()+8*day)).toBe(2);expect(ledger.retireExpiredLogs(Date.now()+8*day)).toBe(0);
  ledger.close();ledger=new MachineLedger(f);
  expect(ledger.retiredLogs('run:old')).toMatchObject([{fromSeq:2,toSeq:3,digest:retiredDigest,bytes:Buffer.byteLength('old one')+Buffer.byteLength('old two')}]);
  expect(ledger.pendingEvents('run:old')).toEqual([]);expect(ledger.cursors()).toEqual([{stream:'run:live',ack:2},{stream:'run:old',ack:4},{stream:'run:unsent',ack:0},{stream:'session:s',ack:1}]);
  // Retired content can never be replayed or regenerated; the acknowledged cursor still reconciles.
  expect(()=>ledger.reconcileCursor('run:old',1)).toThrow('replay-gap');ledger.reconcileCursor('run:old',4);
  // Critical events, unacknowledged logs, live runs, session events, command tombstones and launch identities are kept.
  expect(ledger.pendingEvents('run:unsent').map(e=>e.seq)).toEqual([1,2]);expect(ledger.retiredLogs('run:unsent')).toEqual([]);expect(ledger.retiredLogs('run:live')).toEqual([]);
  expect(ledger.claim(command)).toEqual({status:'replay',phase:'received'});expect(ledger.daemonRecord('daemon-old')).toMatchObject({lockNonce:'nonce-old'});
  // Retired sequence numbers are never reused.
  expect(ledger.appendEvent('run:old',{kind:'result-ready'})).toBe(5);
 }finally{ledger.close();}
});
test('at the event cap new launches are refused while an admitted run still persists its critical events',async()=>{
 const {LEDGER_EVENT_CAPACITY}=await import('./ledger');const {Database}=await import('bun:sqlite');const f=file();let ledger=new MachineLedger(f);
 try{
  expect(ledger.claim({...command,commandId:'admitted-start',runId:'run-live',launch:true})).toEqual({status:'claimed'});ledger.finish('hub-a','admitted-start','applied',{status:'admitted'});
  ledger.persistEvent('run:run-live',1,{kind:'state',state:'running'});ledger.close();
  const raw=new Database(f);try{raw.transaction(()=>{const insert=raw.query('INSERT INTO machine_events(stream,seq,payload,sent,acked) VALUES(?,?,?,1,1)');for(let seq=1;seq<LEDGER_EVENT_CAPACITY;seq++)insert.run('run:filler',seq,'{"kind":"log","text":"x"}');})();}finally{raw.close();}
  ledger=new MachineLedger(f);
  expect(()=>ledger.claim({...command,commandId:'new-start',runId:'run-new',launch:true})).toThrow('quota-exceeded');
  // The refused launch is durable so the bridge answers it visibly; its replay is refused the same way.
  expect(ledger.unresolved().map(row=>[row.id,row.phase])).toContainEqual(['new-start','received']);expect(()=>ledger.claim({...command,commandId:'new-start',runId:'run-new',launch:true})).toThrow('quota-exceeded');
  expect(ledger.claim({...command,commandId:'cancel-live',runId:'run-live'})).toEqual({status:'claimed'});
  ledger.persistEvent('run:run-live',2,{kind:'approval-request',approvalId:'approval-1'});ledger.persistEvent('run:run-live',3,{kind:'approval-outcome',approvalId:'approval-1'});
  const log=ledger.appendRunLog('run:run-live',(seq:number)=>({kind:'log',stream:'assistant',text:'over the cap',localSeq:seq}));expect(log).toEqual({seq:4,retained:false});
  expect(ledger.flushDiscardedLogs('run:run-live',(localSeq,fromSeq,toSeq)=>({kind:'log-gap',localSeq,fromSeq,toSeq}))).toBe(5);
  ledger.persistEvent('run:run-live',6,{kind:'state',state:'succeeded'});ledger.persistEvent('session:s',1,{kind:'session-state'});
  expect(ledger.pendingEvents('run:run-live').map(e=>e.seq)).toEqual([1,2,3,5,6]);expect(ledger.launchQuotaExceeded()).toBe(true);
 }finally{ledger.close();}
});
test('crash identities: daemon and owned-process records, spawn intents and run recovery claims are durable and exact',()=>{
 const f=file();let ledger=new MachineLedger(f);
 try{
  const daemon={daemonId:'daemon-a',lockNonce:'lock-a',pid:101,pgid:100,startedAt:'lstart:Wed Oct 28 09:00:00 2026'};ledger.recordDaemon(daemon);ledger.recordDaemon(daemon);expect(()=>ledger.recordDaemon({...daemon,startedAt:'other'})).toThrow('payload-conflict');
  ledger.beginOwnedProcess({id:'spawn-1',daemonId:'daemon-a',checkoutId:'checkout-a',sessionId:'session-a'});ledger.recordOwnedProcess('spawn-1',{pid:200,pgid:200,startedAt:'lstart:x'});
  ledger.beginOwnedProcess({id:'spawn-2',daemonId:'daemon-a',checkoutId:'checkout-a',sessionId:'session-a'});
  ledger.beginOwnedProcess({id:'spawn-3',daemonId:'daemon-a',checkoutId:'checkout-a',sessionId:'session-a'});ledger.abandonOwnedProcess('spawn-3');
  expect(()=>ledger.recordOwnedProcess('spawn-3',{pid:1,pgid:1,startedAt:'x'})).toThrow('recovery-required');ledger.abandonOwnedProcess('spawn-1');
  ledger.claim({...command,daemonId:'daemon-a'});ledger.markStarting('hub-a','command-a','daemon-a');
  ledger.close();ledger=new MachineLedger(f);
  // A crash between intent and identity leaves the intent, never no row; a recorded identity is never abandoned.
  expect(ledger.ownedProcesses('daemon-a','checkout-a')).toEqual([{id:'spawn-1',daemonId:'daemon-a',checkoutId:'checkout-a',sessionId:'session-a',phase:'recorded',pid:200,pgid:200,startedAt:'lstart:x'},{id:'spawn-2',daemonId:'daemon-a',checkoutId:'checkout-a',sessionId:'session-a',phase:'intent',pid:null,pgid:null,startedAt:null}]);
  expect(ledger.daemonByLockNonce('lock-a')).toEqual(daemon);expect(ledger.launchCommand('hub-a','run-a','a'.repeat(64))).toEqual({id:'command-a',phase:'unknown',daemon:'daemon-a',checkout:'checkout-a'});
  expect(ledger.claimRunRecovery('confirm-1','b'.repeat(64),'run-a','confirm-run-absence')).toEqual({status:'claimed'});
  // An interrupted observation resumes; it never fences the run as unknown.
  expect(ledger.claimRunRecovery('confirm-1','b'.repeat(64),'run-a','confirm-run-absence')).toEqual({status:'claimed'});
  expect(()=>ledger.claimRunRecovery('confirm-1','c'.repeat(64),'run-a','confirm-run-absence')).toThrow('payload-conflict');
  const result={ok:true,value:{kind:'run-absence-confirmed'}};ledger.finishRunRecovery('confirm-1','b'.repeat(64),result);ledger.finishRunRecovery('confirm-1','b'.repeat(64),result);expect(()=>ledger.finishRunRecovery('confirm-1','b'.repeat(64),{ok:false})).toThrow('payload-conflict');
  expect(ledger.claimRunRecovery('confirm-1','b'.repeat(64),'run-a','confirm-run-absence')).toEqual({status:'replay',result});
  expect(()=>ledger.claimRunRecovery('confirm-1','b'.repeat(64),'run-a','release-resolved-run')).toThrow('payload-conflict');
  ledger.resolveLostRun('hub-a','command-a','run-a','reconciliation-1');ledger.resolveLostRun('hub-a','command-a','run-a','reconciliation-1');expect(()=>ledger.resolveLostRun('hub-a','command-a','run-a','reconciliation-2')).toThrow('payload-conflict');
  expect(ledger.unresolved()).toEqual([]);expect(ledger.claim({...command,daemonId:'daemon-b'})).toEqual({status:'replay',phase:'lost'});
  ledger.forgetDaemon('daemon-a');expect(ledger.ownedProcesses('daemon-a','checkout-a')).toEqual([]);expect(ledger.daemonRecord('daemon-a')).toBeNull();
 }finally{ledger.close();}
});
/** Appends real acknowledged log rows of ~60 KiB to the SQLite file until it stores at least `target` bytes; few rows, so the event count stays far below its cap. */
async function fillBytes(f:string,stream:string,target:number,terminalAt?:number):Promise<number>{
 const {Database}=await import('bun:sqlite');const raw=new Database(f);
 try{const text='x'.repeat(60*1024);let seq=raw.query<{n:number},[string]>('SELECT coalesce(max(seq),0) n FROM machine_events WHERE stream=?').get(stream)!.n;const insert=raw.query('INSERT INTO machine_events(stream,seq,payload,sent,acked) VALUES(?,?,?,1,1)');
  const stored=()=>{const pages=raw.query<{page_count:number},[]>('PRAGMA page_count').get()!.page_count,free=raw.query<{freelist_count:number},[]>('PRAGMA freelist_count').get()!.freelist_count;return (pages-free)*raw.query<{page_size:number},[]>('PRAGMA page_size').get()!.page_size;};
  raw.transaction(()=>{while(stored()<target){seq++;insert.run(stream,seq,JSON.stringify({kind:'log',stream:'assistant',text,localSeq:seq}));}if(terminalAt!==undefined)raw.query('INSERT OR REPLACE INTO machine_run_terminal(stream,terminalAt) VALUES(?,?)').run(stream,terminalAt);})();
  return seq;}finally{raw.close();}
}
test('the ledger is bounded by stored bytes: launches stop with headroom below the reopen limit, critical events persist and retention frees space',async()=>{
 const {LEDGER_EVENT_CAPACITY,LEDGER_LAUNCH_BYTE_LIMIT,LEDGER_LOG_BYTE_LIMIT,LEDGER_FILE_LIMIT}=await import('./ledger');const {statSync}=await import('node:fs');const f=file();let ledger=new MachineLedger(f);
 expect(LEDGER_LAUNCH_BYTE_LIMIT).toBeLessThan(LEDGER_LOG_BYTE_LIMIT);expect(LEDGER_LOG_BYTE_LIMIT).toBeLessThan(LEDGER_FILE_LIMIT);
 try{
  expect(ledger.claim({...command,commandId:'admitted-start',runId:'run-live',launch:true})).toEqual({status:'claimed'});ledger.finish('hub-a','admitted-start','applied',{status:'admitted'});ledger.persistEvent('run:run-live',1,{kind:'state',state:'running'});ledger.close();
  // Old acknowledged logs of a run terminal for eight days fill the file past the log bound with only ~800 rows.
  const rows=await fillBytes(f,'run:old',LEDGER_LOG_BYTE_LIMIT,Date.now()-8*86400000);expect(rows).toBeLessThan(LEDGER_EVENT_CAPACITY/100);
  ledger=new MachineLedger(f);expect(ledger.storedBytes()).toBeGreaterThanOrEqual(LEDGER_LOG_BYTE_LIMIT);
  expect(()=>ledger.claim({...command,commandId:'byte-refused-start',runId:'run-new',launch:true})).toThrow('quota-exceeded');expect(ledger.unresolved().map(row=>row.id)).toContain('byte-refused-start');
  expect(ledger.claim({...command,commandId:'cancel-live',runId:'run-live'})).toEqual({status:'claimed'});
  // A running turn keeps its approval, terminal and result events; its log content becomes an exact gap.
  ledger.persistEvent('run:run-live',2,{kind:'approval-request',approvalId:'approval-1',summary:'y'.repeat(8192)});ledger.persistEvent('run:run-live',3,{kind:'approval-outcome',approvalId:'approval-1'});
  expect(ledger.appendRunLog('run:run-live',(seq:number)=>({kind:'log',stream:'assistant',text:'over the byte bound',localSeq:seq}))).toEqual({seq:4,retained:false});
  expect(ledger.flushDiscardedLogs('run:run-live',(localSeq,fromSeq,toSeq)=>({kind:'log-gap',localSeq,fromSeq,toSeq}))).toBe(5);
  ledger.persistEvent('run:run-live',6,{kind:'state',state:'succeeded'});ledger.persistEvent('run:run-live',7,{kind:'result-ready',revisionId:'revision-1'});
  expect(ledger.pendingEvents('run:run-live').map(e=>e.seq)).toEqual([1,2,3,5,6,7]);
  ledger.close();expect(statSync(f).size).toBeLessThan(LEDGER_FILE_LIMIT);ledger=new MachineLedger(f);
  // Retention of acknowledged content frees pages; launches are admitted again and later writes reuse the space.
  expect(ledger.retireExpiredLogs()).toBe(rows);expect(ledger.storedBytes()).toBeLessThan(LEDGER_LAUNCH_BYTE_LIMIT);expect(ledger.launchQuotaExceeded()).toBe(false);
  expect(ledger.claim({...command,commandId:'after-retention-start',runId:'run-after',launch:true})).toEqual({status:'claimed'});
  const before=statSync(f).size;ledger.close();await fillBytes(f,'run:reuse',LEDGER_LAUNCH_BYTE_LIMIT-4*1024*1024);expect(statSync(f).size).toBe(before);ledger=new MachineLedger(f);
 }finally{ledger.close();}
});
test('an oversized ledger refuses to open with ledger-size-exceeded and is never truncated or rewritten',async()=>{
 const {LEDGER_FILE_LIMIT}=await import('./ledger');const {machineFailure}=await import('./errors');const {statSync,readFileSync}=await import('node:fs');const {createHash}=await import('node:crypto');
 const f=file();const ledger=new MachineLedger(f);ledger.claim(command);ledger.persistEvent('run:unacked',1,{kind:'state',state:'running'});ledger.close();
 await fillBytes(f,'run:unacked-logs',LEDGER_FILE_LIMIT+1024*1024);
 const size=statSync(f).size,digest=createHash('sha256').update(readFileSync(f)).digest('hex');expect(size).toBeGreaterThan(LEDGER_FILE_LIMIT);
 let refusal:unknown;try{new MachineLedger(f).close();}catch(cause){refusal=cause;}
 // The startup notice is exactly this code, never the generic size or permission failure.
 expect(refusal).toMatchObject({name:'MachineError',code:'ledger-size-exceeded'});expect(machineFailure(refusal).code).toBe('ledger-size-exceeded');
 expect(statSync(f).size).toBe(size);expect(createHash('sha256').update(readFileSync(f)).digest('hex')).toBe(digest);
});
