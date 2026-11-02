import {useEffect,useRef,useState} from 'react';
import type {HubFlow,LegacyCriterionRef} from '../../api/types';
import {ApiError,getClientScope,versionedJson} from '../../api/client';
import {useHub} from '../../app/hub-context';
import {pendingScope,usePending} from '../../state/pending';
import type {DecisionInput,DecisionOutcome} from './model';

type ReturnBody={expectedVersion:number;subjectRevisionId:string;comment:string;criterionRefs:LegacyCriterionRef[]};
type AcceptBody={expectedVersion:number;subjectRevisionId:string;acknowledgeSelfReportedEvidence:true};
type Original={operationId:string;projectId:string;flowId:string;subjectRevisionId:string;specContentDigest:string;expectedVersion:number;criterionCount:number;reviewerId:string;decision:'accept'|'request-changes';body:ReturnBody|AcceptBody};
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).sort().join(',')===[...names].sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&Array.from(v).every(char=>char.charCodeAt(0)>=32);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
function validOriginal(v:unknown):v is Original {
 if(!object(v)||!keys(v,['operationId','projectId','flowId','subjectRevisionId','specContentDigest','expectedVersion','criterionCount','reviewerId','decision','body'])||!id(v.operationId)||!id(v.projectId)||!id(v.flowId)||!id(v.subjectRevisionId)||!id(v.reviewerId)||typeof v.specContentDigest!=='string'||!/^[a-f0-9]{64}$/.test(v.specContentDigest)||!positive(v.expectedVersion)||!Number.isSafeInteger(v.criterionCount)||Number(v.criterionCount)<0||Number(v.criterionCount)>200||!object(v.body))return false;
 const b=v.body;
 if(b.expectedVersion!==v.expectedVersion||b.subjectRevisionId!==v.subjectRevisionId)return false;
 if(v.decision==='accept')return keys(b,['expectedVersion','subjectRevisionId','acknowledgeSelfReportedEvidence'])&&b.acknowledgeSelfReportedEvidence===true;
 if(v.decision!=='request-changes'||!keys(b,['expectedVersion','subjectRevisionId','comment','criterionRefs'])||typeof b.comment!=='string'||!b.comment.trim()||b.comment!==b.comment.trim()||b.comment.length>4000||!Array.isArray(b.criterionRefs)||b.criterionRefs.length>20)return false;
 const positions=new Set<number>();
 for(const ref of b.criterionRefs){if(!object(ref)||!keys(ref,['specContentDigest','position'])||ref.specContentDigest!==v.specContentDigest||!positive(ref.position)||ref.position>Number(v.criterionCount)||positions.has(ref.position))return false;positions.add(ref.position);}
 return true;
}
function committed(value:unknown,original:Original):boolean {
 if(!object(value))return false;
 if(original.decision==='accept')return value.id===original.flowId&&value.projectId===original.projectId&&value.subjectRevisionId===original.subjectRevisionId&&value.specContentDigest===original.specContentDigest&&value.status==='done'&&value.version===original.expectedVersion+1&&value.acceptedBy===original.reviewerId&&object(value.receipt)&&value.receipt.actorId===original.reviewerId&&id(value.receipt.id);
 const d=value.decision,b=original.body;
 return 'criterionRefs'in b&&value.status==='committed'&&value.operationId===original.operationId&&value.flowState==='in-progress'&&value.flowVersion===original.expectedVersion+1&&object(d)&&id(d.id)&&d.flowId===original.flowId&&d.subjectRevisionId===original.subjectRevisionId&&d.specContentDigest===original.specContentDigest&&d.actorId===original.reviewerId&&d.actorKind==='human'&&typeof d.createdAt==='string'&&Number.isFinite(Date.parse(d.createdAt))&&d.comment===b.comment&&JSON.stringify(d.criterionRefs)===JSON.stringify(b.criterionRefs);
}
/** Only unresolved exact envelopes persist. A later CAS/auth refusal cannot disprove a lost original response. */
export function useLegacyDecision(flow:HubFlow,onCommitted:()=>void){
 const hub=useHub(),subject=flow.subjectRevisionId??flow.reviewFeedback?.subjectRevisionId??'';
 const scope=pendingScope(window.location.origin,hub.projectId??'','legacy',flow.id,subject,flow.specContentDigest,hub.principal.id);
 const pending=usePending(scope,validOriginal,v=>v),busy=useRef(false),current=useRef(scope);current.current=scope;
 const mounted=useRef(true),callback=useRef(onCommitted);callback.current=onCommitted;
 const [notice,setNotice]=useState<{scope:string;code?:string}>({scope});
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const allowed=()=>hub.projectId===flow.projectId&&hub.principal.kind==='human'&&(hub.principal.role==='operator'||hub.principal.role==='reviewer')&&!hub.principal.readOnly&&(!hub.principal.projectIds||hub.principal.projectIds.includes(flow.projectId));
 const authority=useRef(false),identityScope=useRef(hub.scopeKey);authority.current=allowed();identityScope.current=hub.scopeKey;
 const show=(code?:string)=>{if(current.current===scope)setNotice({scope,...(code?{code}:{})});};
 const execute=async(mode:'send'|'check'|'retry',value:Original):Promise<DecisionOutcome>=>{
  if(busy.current)return {status:'unknown',code:'pending'};
  if(!allowed())return {status:mode==='send'?'rejected':'unknown',code:'human-required'};
  if(pending.error)return {status:'unknown',code:'pending-storage'};
  if(!validOriginal(value)||value.projectId!==flow.projectId||value.flowId!==flow.id||value.subjectRevisionId!==subject||value.specContentDigest!==flow.specContentDigest||value.reviewerId!==hub.principal.id)return {status:'rejected',code:'invalid-request'};
  if(!pending.put(value)){show('pending-storage');return {status:'unknown',code:'pending-storage'};}
  busy.current=true;const generation=getClientScope();show();
  const unchanged=()=>mounted.current&&current.current===scope&&generation===getClientScope()&&authority.current&&identityScope.current===hub.scopeKey;
  const path=`/projects/${encodeURIComponent(value.projectId)}/flows/${encodeURIComponent(value.flowId)}`;
  let result:unknown;
  try {
   result=mode==='check'
    ?await versionedJson<unknown>('v1',`${path}/review-operations/${encodeURIComponent(value.operationId)}`,'GET')
    :await versionedJson<unknown>('v1',`${path}/${value.decision==='accept'?'accept':'request-changes'}`,'POST',value.body,undefined,{operationId:value.operationId});
  }catch(error){
   if(!unchanged())return {status:'unknown',code:'scope-changed'};
   if(mode==='send'&&error instanceof ApiError&&error.status>=400&&error.status<500){
    if(!pending.put(null)){show('pending-storage');return {status:'unknown',code:'pending-storage'};}
    show(error.code);return {status:'rejected',code:error.code};
   }
   const code=error instanceof ApiError?error.code:'unknown';show(code);return {status:'unknown',code};
  }finally{busy.current=false;}
  if(!unchanged())return {status:'unknown',code:'scope-changed'};
  if(!committed(result,value)){show('invalid-response');return {status:'unknown',code:'invalid-response'};}
  if(!pending.put(null)){show('pending-storage');return {status:'unknown',code:'pending-storage'};}
  show();callback.current();return {status:'committed'};
 };
 const run=async(input:DecisionInput):Promise<DecisionOutcome>=>{
  if(pending.value||busy.current)return {status:'unknown',code:'pending'};
  if(flow.status!=='implemented'||!flow.subjectRevisionId)return {status:'rejected',code:'invalid-transition'};
  const criterionRefs:LegacyCriterionRef[]=[];
  if(input.decision==='request-changes'){
   if(!input.comment.trim()||input.comment.trim().length>4000)return {status:'rejected',code:'invalid-comment'};
   if(input.criterionIds.length>20||new Set(input.criterionIds).size!==input.criterionIds.length)return {status:'rejected',code:'invalid-criterion-ref'};
   for(const criterion of input.criterionIds){const match=/^legacy:([a-f0-9]{64}):([1-9][0-9]*)$/.exec(criterion),position=Number(match?.[2]);if(!match||match[1]!==flow.specContentDigest||position>flow.criteria.length)return {status:'rejected',code:'invalid-criterion-ref'};criterionRefs.push({specContentDigest:flow.specContentDigest,position});}
  }
  const body:ReturnBody|AcceptBody=input.decision==='accept'?{expectedVersion:flow.version,subjectRevisionId:flow.subjectRevisionId,acknowledgeSelfReportedEvidence:true}:{expectedVersion:flow.version,subjectRevisionId:flow.subjectRevisionId,comment:input.comment.trim(),criterionRefs};
  return execute('send',{operationId:crypto.randomUUID(),projectId:flow.projectId,flowId:flow.id,subjectRevisionId:flow.subjectRevisionId,specContentDigest:flow.specContentDigest,expectedVersion:flow.version,criterionCount:flow.criteria.length,reviewerId:hub.principal.id,decision:input.decision,body});
 };
 return {run,check:()=>pending.value?execute('check',pending.value):Promise.resolve<DecisionOutcome>({status:'rejected',code:'operation-not-found'}),retry:()=>pending.value?execute('retry',pending.value):Promise.resolve<DecisionOutcome>({status:'rejected',code:'operation-not-found'}),pending:!!pending.value||pending.error,...(pending.error?{code:'pending-storage'}:notice.scope===scope&&notice.code?{code:notice.code}:{})};
}
