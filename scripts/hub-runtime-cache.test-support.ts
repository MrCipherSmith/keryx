import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, basename, join, relative, isAbsolute } from 'node:path';

/** Accept only registry-default, exact frozen pins; explicit URL/git sources could bypass a loopback registry. */
export async function assertPreparedRuntimeCache(cache: string, lockfile: string): Promise<void> {
 const text=await readFile(lockfile,'utf8');
 if(/https?:\/\/|git\+|ssh:\/\//.test(text))throw new Error('Only default-registry frozen runtime dependencies are permitted');
 const raw:unknown=JSON.parse(text.replace(/,\s*([}\]])/g,'$1'));
 if(!raw||typeof raw!=='object'||!('packages'in raw)||!raw.packages||typeof raw.packages!=='object'||Array.isArray(raw.packages))throw new Error('Invalid frozen runtime lock');
 for(const[key,entry]of Object.entries(raw.packages)){
  if(!Array.isArray(entry)||typeof entry[0]!=='string'||entry[1]!=='')throw new Error('Only default-registry frozen runtime dependencies are permitted: '+key);
  const at=entry[0].lastIndexOf('@'),name=entry[0].slice(0,at),version=entry[0].slice(at+1);
  if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)||!/^(@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name))throw new Error('Invalid frozen runtime dependency: '+name);
  const parent=dirname(join(cache,name)),prefix=basename(name)+'@'+version+'@@@';
  const candidates=await readdir(parent).catch(()=>[]);
  let found=false;
  for(const file of candidates.filter(file=>file.startsWith(prefix))){
   const path=await realpath(join(parent,file)),outside=relative(await realpath(cache),path);
   if(outside.startsWith('..')||isAbsolute(outside))throw new Error('Runtime cache entry escapes its private directory');
   const metadata=JSON.parse(await readFile(join(path,'package.json'),'utf8'));
   if(metadata.name===name&&metadata.version===version){found=true;break;}
  }
  if(!found)throw new Error('Pinned runtime dependency is not cached: '+name+'@'+version);
 }
}
