import i18next, { type TFunction } from 'i18next';
export class ApiError extends Error {
 constructor(public status:number,public code:string,message:string){super(message);this.name='ApiError';}
}
let generation=0;
let controller=new AbortController();
let onAuthLoss:(error:ApiError)=>void=()=>undefined;
const operations=new Map<string,string>();
export function setAuthLossHandler(handler:(error:ApiError)=>void){onAuthLoss=handler;}
export function resetClient(){controller.abort();controller=new AbortController();generation++;operations.clear();return generation;}
export function getClientScope(){return generation;}
function lost(error:ApiError){if(error.status===401||(error.status===403&&error.code==='access-denied'))onAuthLoss(error);}
function aborted(){return new DOMException('Session changed','AbortError');}
async function request<T>(path:string,method:string,body?:unknown,signal?:AbortSignal,version:'v1'|'v2'='v1'):Promise<T>{
 if(!path.startsWith('/')||path.startsWith('//'))throw new ApiError(400,'invalid-path','Invalid API path');
 const scope=generation;const serialized=body===undefined?undefined:JSON.stringify(body);
 const op=JSON.stringify([scope,version,method,path,serialized]);const headers=new Headers({'X-Requested-With':'XMLHttpRequest'});
 if(serialized!==undefined)headers.set('Content-Type','application/json');
 if(method!=='GET'){let key=operations.get(op);if(!key){key=crypto.randomUUID();if(operations.size>=100)throw new ApiError(429,'pending-operation-limit','Too many unresolved operations');operations.set(op,key);}headers.set('Idempotency-Key',key);}
 let response:Response;
 try{response=await fetch('/hub/'+version+path,{method,headers,credentials:'same-origin',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000),...(signal?[signal]:[])]),...(serialized===undefined?{}:{body:serialized})});}
 catch(error){if(scope!==generation||controller.signal.aborted||signal?.aborted)throw aborted();if(error instanceof DOMException&&error.name==='AbortError')throw error;throw new ApiError(0,'network-error','Request could not be completed');}
 if(scope!==generation)throw aborted();
 let result:unknown;
 try{result=await response.json();}catch{const authResponse=response.status===401||(response.status<400&&(response.redirected||response.headers.get('content-type')?.includes('text/html')));const error=new ApiError(authResponse?401:response.status>=500?response.status:502,authResponse?'access-login-required':'invalid-response','Unreadable server response');lost(error);throw error;}
 if(scope!==generation)throw aborted();
 if(!response.ok){
  const detail=typeof result==='object'&&result!==null&&'error'in result?result.error:undefined;
  const value=typeof detail==='object'&&detail!==null?detail as Record<string,unknown>:{};
  const error=new ApiError(response.status,typeof value.code==='string'?value.code:'request-failed',typeof value.message==='string'?value.message:'Request failed');
  if(response.status<500)operations.delete(op);lost(error);throw error;
 }
 operations.delete(op);return result as T;
}
export function getJson<T>(path:string,signal?:AbortSignal){return request<T>(path,'GET',undefined,signal);}
export function postJson<T>(path:string,body:unknown){return request<T>(path,'POST',body);}
export function deleteJson<T>(path:string){return request<T>(path,'DELETE');}
export function errorMessage(error:unknown,t:TFunction=i18next.t.bind(i18next)):string{
 if(error instanceof ApiError){const key='errors.'+error.code;return String(t(key,{ns:'common',defaultValue:t('errors.unknown',{ns:'common'})}))+' ('+error.code+')';}
 return String(t('errors.unknown',{ns:'common'}));
}

/** Versioned APIs share identity invalidation, CSRF headers and uncertain-operation keys. */
export function versionedJson<T>(version:'v1'|'v2',path:string,method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',body?:unknown,signal?:AbortSignal){return request<T>(path,method,body,signal,version);}

export function invalidateAuthentication(){onAuthLoss(new ApiError(401,'access-login-required','Authentication must be renewed'));}
