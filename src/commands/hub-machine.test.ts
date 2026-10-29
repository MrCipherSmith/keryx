import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hubMachineCommand } from './hub-machine';
import { machineConfigPath, machineStateDir, loadEnrollment } from '../lib/hub-machine/config';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true }); });
function dir() { const d = mkdtempSync(path.join(tmpdir(), 'machine-cli-')); dirs.push(d); return d; }
test('pair accepts explicitly named environment code, saves no raw code and does not print secret', async () => {
    const stateDir = dir();
    const logs: string[] = [];
    const server = Bun.serve({ port: 0, async fetch(r) { expect((await r.json() as {
            code: string;
        }).code).toBe('c'.repeat(22)); return Response.json({ machineId: 'machine-a', secret: 's'.repeat(43) }); } });
    try {
        await hubMachineCommand(['pair', '--url', server.url.origin, '--code-env', 'PAIR_FIXTURE'], { stateDir, env: { PAIR_FIXTURE: 'c'.repeat(22) }, write: s => logs.push(s) });
        const enrollment = loadEnrollment(stateDir)!;
        expect(enrollment.mappings).toEqual([]);
        expect(logs.join('')).not.toContain('s'.repeat(43));
        expect(readFileSync(machineConfigPath(stateDir), 'utf8')).not.toContain('c'.repeat(22));
    }
    finally {
        server.stop(true);
    }
});
test('raw code argv and unrecognized allowance fields fail closed before network', async () => {
    for (const args of [['pair', '--url', 'https://hub.example', '--code', 'raw-secret'], ['allow', '--project', 'p', '--checkout', 'c', '--path', '/tmp', '--profile', 'native', '--exec', 'sh']])
        await expect(hubMachineCommand(args, { stateDir: dir(), env: {}, write: () => { } })).rejects.toThrow();
});
test('unpair removes only enrollment while preserving durable launch identities', async () => {
    const stateDir = dir();
    const { saveEnrollment } = await import('../lib/hub-machine/config');
    saveEnrollment(stateDir, { hubUrl: 'https://hub.example', machineId: 'machine-a', secret: 's'.repeat(43) });
    const { MachineLedger } = await import('../lib/hub-machine/ledger');
    let ledger = new MachineLedger(path.join(machineStateDir(stateDir,loadEnrollment(stateDir)!.hubId),'control.sqlite'));
    const identity = ledger.ledgerId; const ledgerPath=path.join(machineStateDir(stateDir,loadEnrollment(stateDir)!.hubId),'control.sqlite');
    ledger.close();
    await hubMachineCommand(['unpair'], { stateDir, write: () => { } });
    expect(loadEnrollment(stateDir)).toBeNull();
    ledger = new MachineLedger(ledgerPath);
    expect(ledger.ledgerId).toBe(identity);
    ledger.close();
});
test('unpair refuses unresolved command and recovery reports uncertainty without releasing it', async () => {
    const stateDir = dir();
    const { saveEnrollment } = await import('../lib/hub-machine/config');
    saveEnrollment(stateDir, { hubUrl: 'https://hub.example', machineId: 'machine-a', secret: 's'.repeat(43) });
    const { MachineLedger } = await import('../lib/hub-machine/ledger');
    const ledger = new MachineLedger(path.join(machineStateDir(stateDir,loadEnrollment(stateDir)!.hubId),'control.sqlite'));
    ledger.claim({ hubId: 'h', commandId: 'c', digest: 'a'.repeat(64), runId: 'r', checkoutId: 'checkout' });
    ledger.markStarting('h', 'c', 'daemon');
    ledger.close();
    await expect(hubMachineCommand(['unpair'], { stateDir, write: () => { } })).rejects.toThrow('recovery-required');
    const logs: string[] = [];
    await hubMachineCommand(['recover'], { stateDir, write: s => logs.push(s) });
    expect(logs.join('')).toContain('unknown');
    expect(loadEnrollment(stateDir)).not.toBeNull();
});
test('hub CLI routes machine commands before ordinary Hub flags and preserves watch help', async () => {
    const { hubCommand, HUB_HELP } = await import('./hub');
    expect(HUB_HELP).toContain('machine pair');
    await expect(hubCommand(['machine', 'pair', '--code', 'raw-secret'])).rejects.toThrow('Invalid hub machine arguments');
    expect(HUB_HELP).toContain('sync [--watch');
});
test('local configure snapshots only explicitly selected current candidate and ad-hoc consent',async()=>{
 const stateDir=dir();const {saveEnrollment,hubIdentity}=await import('../lib/hub-machine/config');const {saveShellConfig}=await import('../lib/shell-config');const {readMachinePolicy}=await import('../lib/hub-machine/policy');saveEnrollment(stateDir,{hubUrl:'https://hub.example',machineId:'m',secret:'s'.repeat(43)});saveShellConfig({provider:'local-fixture',model:'fixture-model'},stateDir);
 await hubMachineCommand(['configure','--hub',hubIdentity('https://hub.example'),'--candidate','current','--ad-hoc','deny','--max-runs','1'],{stateDir,write:()=>{}});const policy=readMachinePolicy(stateDir,hubIdentity('https://hub.example'))!;expect(policy.allowAdHocSessions).toBe(false);expect(policy.maxConcurrentRuns).toBe(1);expect(policy.allowedCandidateIds).toHaveLength(1);expect(JSON.stringify(policy)).not.toContain('fixture-model');
});
test('concurrent pair commands serialize before consuming a second Hub one-use code',async()=>{
 const stateDir=dir();let requests=0;let release!:()=>void;const gate=new Promise<void>(r=>release=r);const server=Bun.serve({port:0,async fetch(){requests++;await gate;return Response.json({machineId:`machine-${requests}`,secret:'s'.repeat(43)});}});
 const options={stateDir,env:{PAIR_FIXTURE:'c'.repeat(22)},write:()=>{}};const args=['pair','--url',server.url.origin,'--code-env','PAIR_FIXTURE'];
 try{const first=hubMachineCommand(args,options);while(requests===0)await Bun.sleep(1);const second=hubMachineCommand(args,options).then(()=>false,()=>true);await Bun.sleep(5);release();await first;expect(await second).toBe(true);expect(requests).toBe(1);}finally{release();server.stop(true);}
});
test('recover inspection uses the protected running owner channel without any Hub bearer',async()=>{
 const fs=await import('node:fs');const {startLocalOwnerControl}=await import('../lib/hub-machine/local-control');const{hubIdentity,saveEnrollment}=await import('../lib/hub-machine/config');const stateDir=fs.mkdtempSync(process.platform==='darwin'?'/private/tmp/owner-cli-':path.join(tmpdir(),'owner-cli-'));dirs.push(stateDir);const hubId=hubIdentity('https://hub.example');saveEnrollment(stateDir,{hubUrl:'https://hub.example',machineId:'m',secret:'s'.repeat(43)});let calls=0;const value={kind:'inspection' as const,hubId,machineId:'m',ledgerId:'ledger',daemonId:'daemon',sessions:[],unresolved:[],recoveryClaims:[],uncertainRuns:[],truncated:false};const server=await startLocalOwnerControl({configDir:stateDir,handle:async request=>{expect(request.operation).toBe('inspect');calls++;return{ok:true,value};}});try{const logs:string[]=[];await hubMachineCommand(['recover','--hub',hubId],{stateDir,write:s=>logs.push(s)});expect(calls).toBe(1);expect(JSON.parse(logs[0]!)).toMatchObject(value);expect(logs.join('')).not.toContain('s'.repeat(43));}finally{await server.stop();}
});
test('release recovery requires exact explicit pins and sends only the local owner operation',async()=>{
 const fs=await import('node:fs');const{startLocalOwnerControl}=await import('../lib/hub-machine/local-control');const{hubIdentity,saveEnrollment}=await import('../lib/hub-machine/config');const stateDir=fs.mkdtempSync(process.platform==='darwin'?'/private/tmp/owner-stop-cli-':path.join(tmpdir(),'owner-stop-cli-'));dirs.push(stateDir);const hubId=hubIdentity('https://hub.example');saveEnrollment(stateDir,{hubUrl:'https://hub.example',machineId:'m',secret:'s'.repeat(43)});let calls=0;const server=await startLocalOwnerControl({configDir:stateDir,handle:async request=>{calls++;expect(request).toEqual({v:1,hubId,requestId:'explicit-owner-request',operation:'release-expired-idle',target:{sessionId:'session',nativeSessionId:'native',controllerLeaseId:'lease',controllerVersion:1,expectedSessionVersion:3,expectedHistoryVersion:1,expectedWorkspaceBaseline:'a'.repeat(64)}});return{ok:false,error:{code:'recovery-required',message:'recovery-required'}};}});try{await expect(hubMachineCommand(['recover','--hub',hubId,'--action','release-expired-idle','--session','session'],{stateDir})).rejects.toThrow();expect(calls).toBe(0);await expect(hubMachineCommand(['recover','--hub',hubId,'--action','release-expired-idle','--session','session','--native-session','native','--controller-lease','lease','--controller-version','1','--session-version','3','--history-version','1','--workspace-baseline','a'.repeat(64),'--request-id','explicit-owner-request'],{stateDir})).rejects.toThrow('recovery-required');expect(calls).toBe(1);}finally{await server.stop();}
});
test('crash-run recovery actions send only their exact run pins over the owner channel',async()=>{
 const fs=await import('node:fs');const{startLocalOwnerControl}=await import('../lib/hub-machine/local-control');const{hubIdentity,saveEnrollment}=await import('../lib/hub-machine/config');const stateDir=fs.mkdtempSync(process.platform==='darwin'?'/private/tmp/owner-run-cli-':path.join(tmpdir(),'owner-run-cli-'));dirs.push(stateDir);const hubId=hubIdentity('https://hub.example');saveEnrollment(stateDir,{hubUrl:'https://hub.example',machineId:'m',secret:'s'.repeat(43)});
 const seen:unknown[]=[];const server=await startLocalOwnerControl({configDir:stateDir,handle:async request=>{seen.push(request);return request.operation==='confirm-run-absence'?{ok:true,value:{kind:'run-absence-confirmed',runId:'run-1',sessionId:'session-1',reconciliationId:'reconciliation-1',expectedRunVersion:4,receivedAt:new Date().toISOString()}}:{ok:false,error:{code:'recovery-required',message:'recovery-required'}};}});
 try{const logs:string[]=[];
  await expect(hubMachineCommand(['recover','--hub',hubId,'--action','confirm-run-absence','--run','run-1'],{stateDir})).rejects.toThrow('Required --request-id');
  await expect(hubMachineCommand(['recover','--hub',hubId,'--action','confirm-run-absence','--run','run-1','--session','session-1','--request-id','confirm-1'],{stateDir})).rejects.toThrow('invalid-local-request');
  await hubMachineCommand(['recover','--hub',hubId,'--action','confirm-run-absence','--run','run-1','--request-id','confirm-1'],{stateDir,write:s=>logs.push(s)});expect(JSON.parse(logs[0]!)).toMatchObject({kind:'run-absence-confirmed',reconciliationId:'reconciliation-1'});
  await expect(hubMachineCommand(['recover','--hub',hubId,'--action','release-resolved-run','--run','run-1','--request-id','release-1'],{stateDir})).rejects.toThrow('Required --reconciliation');
  await expect(hubMachineCommand(['recover','--hub',hubId,'--action','release-resolved-run','--run','run-1','--reconciliation','reconciliation-1','--request-id','release-1'],{stateDir})).rejects.toThrow('recovery-required');
  expect(seen).toEqual([{v:1,hubId,requestId:'confirm-1',operation:'confirm-run-absence',target:{runId:'run-1'}},{v:1,hubId,requestId:'release-1',operation:'release-resolved-run',target:{runId:'run-1',reconciliationId:'reconciliation-1'}}]);
 }finally{await server.stop();}
});
test('a crashed command settlement sends only its exact command pin over the owner channel and prints the validated outcome',async()=>{
 const fs=await import('node:fs');const{startLocalOwnerControl}=await import('../lib/hub-machine/local-control');const{hubIdentity,saveEnrollment}=await import('../lib/hub-machine/config');const stateDir=fs.mkdtempSync(process.platform==='darwin'?'/private/tmp/owner-settle-cli-':path.join(tmpdir(),'owner-settle-cli-'));dirs.push(stateDir);const hubId=hubIdentity('https://hub.example');saveEnrollment(stateDir,{hubUrl:'https://hub.example',machineId:'m',secret:'s'.repeat(43)});
 const value={kind:'settled-crashed-command' as const,commandId:'command-1',sessionId:'session-1',command:'submit-message',outcome:'unknown' as const,receipt:{status:'not-applied' as const,errorCode:'recovery-required' as const},resubmit:'if-absent' as const};
 const seen:unknown[]=[];let reply:unknown={ok:true,value};const server=await startLocalOwnerControl({configDir:stateDir,handle:async request=>{seen.push(request);return reply as never;}});
 try{const logs:string[]=[];const settle=(args:string[])=>hubMachineCommand(['recover','--hub',hubId,'--action','settle-crashed-command',...args],{stateDir,write:s=>logs.push(s)});
  await expect(settle(['--command','command-1'])).rejects.toThrow('Required --request-id');
  await expect(settle(['--request-id','settle-1'])).rejects.toThrow('Required --command');
  await expect(settle(['--command','command-1','--run','run-1','--request-id','settle-1'])).rejects.toThrow('invalid-local-request');
  await expect(settle(['--command','bad command','--request-id','settle-1'])).rejects.toThrow();
  expect(seen).toEqual([]);
  await settle(['--command','command-1','--request-id','settle-1']);expect(JSON.parse(logs[0]!)).toEqual(value);
  // A reply that claims more than the contract allows (an unknown outcome name) never reaches the operator as a result.
  reply={ok:true,value:{...value,outcome:'probably-applied'}};await expect(settle(['--command','command-1','--request-id','settle-2'])).rejects.toThrow('invalid-local-response');
  expect(seen).toEqual([{v:1,hubId,requestId:'settle-1',operation:'settle-crashed-command',target:{commandId:'command-1'}},{v:1,hubId,requestId:'settle-2',operation:'settle-crashed-command',target:{commandId:'command-1'}}]);
 }finally{await server.stop();}
});
test('a stale daemon lock is released only once its recorded daemon is proven gone, never by its PID or age alone',async()=>{
 const fs=await import('node:fs');const{hubIdentity,saveEnrollment,acquireMachineDaemon}=await import('../lib/hub-machine/config');const{MachineLedger}=await import('../lib/hub-machine/ledger');const{readProcessIdentity}=await import('../lib/hub-machine/process-identity');
 const stateDir=dir();saveEnrollment(stateDir,{hubUrl:'https://hub.example',machineId:'m',secret:'s'.repeat(43)});const hubId=hubIdentity('https://hub.example');const lockFile=path.join(machineStateDir(stateDir,hubId),'daemon.lock');
 const release=async()=>{const logs:string[]=[];await hubMachineCommand(['recover','--hub',hubId,'--action','release-stale-daemon'],{stateDir,write:s=>logs.push(s)});return JSON.parse(logs[0]!) as {kind:string;state:string;daemonId?:string};};
 expect(await release()).toEqual({kind:'daemon-lock',state:'absent'});
 // A real daemon process holds the lock; it is then SIGKILLed, exactly as a serve crash leaves the lock behind.
 const daemon=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'});
 try{const lock=acquireMachineDaemon(stateDir,hubId);const identity=readProcessIdentity(daemon.pid)!;const ledger=new MachineLedger(path.join(machineStateDir(stateDir,hubId),'control.sqlite'));try{ledger.recordDaemon({daemonId:'crashed-daemon',lockNonce:lock.nonce,...identity});}finally{ledger.close();}
  await expect(hubMachineCommand(['recover','--hub',hubId,'--action','release-stale-daemon','--run','x'],{stateDir})).rejects.toThrow('invalid-local-request');
  await expect(release()).rejects.toThrow('daemon-live');expect(fs.existsSync(lockFile)).toBe(true);
  daemon.kill('SIGKILL');await daemon.exited;
  expect(await release()).toEqual({kind:'daemon-lock',state:'released',daemonId:'crashed-daemon'});expect(fs.existsSync(lockFile)).toBe(false);
  // A lock whose writer recorded no identity is never released: absence cannot be proven.
  acquireMachineDaemon(stateDir,hubId);await expect(release()).rejects.toThrow('recovery-required');expect(fs.existsSync(lockFile)).toBe(true);
 }finally{daemon.kill('SIGKILL');await daemon.exited;}
});
