import { connect } from 'node:net';
import { assertPreparedRuntimeCache, createOfflineInstallGuard } from './hub-runtime-cache.test-support';
import { test, expect } from 'bun:test';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';

const WORK_SCHEMA_FILES = [
  'docs/requirements/hub-work-management/schemas/domain.schema.json',
  'docs/requirements/hub-work-management/schemas/command.schema.json',
  'docs/requirements/hub-work-management/schemas/event.schema.json',
];
const WORK_DOCS = ['docs/requirements/hub-work-management/openapi.json'];
const ACCEPTANCE_FILES=['docs/requirements/hub-flow-acceptance/specification.md',...['review-guide','review-report','legacy-review'].map(name=>`docs/requirements/hub-flow-acceptance/schemas/${name}.schema.json`)];
const WORK_RUNTIME_FILES = ['src/hub/work/domain.ts', 'src/hub/work/validation.ts'];
const WORK_RELEASE_FILES = [
  'scripts/smoke/team-hub-work.ts',
  'docs/handoffs/hub-work-management-runbook.md',
  ...WORK_SCHEMA_FILES,
  ...WORK_DOCS,
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hub-package-test-'));
  async function put(path: string, body = '// fixture\n') { await mkdir(join(root, path, '..'), {recursive:true}); await writeFile(join(root,path),body); }
  await put('scripts/package-team-hub.ts', await readFile(new URL('./package-team-hub.ts',import.meta.url),'utf8'));
  await put('scripts/build-hub-web.ts', '// fixture freshness gate\n');
  for (const file of ['src/flow/machine.ts','src/flow/types.ts','src/lib/git-revision.ts','src/commands/hub.ts','scripts/smoke/team-hub.ts','scripts/smoke/team-hub-remote.ts',...WORK_RELEASE_FILES,...ACCEPTANCE_FILES,'LICENSE','src/hub/main.ts','src/hub/remote-v2/index.ts',...WORK_RUNTIME_FILES,'src/remote-control/protocol.ts','src/remote-control/owned-controls.ts','src/remote-control/generated/types.ts','src/remote-control/generated/validators.js','src/remote-control/generated/validators.d.ts','src/remote-control/generated/manifest.json','docs/requirements/hub-remote-sessions/schemas/control-api.schema.json','apps/hub-web/public/icon.svg','apps/hub-web/src/features/remote/very-long-portable-component-name-for-release-testing.tsx']) await put(file);
  for (const directory of ['docs/requirements/hub-mcp','docs/requirements/hub-context-watch/schemas','docs/requirements/hub-react-frontend','docs/requirements/team-hub-prototype','deploy/team-hub/runtime']) await mkdir(join(root,directory),{recursive:true});
  await put('deploy/team-hub/runtime/package.json','{"dependencies":{"@modelcontextprotocol/sdk":"1.32.1"}}'); await put('deploy/team-hub/runtime/bun.lock','fixture');
  return {root,put,run:async()=>{const p=Bun.spawn([process.execPath,'scripts/package-team-hub.ts','--out',join(root,'release')],{cwd:root,stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH??'',SOURCE_DATE_EPOCH:'0'}}); const error=await new Response(p.stderr).text(); return {code:await p.exited,error};}};
}
function paths(archive: Buffer) { const bytes=gunzipSync(archive); const paths:string[]=[]; for(let at=0;at+512<=bytes.length;){ const h=bytes.subarray(at,at+512); const name=h.subarray(0,100).toString().split('\0')[0]!; if(!name)break;const prefix=h.subarray(345,500).toString().split('\0')[0]!;paths.push(prefix?prefix+'/'+name:name);const size=parseInt(h.subarray(124,136).toString().replace(/\0/g,''),8);at+=512+Math.ceil(size/512)*512;} return paths; }
test('archive includes nested closed protocol runtime, portable long paths, no tests or secrets, and is deterministic',async()=>{const f=await fixture();try{await f.put('src/hub/remote-v2/secret.env','must not ship');await f.put('src/hub/remote-v2/index.test.ts','must not ship');await f.put('src/hub/work/private.env','must not ship');await f.put('src/hub/work/domain.test.ts','must not ship');await f.put('docs/requirements/hub-work-management/schemas/private.json','must not ship');expect(await f.run()).toEqual({code:0,error:''});const first=await readFile(join(f.root,'release/team-hub-prototype-source.tar.gz'));const names=paths(first);for(const p of [...WORK_RELEASE_FILES,'src/hub/remote-v2/index.ts',...WORK_RUNTIME_FILES,'src/remote-control/generated/validators.js','src/remote-control/generated/manifest.json','docs/requirements/hub-remote-sessions/schemas/control-api.schema.json'])expect(names).toContain('team-hub-prototype/'+p);expect(names.some(p=>p.includes('very-long-portable'))).toBe(true);expect(names.some(p=>p.endsWith('.test.ts')||p.endsWith('.env')||p.endsWith('/private.json'))).toBe(false);expect((await f.run()).code).toBe(0);expect(await readFile(join(f.root,'release/team-hub-prototype-source.tar.gz'))).toEqual(first);}finally{await rm(f.root,{recursive:true,force:true});}});
test('archive includes only the approved Flow acceptance specification and closed guide review schemas',async()=>{
 const f=await fixture();try{
  await f.put('docs/requirements/hub-flow-acceptance/schemas/private.json','must not ship');
  expect(await f.run()).toEqual({code:0,error:''});
  const names=paths(await readFile(join(f.root,'release/team-hub-prototype-source.tar.gz')));
  for(const file of ACCEPTANCE_FILES)expect(names).toContain('team-hub-prototype/'+file);
  expect(names).not.toContain('team-hub-prototype/docs/requirements/hub-flow-acceptance/schemas/private.json');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
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
/** Ordered path-or-parent matching, as in moby/patternmatcher MatchesOrParentMatches.
 * https://github.com/moby/patternmatcher/blob/main/patternmatcher.go
 */
function dockerContextIncludes(path: string, patterns: string[]): boolean {
  const parts = path.split('/');
  const candidates = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  let included = true;
  for (const source of patterns) {
    const rule = source.trim();
    if (!rule || rule.startsWith('#')) continue;
    const negated = rule.startsWith('!');
    const pattern = (negated ? rule.slice(1) : rule).replace(/^\/+|\/+$/g, '');
    if (pattern && candidates.some(candidate => new Bun.Glob(pattern).match(candidate))) included = negated;
  }
  return included;
}

test('Docker context honors later exclusions rather than allowlist line membership', () => {
  const required = WORK_SCHEMA_FILES[0]!;
  const patterns = ['**', '!docs', '!docs/requirements', '!docs/requirements/hub-work-management',
    '!docs/requirements/hub-work-management/schemas', ...WORK_SCHEMA_FILES.map(path => '!' + path)];
  expect(dockerContextIncludes(required, patterns)).toBe(true);
  for (const exclusion of ['docs/**', 'docs/', 'docs']) {
    expect(dockerContextIncludes(required, [...patterns, exclusion])).toBe(false);
  }
  expect(dockerContextIncludes(required, [...patterns, 'docs/**', '!' + required])).toBe(true);
  // Docker inclusion of a directory also includes its descendants; do not apply Git's parent rule.
  expect(dockerContextIncludes('src/lib/git-revision.ts', ['**', '!src'])).toBe(true);
});

test('the Docker image copies every runtime module and schema after ordered context filtering', async () => {
  const repo = join(import.meta.dir, '..');
  const patterns = (await readFile(join(repo, 'deploy/team-hub/Dockerfile.dockerignore'), 'utf8')).split('\n');
  const layout = await mkdtemp(join(tmpdir(), 'hub-image-layout-'));
  async function copyInput(source: string, destination: string) {
    if (!dockerContextIncludes(source, patterns)) return;
    const info = await readdir(join(repo, source), { withFileTypes: true }).catch(() => null);
    if (info) {
      await mkdir(destination, { recursive: true });
      for (const entry of info) await copyInput(posix.join(source, entry.name), join(destination, entry.name));
    } else {
      await mkdir(join(destination, '..'), { recursive: true });
      await cp(join(repo, source), destination);
    }
  }
  try {
    for (const line of (await readFile(join(repo, 'deploy/team-hub/Dockerfile'), 'utf8')).split('\n')) {
      const match = /^COPY\s+(?:--chown=\S+\s+)?(.+)$/.exec(line.trim());
      if (!match) continue;
      const sources = match[1]!.split(/\s+/);
      const destination = sources.pop()!;
      for (const source of sources) {
        expect({ source, included: dockerContextIncludes(source, patterns) }).toEqual({ source, included: true });
        const target = sources.length > 1 || destination.endsWith('/')
          ? join(layout, destination, posix.basename(source)) : join(layout, destination);
        await copyInput(source, target);
      }
    }
    for (const path of [...WORK_SCHEMA_FILES, ...WORK_DOCS]) {
      expect(dockerContextIncludes(path, patterns)).toBe(true);
      expect(await readFile(join(layout, path), 'utf8')).toBe(await readFile(join(repo, path), 'utf8'));
    }
    const result = await Bun.build({ entrypoints: [join(layout, 'src/hub/main.ts')], target: 'bun', packages: 'external', throw: false });
    expect(result.logs.filter(log => log.level === 'error').map(log => log.message)).toEqual([]);
    expect(result.success).toBe(true);
  } finally {
    await rm(layout, { recursive: true, force: true });
  }
}, 120000);
test('archive refuses symlink inputs even when extension would otherwise be ignored',async()=>{const f=await fixture();try{await symlink('/etc/passwd',join(f.root,'src/remote-control/leak'));const result=await f.run();expect(result.code).not.toBe(0);expect(result.error).toContain('symlink');}finally{await rm(f.root,{recursive:true,force:true});}});
test('standalone client bundles no native executor and refuses machine mode clearly',async()=>{const output=await Bun.build({entrypoints:[new URL('../src/hub/client-main.ts',import.meta.url).pathname],target:'bun'});expect(output.success).toBe(true);const code=await output.outputs[0]!.text();expect(code).not.toContain('assembleNativeSessionRuntime');const root=await mkdtemp(join(tmpdir(),'hub-standalone-test-'));try{await writeFile(join(root,'client.js'),code);const p=Bun.spawn([process.execPath,join(root,'client.js'),'machine','pair'],{env:{PATH:process.env.PATH??'',HOME:root},stdout:'pipe',stderr:'pipe'});const error=await new Response(p.stderr).text();expect(await p.exited).not.toBe(0);expect(error).toContain('full Keryx executor');}finally{await rm(root,{recursive:true,force:true});}});
test.skipIf(!process.env.KERYX_HUB_RUNTIME_CACHE)('extracted allowlisted source installs its frozen runtime offline and serves managed work plus MCP from an isolated process',async()=>{
 const repo=join(import.meta.dir,'..'),isolated=await mkdtemp(join(tmpdir(),'hub-extracted-runtime-'));
 const guard=await createOfflineInstallGuard();
 const environment={PATH:process.env.PATH??'',HOME:join(isolated,'home'),TMPDIR:isolated,SOURCE_DATE_EPOCH:'0',BUN_INSTALL_CACHE_DIR:join(isolated,'cache')};
 async function run(command:string[],cwd:string,extraEnv:Record<string,string>={}){const child=Bun.spawn(command,{cwd,env:{...environment,...extraEnv},stdout:'pipe',stderr:'pipe'});const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {code,stdout,stderr};}
 try{
  await mkdir(environment.HOME,{recursive:true});const packaged=await run([process.execPath,'scripts/package-team-hub.ts','--out',join(isolated,'release')],repo);expect(packaged.code).toBe(0);
  const archive=join(isolated,'release/team-hub-prototype-source.tar.gz');expect((await run(['tar','-xzf',archive,'-C',isolated],isolated)).code).toBe(0);const source=join(isolated,'team-hub-prototype');
  // Only an explicitly prepared isolated cache is accepted. Ordinary tests never
  // populate it from npm, and this install is always offline.
  await assertPreparedRuntimeCache(process.env.KERYX_HUB_RUNTIME_CACHE!,join(source,'bun.lock'));
  await cp(process.env.KERYX_HUB_RUNTIME_CACHE!,environment.BUN_INSTALL_CACHE_DIR,{recursive:true});
  expect(await readdir(source)).not.toContain('node_modules');
  const install=await run([process.execPath,'install','--frozen-lockfile','--production','--ignore-scripts','--offline'],source,guard.environment);expect({code:install.code,stderr:install.stderr}).toEqual({code:0,stderr:expect.any(String)});expect(guard.connections()).toBe(0);
  const smoke=await run([process.execPath,'scripts/smoke/team-hub.ts'],source);expect({code:smoke.code,stderr:smoke.stderr}).toEqual({code:0,stderr:expect.any(String)});expect(smoke.stdout).toContain('managed work metadata and authenticated MCP');
 }finally{await guard.close();await rm(isolated,{recursive:true,force:true});}
},120000);

test('missing isolated runtime cache is refused before any installer can use the network or host caches',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-offline-missing-cache-'));
 try{await expect(assertPreparedRuntimeCache(root,join(import.meta.dir,'../deploy/team-hub/runtime/bun.lock'))).rejects.toThrow('Pinned runtime dependency is not cached');}
 finally{await rm(root,{recursive:true,force:true});}
});
test('runtime proof refuses URL or git lock sources before a registry override can be bypassed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-offline-lock-source-'));
 try{for(const resolved of ['https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz','git+ssh://git@example.test/pkg']){
  const lockfile=join(root,'bun.lock');await writeFile(lockfile,JSON.stringify({packages:{pkg:['pkg@1.0.0',resolved,{}]}}));
  await expect(assertPreparedRuntimeCache(root,lockfile)).rejects.toThrow('Only default-registry frozen runtime dependencies');
 }}finally{await rm(root,{recursive:true,force:true});}
});

test('offline proxy guard rejects CONNECT attempts and overrides both proxy bypass variants',async()=>{
 const guard=await createOfflineInstallGuard();
 try{
  const endpoint=new URL(guard.environment.HTTPS_PROXY);
  await new Promise<void>(resolve=>{const socket=connect(Number(endpoint.port),endpoint.hostname);socket.on('error',()=>{});socket.once('connect',()=>socket.write('CONNECT registry.invalid:443 HTTP/1.1\r\n\r\n'));socket.once('close',()=>resolve());});
  expect(guard.connections()).toBe(1);
  const inherited=Object.assign({NO_PROXY:'*',no_proxy:'*'},guard.environment);
  expect(inherited.NO_PROXY).toBe('');expect(inherited.no_proxy).toBe('');
  for(const key of ['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'] as const)expect(guard.environment[key]).toBe(endpoint.toString().replace(/\/$/,''));
 }finally{await guard.close();}
});
