/** Sanitized local failures; neither messages nor causes are serialized to Hub. */
export class MachineError extends Error {
 constructor(readonly code:string,options?:ErrorOptions){super(code,options);this.name='MachineError';}
}
export type MachineResult<T>={ok:true;value:T}|{ok:false;error:MachineError};
export function machineFailure(cause:unknown,fallback='machine-state-unavailable'):MachineError{return cause instanceof MachineError?cause:new MachineError(fallback,{cause});}
const aborted=(cause:unknown):boolean=>cause instanceof Error&&cause.name==='AbortError';
/**
 * Notice code for a bridge failure. A transport abort is never a generic state failure: during
 * stop() it is the shutdown race (`machine-stopping`); otherwise an in-flight Hub request died with
 * its connection (`machine-request-aborted`). A Hub request the network refused or reset is typed where it is made
 * (`machine-request-failed`, `MachineConnection.request`). Anything else unclassified keeps the generic fallback.
 */
export function machineNoticeCode(cause:unknown,stopping:boolean):string{
 if(cause instanceof MachineError)return cause.code;
 if(aborted(cause))return stopping?'machine-stopping':'machine-request-aborted';
 return machineFailure(cause).code;
}
