import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveEnrollment, loadEnrollment, allowCheckout, machineConfigPath, removeEnrollment } from './config';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true }); });
function dir() { const d = mkdtempSync(path.join(tmpdir(), 'machine-config-')); dirs.push(d); return d; }
test('pair persists an owner-only secret separately from public mapping and grants no checkout', () => {
    const d = dir();
    saveEnrollment(d, { hubUrl: 'https://hub.example', machineId: 'machine-a', secret: 's'.repeat(43) });
    const enrollment = loadEnrollment(d)!;
    expect(enrollment.mappings).toEqual([]);
    expect(statSync(enrollment.secretPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(enrollment.secretPath)).mode & 0o777).toBe(0o700);
    expect(readFileSync(machineConfigPath(d), 'utf8')).not.toContain('s'.repeat(43));
});
test('remote public plaintext endpoints and credential-bearing URLs are refused', () => {
    for (const hubUrl of ['http://hub.example', 'https://u:p@hub.example', 'https://hub.example/?token=x'])
        expect(() => saveEnrollment(dir(), { hubUrl, machineId: 'machine-a', secret: 's'.repeat(43) })).toThrow();
});
test('local allowance requires a canonical Git checkout and never silently replaces a mapping', () => {
    const d = dir();
    saveEnrollment(d, { hubUrl: 'https://hub.example', machineId: 'machine-a', secret: 's'.repeat(43) });
    expect(() => allowCheckout(d, { projectId: 'p', checkoutId: 'c', cwd: dir(), profileId: 'native' })).toThrow('checkout');
});
test('configuration parent symlinks are refused', () => {
    const d = dir(), outside = dir();
    require('node:fs').symlinkSync(outside, path.join(d, 'machine'));
    expect(() => saveEnrollment(d, { hubUrl: 'https://hub.example', machineId: 'machine-a', secret: 's'.repeat(43) })).toThrow('unsafe');
});
test('world-readable enrollment parent refuses before credential reads', () => {
    const d = dir();
    saveEnrollment(d, { hubUrl: 'https://hub.example', machineId: 'machine-a', secret: 's'.repeat(43) });
    require('node:fs').chmodSync(path.dirname(machineConfigPath(d)), 0o755);
    expect(() => loadEnrollment(d)).toThrow('unsafe');
});
test('two Hub enrollments use separate protected directories, credentials and ledger identities; selection is explicit', async () => {
 const {hubIdentity,machineStateDir,listEnrollments}=await import('./config');
 const {MachineLedger}=await import('./ledger'); const d=dir();
 saveEnrollment(d,{hubUrl:'https://hub-a.example',machineId:'a',secret:'a'.repeat(43)});
 saveEnrollment(d,{hubUrl:'https://hub-b.example',machineId:'b',secret:'b'.repeat(43)});
 const a=loadEnrollment(d,hubIdentity('https://hub-a.example'))!; const b=loadEnrollment(d,hubIdentity('https://hub-b.example'))!;
 expect(listEnrollments(d)).toHaveLength(2);expect(a.secretPath).not.toBe(b.secretPath);expect(()=>loadEnrollment(d)).toThrow('hub-selection-required');
 expect(machineStateDir(d,a.hubId)).toBe(path.join(d,'hub-machines',a.hubId));
 const la=new MachineLedger(path.join(machineStateDir(d,a.hubId),'control.sqlite')); const lb=new MachineLedger(path.join(machineStateDir(d,b.hubId),'control.sqlite'));expect(la.ledgerId).not.toBe(lb.ledgerId);la.close();lb.close();
});
test('closed enrollment schema rejects nested unknown keys and duplicate checkout identities',()=>{
 const d=dir();saveEnrollment(d,{hubUrl:'https://hub.example',machineId:'machine-a',secret:'s'.repeat(43)});const file=machineConfigPath(d);const value=JSON.parse(readFileSync(file,'utf8'));value.mappings=[{projectId:'p',checkoutId:'c',cwd:'/tmp',profileId:'native',shell:'sh'}];require('node:fs').writeFileSync(file,JSON.stringify(value));expect(()=>loadEnrollment(d)).toThrow('invalid-enrollment');
});
test('live daemon ownership excludes allowance and unpair changes across processes',async()=>{
 const {acquireMachineDaemon}=await import('./config');const d=dir();saveEnrollment(d,{hubUrl:'https://hub.example',machineId:'machine-a',secret:'s'.repeat(43)});const config=loadEnrollment(d)!;const daemon=acquireMachineDaemon(d,config.hubId);expect(()=>allowCheckout(d,{projectId:'p',checkoutId:'c',cwd:dir(),profileId:'native'},config.hubId)).toThrow('machine-busy');expect(()=>require('./config').removeEnrollment(d,config.hubId)).toThrow('machine-busy');daemon.release();
});
test('unsafe owner-global state root is refused before writing any Hub credential',()=>{const d=dir();require('node:fs').chmodSync(d,0o777);expect(()=>saveEnrollment(d,{hubUrl:'https://hub.example',machineId:'m',secret:'s'.repeat(43)})).toThrow('unsafe-config-path');});
test('unsupported unshipped legacy state refuses every enrollment selection without changing old bytes or activating transport',async()=>{
 const fs=await import('node:fs');const{createHash}=await import('node:crypto');const{listEnrollments,hubIdentity,pairEnrollment}=await import('./config');const{startConfiguredMachineBridges}=await import('./startup');const{MachineLedger}=await import('./ledger');const dir=mkdtempSync(path.join(tmpdir(),'machine-legacy-refusal-'));try{const old=path.join(dir,'machine');fs.mkdirSync(old,{mode:0o700});fs.writeFileSync(path.join(old,'config.json'),'{"version":1,"unarchived":true}',{mode:0o600});fs.writeFileSync(path.join(old,'secret'),'synthetic-legacy-secret',{mode:0o600});const ledger=new MachineLedger(path.join(old,'control.sqlite'));ledger.claim({hubId:'old',commandId:'old-command',digest:'a'.repeat(64),runId:'old-run',checkoutId:'old-checkout'});ledger.markStarting('old','old-command','old-daemon');ledger.close();const files=['config.json','secret','control.sqlite'];const before=files.map(file=>createHash('sha256').update(fs.readFileSync(path.join(old,file))).digest('hex'));const id=hubIdentity('https://hub.example');expect(()=>listEnrollments(dir)).toThrow('legacy-enrollment-migration-required');expect(()=>loadEnrollment(dir,id)).toThrow('legacy-enrollment-migration-required');expect(()=>removeEnrollment(dir,id)).toThrow('legacy-enrollment-migration-required');let consumed=false;await expect(pairEnrollment(dir,'https://hub.example',async()=>{consumed=true;return{machineId:'new',secret:'s'.repeat(43)};})).rejects.toThrow('legacy-enrollment-migration-required');expect(consumed).toBe(false);const notices:string[]=[];const startup=await startConfiguredMachineBridges({configDir:dir,onNotice:code=>notices.push(code)});expect(startup.count).toBe(0);expect(notices).toContain('legacy-enrollment-migration-required');await startup.stop();expect(files.map(file=>createHash('sha256').update(fs.readFileSync(path.join(old,file))).digest('hex'))).toEqual(before);expect(fs.readdirSync(dir)).toEqual(['machine']);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('allowance inspects the explicit checkout independently of ambient Git discovery overrides',()=>{
 const d=dir(),cwd=dir(),foreign=dir();saveEnrollment(d,{hubUrl:'https://hub.example',machineId:'machine-a',secret:'s'.repeat(43)});expect(Bun.spawnSync(['git','init','-q',cwd]).exitCode).toBe(0);const script=`import {allowCheckout} from ${JSON.stringify(path.join(import.meta.dir,'config.ts'))};allowCheckout(${JSON.stringify(d)},${JSON.stringify({projectId:'p',checkoutId:'c',cwd,profileId:'native'})});`;const child=Bun.spawnSync([process.execPath,'--no-env-file','--config=/dev/null','--eval',script],{env:{...process.env,GIT_DIR:path.join(foreign,'missing.git')}});expect(child.exitCode).toBe(0);expect(loadEnrollment(d)!.mappings[0]!.cwd).toBe(cwd);
});
