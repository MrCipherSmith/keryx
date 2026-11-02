import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDraft } from '../../state/drafts';
import { Button, Field, Textarea } from '../../components/ui';
import { returnReason, type DecisionInput, type DecisionOutcome, type ReviewCriterion } from './model';
export type ReviewDecisionProps={scope:string;targetKey:string;subjectKey?:string;criteria:ReviewCriterion[];effect:'effectIntent'|'effectFlow'|'effectLegacy';acceptAllowed:boolean;returnAllowed:boolean;blockedReason?:string;readonly?:'acceptedReadonly'|'doneReadonly'|'returnedReadonly';legacy?:boolean;pending?:boolean;pendingCode?:string;pendingDecision?:"accept"|"request-changes";onDecision:(input:DecisionInput)=>Promise<DecisionOutcome|undefined>;onCheck?:()=>Promise<DecisionOutcome|undefined>;onRetry?:()=>Promise<DecisionOutcome|undefined>;refresh:()=>void;extraActions?:ReactNode};
/** The draft key pins the reviewed subject; a changed target never silently retargets it. */
export function DecisionControls(props:ReviewDecisionProps){
 const {t}=useTranslation('acceptance');
 const [pinnedTarget,setPinned]=useState(props.targetKey);
 const [pinnedSubject,setPinnedSubject]=useState(props.subjectKey??props.targetKey);
 const [comment,setComment,clearComment]=useDraft(props.scope+':'+pinnedSubject+':comment','');
 const [personal,setPersonal]=useDraft(props.scope+':'+pinnedSubject+':personal','');
 const [refs,setRefs]=useDraft<string[]>(props.scope+':'+pinnedSubject+':refs',[]);
 const [mode,setMode]=useState<'accept'|'request-changes'|null>(null);
 const [ack,setAck]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const [waivers,setWaivers]=useState<Record<string,string>>({}),[waived,setWaived]=useState<string[]>([]);
 const commentRef=useRef<HTMLTextAreaElement>(null),statusRef=useRef<HTMLParagraphElement>(null),inFlight=useRef(false),current=useRef(props.subjectKey??props.targetKey);current.current=props.subjectKey??props.targetKey;
 const submittedComment=useRef<{target:string;value:string}|null>(null);
 const stale=!props.readonly&&(pinnedTarget!==props.targetKey||error==='stale');
 const reason=props.legacy?comment.trim():returnReason(comment,refs);
 const waiverCriteria=props.criteria.filter(row=>row.waivable&&row.status!=='reportedPass');
 const waiverMissing=waiverCriteria.some(row=>!waived.includes(row.id)||!waivers[row.id]?.trim()||waivers[row.id]!.length>4000);
 const unknown=(props.pending&&!busy&&props.pendingCode!=='sending')||error==='unknown';
 const disabled=busy||!!props.pending||!!unknown||stale;
 useEffect(()=>{if(notice)statusRef.current?.focus();},[notice]);
 const outcome=(result:DecisionOutcome|undefined,action:'accept'|'request-changes')=>{
  if(result?.status==='committed'){setError(null);setNotice(action==='accept'?'accepted':'returned');setMode(null);if(submittedComment.current?.target===current.current)clearComment(submittedComment.current.value);submittedComment.current=null;setAck(false);return;}
  if(result?.status==='rejected'){setError(['stale-version','subject-changed','version-conflict','invalid-transition','stale-context'].includes(result.code??'')?'stale':result.code==='forbidden'||result.code==='human-required'?'permission':result.code==='pending-storage'?'pendingStorage':'blocked');return;}
  setError('unknown');
 };
 const submit=async()=>{
  if(!mode||disabled||inFlight.current)return;
  if(mode==='request-changes'&&(!comment.trim()||reason.length>4000||refs.length>20)){setError('commentInvalid');commentRef.current?.focus();return;}
  if(mode==='accept'&&((props.legacy&&!ack)||waiverMissing))return;
  if(mode==='accept'?!props.acceptAllowed:!props.returnAllowed)return;
  const target=current.current,action=mode;submittedComment.current={target,value:comment};inFlight.current=true;setBusy(true);setError(null);
  try{const result=await props.onDecision({decision:action,comment:comment.trim(),criterionIds:[...refs],waivers:action==='accept'?waiverCriteria.map(row=>({criterionId:row.id,reason:waivers[row.id]!.trim()})):[]});if(current.current===target)outcome(result,action);}catch{if(current.current===target)setError('unknown');}
  finally{inFlight.current=false;setBusy(false);}
 };
 const reconcile=async(retry:boolean)=>{if(inFlight.current)return;const action=props.pendingDecision??mode??'request-changes',target=current.current;inFlight.current=true;setBusy(true);try{const result=await(retry?props.onRetry?.():props.onCheck?.());if(current.current===target)outcome(result,action);}catch{if(current.current===target)setError('unknown');}finally{inFlight.current=false;setBusy(false);}};
 return <section className="acceptance-decision">
  <h2>{t('decision')}</h2>
  {props.readonly?<p className="acceptance-status">{t(props.readonly)}</p>:<>
   <p>{t(props.effect)}</p>{props.effect==='effectFlow'&&<p>{t('returnRemediation')}</p>}
   {props.blockedReason&&<p>{t(props.blockedReason)}</p>}
   {props.extraActions}
   <div className="acceptance-actions"><Button disabled={!props.acceptAllowed||disabled} onClick={()=>{setMode('accept');setAck(false);setNotice(null);}}>{t('accept')}</Button><Button variant="secondary" disabled={!props.returnAllowed||disabled} onClick={()=>{setMode('request-changes');setNotice(null);}}>{t('return')}</Button></div>
   {mode&&<div className="acceptance-confirmation">
    <p>{t(mode==='accept'?props.effect:'returnEffect')}</p>
    {mode==='request-changes'?<>
     <Field label={t('comment')}><textarea className="hub-input" ref={commentRef} value={comment} maxLength={4000} onChange={event=>{setComment(event.target.value);if(event.target.value.trim().length>4000)setError("commentInvalid");else if(error==="commentInvalid")setError(null);}}/></Field>
     <small>{t('remaining',{count:4000-reason.length})}</small>
     {props.criteria.map(row=><label key={row.id}><input type="checkbox" disabled={!refs.includes(row.id)&&refs.length>=20} checked={refs.includes(row.id)} onChange={event=>setRefs(event.target.checked?[...refs,row.id]:refs.filter(id=>id!==row.id))}/>{t('related',{text:row.text})}</label>)}
    </>:<>
     {props.legacy&&<label><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)}/>{t('ack')}</label>}
     {waiverCriteria.map(row=><fieldset key={row.id}><label><input type="checkbox" checked={waived.includes(row.id)} onChange={event=>setWaived(event.target.checked?[...waived,row.id]:waived.filter(id=>id!==row.id))}/>{t('waiveLabel',{text:row.text})}</label><Field label={t('waiveReason',{text:row.text})}><Textarea maxLength={4000} disabled={!waived.includes(row.id)} value={waivers[row.id]??''} onChange={event=>setWaivers({...waivers,[row.id]:event.target.value})}/></Field></fieldset>)}
    </>}
    <div className="acceptance-actions"><Button disabled={disabled||(mode==='request-changes'?reason.length>4000:!!(props.legacy&&!ack)||waiverMissing)} onClick={()=>void submit()}>{t(mode==='accept'?'confirmAccept':'confirmReturn')}</Button><Button variant="ghost" disabled={busy} onClick={()=>setMode(null)}>{t('cancel')}</Button></div>
   </div>}
  </>}
  <Field label={t('personal')} hint={t('personalHelp')}><Textarea value={personal} onChange={event=>setPersonal(event.target.value)}/></Field>
  {(busy||props.pendingCode==='sending')&&<p aria-live="polite">{t('saving')}</p>}
  {(stale||error&&!['unknown','stale'].includes(error))&&<p role="alert">{t(stale?'stale':error!)}</p>}
  {stale&&<Button variant="secondary" disabled={!!unknown||busy} onClick={()=>{props.refresh();setPinned(props.targetKey);setPinnedSubject(props.subjectKey??props.targetKey);setMode(null);setAck(false);setError(null);}}>{t('reviewAgain')}</Button>}
  {unknown&&<div><p role="alert">{t(props.pendingCode==='pending-storage'?'pendingStorage':props.pendingCode==='foreign-pending'?'pendingOther':'unknown')}</p><div className="acceptance-actions">{props.onCheck&&<Button disabled={busy} variant="secondary" onClick={()=>void reconcile(false)}>{t('check')}</Button>}{props.onRetry&&<Button disabled={busy} variant="secondary" onClick={()=>void reconcile(true)}>{t('retry')}</Button>}</div></div>}
  {notice&&<p className="acceptance-status" ref={statusRef} role="status" tabIndex={-1}>{t(notice)}</p>}
 </section>;
}
