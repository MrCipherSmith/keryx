import { ApiError, versionedJson, type NativeWorkHint } from './client';
export type { Control } from '../../../../src/remote-control/protocol';
export const remoteGet=<T,>(path:string,signal?:AbortSignal)=>versionedJson<T>('v2',path,'GET',undefined,signal);
export const remoteMutate=<T,>(method:'POST'|'PUT'|'PATCH'|'DELETE',path:string,body:unknown,transport?:{operationId?:string;workHint?:NativeWorkHint})=>{
 if(transport?.workHint){
  const association=typeof body==='object'&&body!==null&&'association'in body?body.association:null;
  const valid=method==='POST'&&/^\/projects\/[^/]+\/sessions\/[^/]+\/messages$/.test(path)&&typeof association==='object'&&association!==null&&'mode'in association&&association.mode==='ad-hoc'&&'profileConsentVersion'in association&&Number.isSafeInteger(association.profileConsentVersion)&&Number(association.profileConsentVersion)>0&&typeof transport.operationId==='string'&&transport.operationId.length>0&&/^[\x20-\x7e]{1,200}$/.test(transport.workHint.attemptId)&&Number.isSafeInteger(transport.workHint.attemptVersion)&&transport.workHint.attemptVersion>0;
  if(!valid)throw new ApiError(400,'managed-association-conflict','Managed Attempt requires original ad-hoc message and explicit consent');
 }
 return versionedJson<T>('v2',path,method,body,undefined,transport);
};
export const remoteProject=(projectId:string)=>'/projects/'+encodeURIComponent(projectId);
