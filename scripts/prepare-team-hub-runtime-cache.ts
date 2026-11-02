/** Explicit network integration preparation; never called by the ordinary test suite. */
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

const args=process.argv.slice(2);
if(args.length!==3||args[0]!=='--allow-network'||args[1]!=='--cache'||!args[2]||!isAbsolute(args[2])){
 console.error('Usage: bun scripts/prepare-team-hub-runtime-cache.ts --allow-network --cache <absolute-empty-directory>');
 process.exit(2);
}
const cache=args[2];
await mkdir(cache,{recursive:true,mode:0o700});
if((await readdir(cache)).length)throw new Error('Runtime integration cache must be empty; use a new private directory');
const root=await mkdtemp(join(tmpdir(),'hub-runtime-cache-preparation-'));
try{
 await mkdir(join(root,'home'));
 for(const file of ['package.json','bun.lock'])await cp(join(import.meta.dir,'../deploy/team-hub/runtime',file),join(root,file));
 const child=Bun.spawn([process.execPath,'install','--frozen-lockfile','--production','--ignore-scripts'],{cwd:root,env:{PATH:process.env.PATH??'',HOME:join(root,'home'),TMPDIR:root,BUN_INSTALL_CACHE_DIR:cache},stdout:'inherit',stderr:'inherit',timeout:120000});
 const code=await child.exited;if(code!==0)throw new Error('Pinned runtime cache preparation failed: '+code);
 console.log('Prepared isolated runtime cache. Set KERYX_HUB_RUNTIME_CACHE to your --cache directory and run bun test scripts/package-team-hub.test.ts.');
}finally{await rm(root,{recursive:true,force:true});}
