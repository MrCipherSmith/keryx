import type { Control } from './remote';
const resources=new Set(['machine','run','approval','context','session','history','queue','command-catalogue','config','controller']);
export const INVALIDATION_KEYS=256;
export function parseInvalidation(raw:unknown,projectId:string):Control['BrowserInvalidation']|null {
 if(typeof raw!=='string'||new TextEncoder().encode(raw).length>65536)return null;
 let value:unknown;try{value=JSON.parse(raw);}catch{return null;}
 if(!value||typeof value!=='object'||Array.isArray(value))return null;const f=value as Record<string,unknown>;
 const keys=Object.keys(f).sort().join(',');if(keys!=='projectId,resource,resourceId,type,v,version'||f.v!==2||f.type!=='resource-changed'||f.projectId!==projectId||typeof f.resource!=='string'||!resources.has(f.resource)||typeof f.resourceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(f.resourceId)||!Number.isSafeInteger(f.version)||Number(f.version)<0)return null;
 return f as Control['BrowserInvalidation'];
}
/** Eviction triggers reconciliation, never application of old delta data. */
export class InvalidationWindow {
 private readonly versions=new Map<string,number>();
 get size(){return this.versions.size;}
 admit(frame:Control['BrowserInvalidation']){const key=frame.resource+':'+frame.resourceId;if(frame.version<=(this.versions.get(key)??-1))return false;if(!this.versions.has(key)&&this.versions.size>=INVALIDATION_KEYS)this.versions.clear();this.versions.set(key,frame.version);return true;}
}
export class InvalidationBatch {
 private readonly frames=new Map<string,Control['BrowserInvalidation']>();
 private overflow=false;
 add(frame:Control['BrowserInvalidation']){const key=frame.resource+':'+frame.resourceId;if(!this.frames.has(key)&&this.frames.size>=INVALIDATION_KEYS){this.overflow=true;return;}this.frames.set(key,frame);}
 take(scopeKey:number,projectId:string){const frames=[...this.frames.values()];const overflow=this.overflow;this.frames.clear();this.overflow=false;const changed=new Set(frames.map(f=>f.resource+':'+f.resourceId));const kinds=new Set(frames.map(f=>f.resource));
  return (key:readonly unknown[])=>{
   if(key[0]!==scopeKey||key[1]!==projectId)return false;if(kinds.has('context'))return true;if(key[2]!=='remote')return false;if(overflow)return true;
   const kind=key[3];const id=String(key[4]??'');const has=(resource:string)=>changed.has(resource+':'+id);const session=has('session');
   if(kind==='machines')return kinds.has('machine');if(kind==='runs')return kinds.has('run')||kinds.has('approval');if(kind==='run'||kind==='run-events')return has('run')||has('approval');if(kind==='sessions')return kinds.has('session')||kinds.has('controller');
   if(kind==='session')return session||has('history')||has('queue')||has('config')||has('controller');if(kind==='history')return session||has('history');if(kind==='queue')return session||has('queue');if(kind==='routing')return session||has('config')||has('command-catalogue');if(kind==='catalogue')return has('command-catalogue');if(kind==='controller-release'||kind==='renewal-proof')return session||has('controller');if(kind==='operation')return session||has('config')||has('queue')||has('history')||has('command-catalogue');return false;
  };
 }
}
