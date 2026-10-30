import { test, expect } from 'bun:test';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hub-package-test-'));
  async function put(path: string, body = '// fixture\n') { await mkdir(join(root, path, '..'), {recursive:true}); await writeFile(join(root,path),body); }
  await put('scripts/package-team-hub.ts', await readFile(new URL('./package-team-hub.ts',import.meta.url),'utf8'));
  await put('scripts/build-hub-web.ts', '// fixture freshness gate\n');
  for (const file of ['src/flow/machine.ts','src/flow/types.ts','src/lib/git-revision.ts','src/commands/hub.ts','scripts/smoke/team-hub.ts','scripts/smoke/team-hub-remote.ts','LICENSE','src/hub/main.ts','src/hub/remote-v2/index.ts','src/remote-control/protocol.ts','src/remote-control/owned-controls.ts','src/remote-control/generated/types.ts','src/remote-control/generated/validators.js','src/remote-control/generated/validators.d.ts','src/remote-control/generated/manifest.json','docs/requirements/hub-remote-sessions/schemas/control-api.schema.json','apps/hub-web/public/icon.svg','apps/hub-web/src/features/remote/very-long-portable-component-name-for-release-testing.tsx']) await put(file);
  for (const directory of ['docs/requirements/hub-mcp','docs/requirements/hub-context-watch/schemas','docs/requirements/hub-react-frontend','docs/requirements/team-hub-prototype','deploy/team-hub/runtime']) await mkdir(join(root,directory),{recursive:true});
  await put('deploy/team-hub/runtime/package.json','{"dependencies":{"@modelcontextprotocol/sdk":"1.32.1"}}'); await put('deploy/team-hub/runtime/bun.lock','fixture');
  return {root,put,run:async()=>{const p=Bun.spawn([process.execPath,'scripts/package-team-hub.ts','--out',join(root,'release')],{cwd:root,stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH??'',SOURCE_DATE_EPOCH:'0'}}); const error=await new Response(p.stderr).text(); return {code:await p.exited,error};}};
}
function paths(archive: Buffer) { const bytes=gunzipSync(archive); const paths:string[]=[]; for(let at=0;at+512<=bytes.length;){ const h=bytes.subarray(at,at+512); const name=h.subarray(0,100).toString().split('\0')[0]!; if(!name)break;const prefix=h.subarray(345,500).toString().split('\0')[0]!;paths.push(prefix?prefix+'/'+name:name);const size=parseInt(h.subarray(124,136).toString().replace(/\0/g,''),8);at+=512+Math.ceil(size/512)*512;} return paths; }
test('archive includes nested closed protocol runtime, portable long paths, no tests or secrets, and is deterministic',async()=>{const f=await fixture();try{await f.put('src/hub/remote-v2/secret.env','must not ship');await f.put('src/hub/remote-v2/index.test.ts','must not ship');expect(await f.run()).toEqual({code:0,error:''});const first=await readFile(join(f.root,'release/team-hub-prototype-source.tar.gz'));const names=paths(first);for(const p of ['src/hub/remote-v2/index.ts','src/remote-control/generated/validators.js','src/remote-control/generated/manifest.json','docs/requirements/hub-remote-sessions/schemas/control-api.schema.json'])expect(names).toContain('team-hub-prototype/'+p);expect(names.some(p=>p.includes('very-long-portable'))).toBe(true);expect(names.some(p=>p.endsWith('.test.ts')||p.endsWith('.env'))).toBe(false);expect((await f.run()).code).toBe(0);expect(await readFile(join(f.root,'release/team-hub-prototype-source.tar.gz'))).toEqual(first);}finally{await rm(f.root,{recursive:true,force:true});}});
/** Archive entries with their bodies, read the way the packager writes them (USTAR prefix + name). */
function entries(archive: Buffer) { const bytes=gunzipSync(archive); const files=new Map<string,string>(); for(let at=0;at+512<=bytes.length;){ const h=bytes.subarray(at,at+512); const name=h.subarray(0,100).toString().split('\0')[0]!; if(!name)break;const prefix=h.subarray(345,500).toString().split('\0')[0]!;const size=parseInt(h.subarray(124,136).toString().replace(/\0/g,''),8);files.set((prefix?prefix+'/'+name:name).replace(/^team-hub-prototype\//,''),bytes.subarray(at+512,at+512+size).toString('utf8'));at+=512+Math.ceil(size/512)*512;} return files; }
test('every runtime relative import of a packaged module resolves inside the real archive, so the extracted Hub can start',async()=>{
 // The real checkout's allowlist, not a fixture: a production module that imports a file the allowlist omits ships a Hub that cannot start.
 // Type-only imports are erased before execution, so they are not runtime inputs of the archive.
 const out=await mkdtemp(join(tmpdir(),'hub-package-closure-'));
 try{const p=Bun.spawn([process.execPath,'scripts/package-team-hub.ts','--out',out],{cwd:join(import.meta.dir,'..'),stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH??'',SOURCE_DATE_EPOCH:'0'}});expect(await p.exited).toBe(0);
  const files=entries(await readFile(join(out,'team-hub-prototype-source.tar.gz')));const missing:string[]=[];
  for(const [file,text] of files){if(!/\.(?:ts|tsx|js|mjs)$/.test(file))continue;for(const m of text.replace(/\b(?:import|export)\s+type\s+[^;]*?\bfrom\s*["'][^"']+["']/g,'').matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.\.?\/[^"']+)["'](?!\s*\)\.[A-Z])/g)){const target=posix.normalize(posix.join(posix.dirname(file),m[1]!));if(![target,target+'.ts',target+'.tsx',target+'.js',target+'/index.ts'].some(candidate=>files.has(candidate)))missing.push(`${file} -> ${m[1]}`);}}
  expect(missing).toEqual([]);
 }finally{await rm(out,{recursive:true,force:true});}
},120000);
test('the Docker image copies every runtime module Hub imports, so the built container can start',async()=>{
 // The Dockerfile COPY lines are a second allowlist beside the archive's: a module the archive ships but the image omits passes the archive check and still fails at container start.
 const repo=join(import.meta.dir,'..');const layout=await mkdtemp(join(tmpdir(),'hub-image-layout-'));
 try{for(const line of (await readFile(join(repo,'deploy/team-hub/Dockerfile'),'utf8')).split('\n')){const m=/^COPY\s+(?:--chown=\S+\s+)?(.+)$/.exec(line.trim());if(!m)continue;const sources=m[1]!.split(/\s+/);const destination=sources.pop()!;
   for(const source of sources){const target=sources.length>1||destination.endsWith('/')?join(layout,destination,posix.basename(source)):join(layout,destination);await mkdir(join(target,'..'),{recursive:true});await cp(join(repo,source),target,{recursive:true});}}
  const result=await Bun.build({entrypoints:[join(layout,'src/hub/main.ts')],target:'bun',packages:'external',throw:false});
  expect(result.logs.filter(log=>log.level==='error').map(log=>log.message)).toEqual([]);expect(result.success).toBe(true);
 }finally{await rm(layout,{recursive:true,force:true});}
},120000);
test('archive refuses symlink inputs even when extension would otherwise be ignored',async()=>{const f=await fixture();try{await symlink('/etc/passwd',join(f.root,'src/remote-control/leak'));const result=await f.run();expect(result.code).not.toBe(0);expect(result.error).toContain('symlink');}finally{await rm(f.root,{recursive:true,force:true});}});
test('standalone client bundles no native executor and refuses machine mode clearly',async()=>{const output=await Bun.build({entrypoints:[new URL('../src/hub/client-main.ts',import.meta.url).pathname],target:'bun'});expect(output.success).toBe(true);const code=await output.outputs[0]!.text();expect(code).not.toContain('assembleNativeSessionRuntime');const root=await mkdtemp(join(tmpdir(),'hub-standalone-test-'));try{await writeFile(join(root,'client.js'),code);const p=Bun.spawn([process.execPath,join(root,'client.js'),'machine','pair'],{env:{PATH:process.env.PATH??'',HOME:root},stdout:'pipe',stderr:'pipe'});const error=await new Response(p.stderr).text();expect(await p.exited).not.toBe(0);expect(error).toContain('full Keryx executor');}finally{await rm(root,{recursive:true,force:true});}});
