/** Isolated full-CLI/resource staging for the native production smoke, not a release.
 * bun scripts/smoke/package-native-candidate.ts --out /absolute/new-directory
 * Never changes the checkout's dependency tree. Coverage descriptor remains a release gate.
 */
import { cp, mkdir, readdir, lstat, copyFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
const root=resolve(import.meta.dir,'../..');
if(process.argv.length!==4||process.argv[2]!=='--out'||!process.argv[3]!.startsWith('/'))throw new Error('Usage: package-native-candidate --out /absolute/new-directory');
const output=resolve(process.argv[3]!);
if(output===root||output.startsWith(root+'/'))throw new Error('Candidate staging must be outside the checkout');
// The compiled CLI embeds src/session/native-coverage.generated.ts. A missing, stale or tampered descriptor is refused before anything is staged.
const coverage=Bun.spawn([process.execPath,'--no-env-file','scripts/verify-native-coverage.ts','--check'],{cwd:root,env:{PATH:process.env.PATH??''},stdout:'inherit',stderr:'inherit'});
if(await coverage.exited!==0)throw new Error('Refusing to stage a native candidate without a current validated native coverage descriptor');
await mkdir(output);await mkdir(join(output,'bin'));await mkdir(join(output,'dist'));
// Opt-in only (KERYX_STAGING_OFFLINE=1): install exclusively from the operator's existing local package cache and never touch the
// network (`bun install --offline`, Bun 1.4 or newer). By default staging installs exactly as before.
const offline=process.env.KERYX_STAGING_OFFLINE==='1';
const cache:Record<string,string>=offline?{BUN_INSTALL_CACHE_DIR:process.env.BUN_INSTALL_CACHE_DIR??join(process.env.HOME??'','.bun/install/cache')}:{};
async function run(args:string[],cwd:string){const child=Bun.spawn([process.execPath,...args],{cwd,env:{PATH:process.env.PATH??'',HOME:output,...cache},stdout:'inherit',stderr:'inherit'});if(await child.exited!==0)throw new Error('Candidate staging command failed: '+args[0]);}
async function safeTree(path:string):Promise<void>{for(const entry of await readdir(path,{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('Refusing symlink in candidate resources');if(entry.isDirectory())await safeTree(join(path,entry.name));}}
for(const file of ['package.json','bun.lock','LICENSE','THIRD_PARTY_NOTICES.md']){if(!(await lstat(join(root,file))).isFile())throw new Error('Candidate input must be a regular file');await copyFile(join(root,file),join(output,file));}
for(const path of ['docs/requirements/shared-agent-context/schemas','src/gdgraph','src/gdskills/bundled','src/gdskills/contracts']){await safeTree(join(root,path));await mkdir(dirname(join(output,path)),{recursive:true});await cp(join(root,path),join(output,path),{recursive:true,filter:source=>!source.endsWith('.test.ts')});}
await run(['install','--frozen-lockfile','--production','--ignore-scripts',...(offline?['--offline']:[])],output);
const external=['--external','@modelcontextprotocol/sdk','--external','web-tree-sitter','--external','@opentui/core'];
await run(['build','src/cli.ts','--compile','--outfile',join(output,'bin/keryx'),...external],root);
await run(['build','src/harness/process/sandbox/proxy-worker.ts','--target','bun','--outfile',join(output,'dist/proxy-worker.js')],root);
// The compiled executable must validate its own embedded descriptor without the checkout; not-ready is reported, never upgraded.
const probe=Bun.spawn([join(output,'bin/keryx'),'hub','machine','readiness'],{cwd:output,env:{PATH:join(output,'bin'),HOME:output},stdout:'pipe',stderr:'pipe'});
const readiness=(await new Response(probe.stdout).text()).trim().split('\n').at(-1)??'';await probe.exited;
if(!readiness.startsWith('{')||(JSON.parse(readiness) as {descriptorValid?:unknown}).descriptorValid!==true)throw new Error('Compiled candidate did not validate its embedded native coverage descriptor');
console.log('NATIVE COVERAGE (embedded): '+readiness);
console.log('STAGED: isolated full CLI and npm-listed resources for native smoke only: '+output);
