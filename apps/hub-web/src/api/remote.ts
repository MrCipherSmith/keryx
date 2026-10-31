import { versionedJson } from './client';
export type { Control } from '../../../../src/remote-control/protocol';
export const remoteGet=<T,>(path:string,signal?:AbortSignal)=>versionedJson<T>('v2',path,'GET',undefined,signal);
export const remoteMutate=<T,>(method:'POST'|'PUT'|'PATCH'|'DELETE',path:string,body:unknown)=>versionedJson<T>('v2',path,method,body);
export const remoteProject=(projectId:string)=>'/projects/'+encodeURIComponent(projectId);
