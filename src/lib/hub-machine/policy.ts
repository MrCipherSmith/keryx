import {existsSync} from 'node:fs';import path from 'node:path';
import {parseClosedJson,validateControl,type Control} from '../../remote-control/protocol';
import {acquireMachineDaemon,loadEnrollment,machineStateDir} from './config';
import {MachineError} from './errors';import {protectedRead,protectedWrite} from './secure-state';
export function readMachinePolicy(dir:string,hubId:string):Control['LocalMachinePolicy']|null{
 const file=path.join(machineStateDir(dir,hubId),'policy.json');if(!existsSync(file))return null;const parsed=parseClosedJson(protectedRead(file,65536));if(!parsed.ok)throw new MachineError('invalid-policy');const checked=validateControl('LocalMachinePolicy',parsed.value);if(!checked.ok||checked.value.hubId!==hubId)throw new MachineError('invalid-policy');return checked.value;
}
export function writeMachinePolicy(dir:string,value:unknown):void{
 const checked=validateControl('LocalMachinePolicy',value);if(!checked.ok)throw new MachineError('invalid-policy');const policy=checked.value;const e=loadEnrollment(dir,policy.hubId);if(!e)throw new MachineError('not-paired');
 if(policy.checkouts.some(c=>!e.mappings.some(m=>m.projectId===c.projectId&&m.checkoutId===c.checkoutId&&m.cwd===c.path&&c.profileIds.every(p=>p===m.profileId))))throw new MachineError('invalid-policy');
 const lock=acquireMachineDaemon(dir,e.hubId);try{protectedWrite(path.join(machineStateDir(dir,e.hubId),'policy.json'),JSON.stringify(policy));}finally{lock.release();}
}
