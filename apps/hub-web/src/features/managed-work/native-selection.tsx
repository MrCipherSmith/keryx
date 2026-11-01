import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useHub } from '../../app/hub-context';
import type { NativeWorkHint } from '../../api/client';
import type { Control } from '../../api/remote';
import { Button, Field, Notice, Select } from '../../components/ui';
import { liveWorkAdapter } from './adapter';
import { pendingAmendments, recordOf, recordsOf } from './model';
import { useWorkEvents } from './updates';
import './work.css';

type Selection={principalId:string;scopeKey:number;projectId:string;sessionId:string;hint:NativeWorkHint;confirmed:boolean};
export function useNativeWorkSelection(record:Control['SessionRecord'],mode:string,controllerActive:boolean){
 const hub=useHub();const operator=hub.principal.kind==='human'&&hub.principal.role==='operator';
 const sameProject=hub.projectId===record.projectId;
 const heldByCurrentOperator=controllerActive&&record.controller?.actorId===hub.principal.id;
 const adapter=useMemo(()=>liveWorkAdapter(record.projectId),[record.projectId]);
 const [selection,setSelection]=useState<Selection|null>(null);
 useEffect(()=>setSelection(null),[hub.scopeKey,hub.principal.id,record.projectId,record.sessionId,mode]);
 const capabilities=useQuery({queryKey:[hub.scopeKey,record.projectId,'work','live','capabilities'],queryFn:({signal})=>adapter.capabilities(signal),enabled:sameProject,retry:false});
 const available=capabilities.data?.enabled===true&&capabilities.data.features.managedExecution;
 const snapshot=useQuery({queryKey:[hub.scopeKey,record.projectId,'work','live','snapshot'],queryFn:({signal})=>adapter.snapshot(signal),enabled:sameProject&&available&&operator&&mode==='managed',retry:false});
 useWorkEvents(adapter,mode==='managed'?snapshot.data?.eventCursor:undefined);
 const records=snapshot.data?.records??[];
 const eligible=recordsOf(records,'attempt').filter((a)=>{
  const f=recordOf(records,'flow',a.flowId),i=recordOf(records,'intent',a.intentId),c=recordOf(records,'context',a.contextSnapshotId);
  return ['running','blocked'].includes(a.state)&&a.executionOutcome!=='unknown'&&f?.state==='in-progress'&&!!i&&['in-progress','in-review'].includes(i.state)&&f.approvedRevisionId===a.flowRevisionId&&i.approvedRevisionId===a.intentRevisionId&&c?.flowRevisionId===a.flowRevisionId&&c.intentRevisionId===a.intentRevisionId&&c.entries.every((e)=>!e.required||e.resolution==='resolved')&&!pendingAmendments(records,f.id).some((m)=>m.affectedIntentIds.includes(i.id));
 });
 const scoped=selection?.principalId===hub.principal.id&&selection?.scopeKey===hub.scopeKey&&selection.projectId===record.projectId&&selection.sessionId===record.sessionId?selection:null;
 const attempt=eligible.find((a)=>a.id===scoped?.hint.attemptId);
 const stale=!!scoped&&(!attempt||attempt.version!==scoped.hint.attemptVersion);
 const valid=mode==='managed'&&sameProject&&available&&operator&&heldByCurrentOperator&&!!scoped?.confirmed&&!!attempt&&!stale&&!snapshot.isFetching;
 const pick=(id:string)=>{const a=eligible.find((a)=>a.id===id);setSelection(a?{principalId:hub.principal.id,scopeKey:hub.scopeKey,projectId:record.projectId,sessionId:record.sessionId,hint:{attemptId:a.id,attemptVersion:a.version},confirmed:false}:null);};
 return {available,operator,controllerActive:heldByCurrentOperator,sameProject,capabilities,snapshot,records,eligible,attempt,selection:scoped,stale,valid,hint:valid?scoped?.hint:undefined,pick,confirm:(confirmed:boolean)=>{if(scoped)setSelection({...scoped,confirmed});}};
}
export function NativeAttemptPicker({value,locked}:{value:ReturnType<typeof useNativeWorkSelection>;locked:boolean}){
 const {t}=useTranslation('work');const attempt=value.attempt;
 const flow=recordOf(value.records,'flow',attempt?.flowId),intent=recordOf(value.records,'intent',attempt?.intentId),context=recordOf(value.records,'context',attempt?.contextSnapshotId);
 const fr=recordOf(value.records,'flow-revision',attempt?.flowRevisionId),ir=recordOf(value.records,'intent-revision',attempt?.intentRevisionId);
 return <section className="native-work-picker" aria-label={t('managedAttempt')}><p>{t('nativeBindingHelp')}</p>{!value.operator?<Notice>{t('nativeReadOnly')}</Notice>:!value.available?<Notice>{t('nativeUnavailable')}</Notice>:!value.controllerActive?<Notice>{t('nativeControllerRequired')}</Notice>:null}{value.snapshot.error&&<Notice tone="error">{t('failed')}</Notice>}<Field label={t('chooseAttempt')}><Select value={value.selection?.hint.attemptId??''} disabled={locked||!value.operator||!value.available||!value.controllerActive} onChange={(e)=>value.pick(e.target.value)}><option value="">{t('chooseAttempt')}</option>{value.eligible.map((a)=><option key={a.id} value={a.id}>{recordOf(value.records,'flow',a.flowId)?.title} / {recordOf(value.records,'intent',a.intentId)?.title} · {a.id} · v{a.version}</option>)}</Select></Field>{!value.eligible.length&&!value.snapshot.isPending&&<p>{t('noStartedAttempts')}</p>}{value.stale&&<Notice>{t('staleAttempt')}<Button variant="secondary" disabled={locked||!value.attempt} onClick={()=>value.pick(value.selection?.hint.attemptId??'')}>{t('refreshAttemptPins')}</Button></Notice>}{attempt&&<><dl><div><dt>Flow</dt><dd>{flow?.title} · <code>{fr?.id}</code><code>{fr?.contentDigest}</code></dd></div><div><dt>{t('deliverable')}</dt><dd>{intent?.title} · <code>{ir?.id}</code><code>{ir?.contentDigest}</code></dd></div><div><dt>{t('attempts')}</dt><dd><code>{attempt.id}</code> · v{value.selection?.hint.attemptVersion}</dd></div><div><dt>{t('contextSnapshot')}</dt><dd><code>{context?.id}</code><code>{context?.contentDigest}</code></dd></div></dl><p>{t('unverified')}</p><label className="work-checkbox"><input type="checkbox" checked={value.selection?.confirmed??false} disabled={locked||value.stale||!value.operator||!value.controllerActive} onChange={(e)=>value.confirm(e.target.checked)}/>{t('confirmNativePins')}</label></>}</section>;
}
