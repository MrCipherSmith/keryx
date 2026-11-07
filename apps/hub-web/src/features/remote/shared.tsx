import { useQuery, useQueryClient } from '@tanstack/react-query';
import { remoteGet,remoteMutate } from '../../api/remote';
import { useEffect,useRef,useState,type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useHub } from '../../app/hub-context';
import { useDraft } from '../../state/drafts';
import { ApiError,errorMessage } from '../../api/client';
import { useRemoteAction,useRemoteQuery,sessionPath } from '../../api/remote-hooks';
import type { Control } from '../../api/remote';
import { advanceKnownRenewals,renewalEdge,type RenewalEdge } from './safe-renewal';
import { Button,EmptyState,Notice } from '../../components/ui';
export function Feedback({query}:{query:{isPending:boolean;error:unknown;refetch:()=>unknown}}){const{t}=useTranslation('common');return query.isPending?<EmptyState>{t('loading')}</EmptyState>:query.error?<Notice tone="error">{errorMessage(query.error,t)} <Button onClick={()=>void query.refetch()}>{t('retry')}</Button></Notice>:null;}
export function TechnicalDetails({value}:{value:unknown}){const{t}=useTranslation('remote');return <details className="min-w-0 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm">{t('technicalDetails')}</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(value,null,2)}</pre></details>;}
export function ReceiptStatus({status}:{status:string}){const{t}=useTranslation('remote');return <p role="status" className="text-sm font-semibold">{t('receiptStatuses.'+status,{defaultValue:t('receipt')})}</p>;}
export function ActionFeedback({action}:{action:{error:unknown;data?:unknown;isPending:boolean}}){const{t}=useTranslation('remote');const data=action.data&&typeof action.data==='object'?action.data as Record<string,unknown>:null;return <>{action.error!=null&&<Notice tone="error">{errorMessage(action.error)} {action.error instanceof ApiError&&action.error.status===409&&t('stale')}</Notice>}{action.isPending&&<Notice>{t('pending')}</Notice>}{data&&typeof data.status==='string'&&<ReceiptStatus status={data.status}/>} {data&&typeof data.effectiveFromTurnOrdinal==='number'&&<p className="text-sm">{t('nextTurn')}: {data.effectiveFromTurnOrdinal}</p>}{action.data!==undefined&&<TechnicalDetails value={action.data}/>}</>;}
export function Definition({label,children}:{label:string;children:ReactNode}){return <div className="min-w-0"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 break-all text-sm text-slate-800">{children}</dd></div>;}
export function useOperator(){const{principal}=useHub();return principal.kind==='human'&&principal.role==='operator';}
export function useController(record:Control['SessionRecord']){
 const hub=useHub();const operator=useOperator();const path=sessionPath(record.projectId,record.sessionId);const action=useRemoteAction<Control['ControllerReceipt']>();
 const client=useQueryClient();
 const[control,setControl]=useDraft<{lease:Control['ControllerLease']|null;renewals?:RenewalEdge[];claim?:{operationId:string;beforeVersion:number;sessionVersion:number}}>(`remote-controller:${hub.scopeKey}:${record.projectId}:${record.sessionId}`,{lease:null});const[now,setNow]=useState(Date.now());const[failed,setFailed]=useState(false);const[pendingRenewal,setPendingRenewal]=useState<{before:Control['SessionRecord'];receipt:Control['ControllerReceipt']}|null>(null);const latest=useRef(record);latest.current=record;const updateControl=useRef(setControl);updateControl.current=setControl;
 const proof=useRemoteQuery<Control['SessionEventPage']>(['renewal-proof',record.sessionId,pendingRenewal?.receipt.receiptId],path+'/events?after='+(pendingRenewal?.before.sessionEventCursor??0),!!pendingRenewal&&record.version>=pendingRenewal.receipt.sessionVersion&&record.sessionEventCursor>=pendingRenewal.before.sessionEventCursor+2);
 useEffect(()=>{if(!pendingRenewal||!proof.data)return;const edge=renewalEdge(pendingRenewal.before,pendingRenewal.receipt,proof.data);if(edge)updateControl.current(previous=>({...previous,renewals:[...(previous.renewals??[]).filter(e=>e.receiptId!==edge.receiptId),edge].slice(-128)}));setPendingRenewal(null);},[pendingRenewal,proof.data]);
 const lease=control.lease;
 const leaseLive=operator&&!failed&&lease?.state==='held'&&Date.parse(lease.expiresAt)>now;
 const claimToVerify=leaseLive&&control.claim&&control.claim.sessionVersion>control.claim.beforeVersion ? control.claim : undefined;
 const outcome=useQuery({
  queryKey:[hub.scopeKey,record.projectId,'remote','controller-claim',claimToVerify?.operationId],
  queryFn:({signal})=>remoteGet<{applied:boolean}>(path+'/controller-claims/'+claimToVerify!.operationId,signal),
  enabled:!!claimToVerify,
  staleTime:Infinity,
  retry:false,
  refetchInterval:query=>query.state.error||query.state.data?.applied ? false : 1000,
 });
 const applied=outcome.data?.applied===true;
 const active=leaseLive&&(!claimToVerify||applied)&&record.controller?.controllerLeaseId===lease.controllerLeaseId&&record.controller.version===lease.version;
 const binding:Control['ControllerBinding']|null=active&&lease?{controllerLeaseId:lease.controllerLeaseId,expectedControllerVersion:lease.version}:null;
 const pendingClaim=!!claimToVerify&&!outcome.error&&!active;
 useEffect(()=>{
  if(!claimToVerify||!applied) return;
  void client.invalidateQueries({queryKey:[hub.scopeKey,record.projectId,'remote','session',record.sessionId],exact:true});
 },[client,hub.scopeKey,record.projectId,record.sessionId,claimToVerify,applied]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{
  if(!active||!lease)return;
  const abort=new AbortController();
  const heldLease=lease;
  const expiresAt=Date.parse(heldLease.expiresAt);
  let due=Math.min(Date.now()+20000,expiresAt-10000);
  let timer:ReturnType<typeof setTimeout>;
  let running=false;
  let refresh=false;
  let before:Control['SessionRecord']|undefined;
  const schedule=()=>{timer=setTimeout(()=>void renew(),Math.max(0,due-Date.now()));};
  async function renew(){
   if(running||abort.signal.aborted||Date.now()>=expiresAt)return;
   clearTimeout(timer);
   if(Date.now()<due){schedule();return;}
   running=true;
   try{
    if(refresh){before=await remoteGet<Control['SessionRecord']>(path,abort.signal);refresh=false;}
    if(abort.signal.aborted||Date.now()>=expiresAt)return;
    before??=latest.current;
    const current=before.controller;
    if(current?.state!=='held'||current.controllerLeaseId!==heldLease.controllerLeaseId||
      current.version!==heldLease.version||current.actorId!==heldLease.actorId||Date.parse(current.expiresAt)<=Date.now()){
     setFailed(true);
     return;
    }
    const receipt=await remoteMutate<Control['ControllerReceipt']>('POST',path+'/controller/renew',{
     expectedSessionVersion:before.version,expectedControllerVersion:heldLease.version,requestedLeaseSeconds:60,
     mode:'renew',controllerLeaseId:heldLease.controllerLeaseId,
    } satisfies Control['ControllerClaim']);
    if(abort.signal.aborted)return;
    updateControl.current(previous=>({...previous,lease:receipt.lease}));
    setPendingRenewal({before,receipt});
    void client.invalidateQueries({queryKey:[hub.scopeKey,record.projectId,'remote']});
   }catch(error){
    if(abort.signal.aborted)return;
    // A rejected compare-and-swap needs current pins. An uncertain transport result reuses the original request.
    if(error instanceof ApiError&&['stale-version','session-busy','machine-offline'].includes(error.code)){
     refresh=true;
     before=undefined;
    }else if(!(error instanceof ApiError&&(error.status===0||error.status===429||error.status>=500))){
     setFailed(true);
     return;
    }
    due=Date.now()+2000;
    if(due<expiresAt)schedule();
   }finally{running=false;}
  }
  const onVisible=()=>{if(document.visibilityState==='visible')void renew();};
  schedule();
  document.addEventListener('visibilitychange',onVisible);
  window.addEventListener('online',onVisible);
  return()=>{abort.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('online',onVisible);};
 },[active,lease,path,client,hub.scopeKey,record.projectId]);
 function claim() {
  if (pendingClaim && !outcome.error) return;
  setFailed(false);
  const claimPath=path+'/controller/claim';
  const key=crypto.randomUUID();
  action.mutate({
   path:claimPath,operationId:key,
   body:{expectedSessionVersion:record.version,expectedControllerVersion:record.controller?.version??0,requestedLeaseSeconds:60,mode:'claim'} satisfies Control['ControllerClaim'],
  },{onSuccess:receipt=>setControl({lease:receipt.lease,renewals:[],claim:{operationId:key,beforeVersion:record.version,sessionVersion:receipt.sessionVersion}})});
 }

 function release(){if(!binding)return;action.mutate({path:path+'/controller/release',body:{expectedSessionVersion:record.version,controller:binding} satisfies Control['ControllerRelease']},{onSuccess:()=>setControl({lease:null,renewals:[]})});}
 function takeover(receipt:Control['ControllerReceipt']){if(!operator||receipt.lease.state!=='released'||receipt.lease.controllerLeaseId!==record.controller?.controllerLeaseId||receipt.lease.version!==record.controller.version)return;setFailed(false);action.mutate({path:path+'/controller/claim',body:{expectedSessionVersion:record.version,expectedControllerVersion:receipt.lease.version,requestedLeaseSeconds:60,mode:'takeover',previousReleaseReceiptId:receipt.receiptId} satisfies Control['ControllerClaim']},{onSuccess:next=>setControl({lease:next.lease,renewals:[]})});}
 function recover(proof:Control['ReconciliationReceipt']){const age=Date.now()-Date.parse(proof.receivedAt);const current=record.controller;if(!operator||!current||current.state==='released'||Date.parse(current.expiresAt)>Date.now()||proof.observation!=='confirmed-stopped'||proof.sessionId!==record.sessionId||proof.machineId!==record.machineId||proof.checkoutId!==record.checkoutId||proof.projectId!==record.projectId||age< -5000||age>30000)return;setFailed(false);action.mutate({path:path+'/controller/claim',body:{expectedSessionVersion:record.version,expectedControllerVersion:current.version,requestedLeaseSeconds:60,mode:'takeover',previousReleaseReceiptId:proof.reconciliationId} satisfies Control['ControllerClaim']},{onSuccess:next=>setControl({lease:next.lease,renewals:[]})});}
 const advanceVersion = (base:number) => {
  const claim = control.claim;
  const appliedClaim = claim && active && claim.beforeVersion === base && claim.sessionVersion === base + 1;
  const advanced = advanceKnownRenewals(appliedClaim ? claim.sessionVersion : base,record,control.renewals??[]);
  return advanced === record.version ? advanced : base;
 };
 return{binding,active,claim,release,takeover,recover,action,failed,operator,advanceVersion,claimPending:pendingClaim,claimError:outcome.error};
}
export type Controller=ReturnType<typeof useController>;
export async function digestCriteria(criteria:string[]){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(criteria)));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
