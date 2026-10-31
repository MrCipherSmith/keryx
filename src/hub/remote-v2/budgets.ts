import {LIMITS} from '../../remote-control/protocol';
export type RemoteBudgets={pendingBytes:number;stagingBytes:number;activeRuns:number};
export const DEFAULT_REMOTE_BUDGETS:Readonly<RemoteBudgets>=Object.freeze({pendingBytes:128*1024*1024,stagingBytes:128*1024*1024,activeRuns:1000});
export const PROFILE_STAGING_BYTES=(1000+128+2)*LIMITS.frameBytes;
export const MAX_STORED_COMMAND_BYTES=2*LIMITS.frameBytes;
export function remoteBudgets(input:Partial<RemoteBudgets>={}):Readonly<RemoteBudgets>{const result={...DEFAULT_REMOTE_BUDGETS,...input};for(const value of Object.values(result))if(!Number.isSafeInteger(value)||value<1)throw new TypeError('Remote budgets must be positive safe integers');if(result.activeRuns>100000)throw new TypeError('Remote active-work budget exceeds retained identity bound');return Object.freeze(result);}
export function remoteBudgetsFromEnv(env:Record<string,string|undefined>):Readonly<RemoteBudgets>|undefined{
 const values:Partial<RemoteBudgets>={};
 for(const [field,name] of [['pendingBytes','KERYX_HUB_REMOTE_PENDING_BYTES'],['stagingBytes','KERYX_HUB_REMOTE_STAGING_BYTES'],['activeRuns','KERYX_HUB_REMOTE_ACTIVE_RUNS']] as const){const raw=env[name];if(raw===undefined)continue;if(!/^[0-9]+$/.test(raw))throw new TypeError(`Invalid ${name}`);values[field]=Number(raw);}
 return Object.keys(values).length?remoteBudgets(values):undefined;
}
