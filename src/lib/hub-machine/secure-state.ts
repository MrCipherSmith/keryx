import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MachineError } from './errors';
function own(stat:{uid:number;mode:number},mode:number):void{if((process.getuid&&stat.uid!==process.getuid())||(stat.mode&mode)!==0)throw new MachineError('unsafe-config-path');}
/** No symlink ancestor is traversed when creating protected state. */
export function ensurePrivateDirectory(dir:string):void{
 const absolute=path.resolve(dir);let current=path.parse(absolute).root;
 for(const piece of absolute.slice(current.length).split(path.sep)){
  if(!piece)continue;current=path.join(current,piece);
  try{const st=lstatSync(current);if(st.isSymbolicLink()||!st.isDirectory())throw new MachineError('unsafe-config-path');}
  catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause;mkdirSync(current,{mode:0o700});}
 }
 const stat=lstatSync(absolute);own(stat,0o077);
}
export function protectedRead(file:string,maxBytes:number):string{
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const st=fstatSync(fd);own(st,0o077);if(!st.isFile()||st.size>maxBytes)throw new MachineError('unsafe-config-size');return readFileSync(fd,'utf8');}finally{closeSync(fd);}
}
export function protectedWrite(file:string,value:string,exclusive=false):void{
 ensurePrivateDirectory(path.dirname(file));const temp=exclusive?file:`${file}.${randomUUID()}.tmp`;
 const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}
 if(!exclusive)renameSync(temp,file);
}
export function ownerLock(dir:string,name:string):{nonce:string;release():void}{
 ensurePrivateDirectory(dir);const file=path.join(dir,name);const nonce=randomUUID();
 try{protectedWrite(file,nonce,true);}catch(cause){if((cause as NodeJS.ErrnoException).code==='EEXIST')throw new MachineError('machine-busy',{cause});throw cause;}
 return {nonce,release(){if(protectedRead(file,128)!==nonce)throw new MachineError('lease-owner-mismatch');unlinkSync(file);}};
}
export const canonicalLocalPath=(file:string)=>realpathSync(file);
export function validateProtectedFile(file:string,maxBytes:number):void{const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);own(stat,0o077);if(!stat.isFile()||stat.size>maxBytes)throw new MachineError('unsafe-config-size');}finally{closeSync(fd);}}
