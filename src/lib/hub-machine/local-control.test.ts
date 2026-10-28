import {expect,test} from 'bun:test';
import {chmodSync,lstatSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const hubId='a'.repeat(64);
const inspect={v:1 as const,requestId:'request-1',operation:'inspect' as const,hubId};
const inspected={kind:'inspection' as const,hubId,machineId:'m',ledgerId:'ledger',daemonId:'daemon',sessions:[],unresolved:[],recoveryClaims:[],uncertainRuns:[],truncated:false};
function root(){return mkdtempSync(path.join(realpathSync(tmpdir()),'owner-rpc-'));}
test('owner control uses a real protected Unix socket and rejects token-shaped extra fields before dispatch',async()=>{
 const api=await import('./local-control');const dir=root();let calls=0;try{const server=await api.startLocalOwnerControl({configDir:dir,handle:async()=>{calls++;return{ok:true,value:inspected};}});try{expect(lstatSync(api.localControlPath(dir)).isSocket()).toBe(true);expect(lstatSync(api.localControlPath(dir)).mode&0o777).toBe(0o600);expect(await api.requestLocalOwnerControl(dir,inspect)).toEqual({ok:true,value:inspected});expect(calls).toBe(1);expect((await api.requestLocalOwnerControl(dir,{...inspect,Authorization:'Bearer synthetic-machine-secret'})).ok).toBe(false);expect(calls).toBe(1);}finally{await server.stop();}expect(()=>lstatSync(api.localControlPath(dir))).toThrow();}finally{rmSync(dir,{recursive:true,force:true});}
});
test('owner RPC never replaces pre-existing endpoints and cleanup cannot unlink a substituted inode',async()=>{
 const api=await import('./local-control');const dir=root();try{const file=api.localControlPath(dir);writeFileSync(file,'pre-existing',{mode:0o600});await expect(api.startLocalOwnerControl({configDir:dir,handle:async()=>({ok:true,value:inspected})})).rejects.toThrow('local-control-busy');expect(readFileSync(file,'utf8')).toBe('pre-existing');rmSync(file);const server=await api.startLocalOwnerControl({configDir:dir,handle:async()=>({ok:true,value:inspected})});rmSync(file);writeFileSync(file,'substituted',{mode:0o600});await expect(server.stop()).rejects.toThrow('local-control-owner-mismatch');expect(readFileSync(file,'utf8')).toBe('substituted');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('client refuses unsafe parent permissions and symlink endpoints without invoking the owner',async()=>{
 const api=await import('./local-control');const dir=root(),outside=root();try{symlinkSync(path.join(outside,'socket'),api.localControlPath(dir));expect((await api.requestLocalOwnerControl(dir,inspect)).ok).toBe(false);rmSync(api.localControlPath(dir));chmodSync(dir,0o755);expect((await api.requestLocalOwnerControl(dir,inspect)).ok).toBe(false);await expect(api.startLocalOwnerControl({configDir:dir,handle:async()=>({ok:true,value:inspected})})).rejects.toThrow('unsafe-config-path');}finally{rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('a separate owner process accepts only bounded local requests and drains its own socket',async()=>{
 const api=await import('./local-control');const dir=root();const script=`import {startLocalOwnerControl} from ${JSON.stringify(path.join(import.meta.dir,'local-control.ts'))};const server=await startLocalOwnerControl({configDir:${JSON.stringify(dir)},handle:async()=>({ok:true,value:${JSON.stringify(inspected)}})});console.log('ready');process.on('SIGTERM',async()=>{await server.stop();process.exit(0);});await new Promise(()=>{});`;const child=Bun.spawn([process.execPath,'--no-env-file','--config=/dev/null','--eval',script],{stdout:'pipe',stderr:'pipe'});try{const reader=child.stdout.getReader();const ready=await reader.read();expect(new TextDecoder().decode(ready.value)).toContain('ready');expect(await api.requestLocalOwnerControl(dir,inspect)).toEqual({ok:true,value:inspected});expect((await api.requestLocalOwnerControl(dir,{...inspect,requestId:'x'.repeat(20000)})).ok).toBe(false);}finally{child.kill('SIGTERM');await child.exited;rmSync(dir,{recursive:true,force:true});}
});
