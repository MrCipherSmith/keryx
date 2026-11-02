import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useHub } from '../../app/hub-context';
import { ApiError } from '../../api/client';
import { parseReviewReport } from '../../../../../src/hub/review-guide';
import { resolveCanonicalReviewGuide } from '../../../../../src/hub/review-guide-resolution';
import { aggregateVersions, exactPassingCoverage, pendingAmendments, recordOf, recordsOf, requirementDrift } from '../managed-work/model';
import type { WorkAdapter } from '../managed-work/adapter';
import type { Attempt, FlowSubmission, ReviewSubmission, WorkFlow, WorkIntent, WorkRecord } from '../managed-work/types';
import { useWorkOperation } from '../managed-work/operation';
import { ReviewPresentation } from './presentation';
import { canonicalCriteria, returnReason, type ReviewCriterion } from './model';
import type { ReactNode } from 'react';
export function CanonicalIntentReview({adapter,flow,intent,attempt,submission,records,can,refresh,technical,selection}:{adapter:WorkAdapter;flow:WorkFlow;intent:WorkIntent;attempt:Attempt;submission:ReviewSubmission;records:WorkRecord[];can:(command:string)=>boolean;refresh:()=>void;technical:ReactNode;selection:ReactNode}){
 const hub=useHub();const {t}=useTranslation('acceptance');
 const revision=recordOf(records,'intent-revision',submission.intentRevisionId),subject=recordOf(records,'subject',submission.subjectId);
 const guide=useQuery({queryKey:[hub.scopeKey,hub.projectId,'work',adapter.mode,'review-guide',subject?.id,subject?.contentDigest,revision?.id],enabled:!!subject&&!!revision,retry:false,queryFn:async()=>{
  let blocked=false;
  const resolution=await resolveCanonicalReviewGuide({projectId:hub.projectId??'',subject:subject!,criterionIds:revision!.criteria.map(row=>row.criterionId),resolveDocument:async reference=>{try{return await adapter.document(reference);}catch(error){if(error instanceof ApiError&&[0,401,403].includes(error.status))blocked=true;throw error;}}});
  return {resolution,blocked};
 }});
 const human=hub.principal.kind==='human'&&!hub.principal.readOnly&&['operator','reviewer'].includes(hub.principal.role)&&(!hub.principal.projectIds||hub.principal.projectIds.includes(hub.projectId??'')),drift=requirementDrift(flow,intent,attempt)||pendingAmendments(records,flow.id).length>0;
 const sealed=!!subject&&subject.projectId===hub.projectId&&subject.attemptId===attempt.id&&submission.subjectDigest===subject.contentDigest&&submission.projectId===hub.projectId;
 const eligible=human&&can('review.decide')&&sealed&&!drift&&attempt.state==='submitted'&&intent.state==='in-review'&&!['accepted','cancelled'].includes(flow.state)&&!['active','unknown'].includes(attempt.executionOutcome)&&!guide.isPending&&!guide.data?.blocked;
 const selected=intent.selectedSubmissionId===submission.id;
 const readonly=intent.state==='accepted'?'acceptedReadonly' as const:undefined;
 const support=canonicalCriteria(revision?.criteria??[],submission,records);
 const blockedReason=!human?'permission':guide.data?.blocked?'offline':['active','unknown'].includes(attempt.executionOutcome)?'unknownExecution':drift?'drift':!selected?'selectionFirst':!eligible&&!readonly?'blocked':undefined;
 const op=useWorkOperation(adapter,refresh);
 const pendingCommand=op.operation.command;
 const ownPending=pendingCommand?.command==='review.decide'&&pendingCommand.payload.targetType==='intent-review'&&pendingCommand.payload.targetId===intent.id&&pendingCommand.payload.submissionId===submission.id&&pendingCommand.payload.submissionDigest===submission.contentDigest;
 const foreignPending=op.operation.status==='unknown'&&!!pendingCommand&&!ownPending;
 const pendingDecision=ownPending&&pendingCommand.command==='review.decide'&&(pendingCommand.payload.decision==='accept'||pendingCommand.payload.decision==='request-changes')?pendingCommand.payload.decision:undefined;

 const report=parseReviewReport(subject?.report??'');const summary=report.kind==='envelope'?report.value.summary:report.kind==='plain'?report.text.slice(0,2000):'';
 const scope=JSON.stringify([window.location.origin,hub.projectId,'canonical',intent.id,hub.principal.id]);
 return <ReviewPresentation title={intent.title} summary={summary} author={subject?.createdBy??attempt.participantId} submittedAt={submission.createdAt} guide={guide.data?.resolution} loading={guide.isPending} criteria={support} technical={technical} decision={{scope,subjectKey:submission.id+":"+submission.contentDigest,targetKey:JSON.stringify([submission.id,submission.contentDigest,flow.version,intent.version,attempt.version]),criteria:support,effect:'effectIntent',acceptAllowed:eligible&&selected&&exactPassingCoverage(records,submission,(revision?.criteria??[]).filter(row=>row.waivable).map(row=>row.criterionId)),returnAllowed:eligible&&selected,blockedReason,readonly,pending:op.blocked,pendingCode:foreignPending?"foreign-pending":op.operation.status==="sending"?"sending":op.operation.code??undefined,pendingDecision,refresh,extraActions:selection,onCheck:foreignPending?undefined:()=>op.run(),onRetry:foreignPending?undefined:op.retry,onDecision:input=>op.run({command:'review.decide',expectedVersions:aggregateVersions(flow,intent,attempt),payload:{targetType:'intent-review',targetId:intent.id,submissionId:submission.id,submissionDigest:submission.contentDigest,decision:input.decision,reason:input.decision==='accept'?t('acceptedReason'):returnReason(input.comment,input.criterionIds),waivers:input.decision==='accept'?input.waivers:[]}})}}/>;
}
export function CanonicalFlowReview({adapter,flow,submission,records,can,refresh}:{adapter:WorkAdapter;flow:WorkFlow;submission:FlowSubmission;records:WorkRecord[];can:(command:string)=>boolean;refresh:()=>void}){
 const hub=useHub();const {t}=useTranslation('acceptance');const op=useWorkOperation(adapter,refresh);
 const pendingCommand=op.operation.command;
 const ownPending=pendingCommand?.command==='review.decide'&&pendingCommand.payload.targetType==='flow-review'&&pendingCommand.payload.targetId===flow.id&&pendingCommand.payload.submissionId===submission.id&&pendingCommand.payload.submissionDigest===submission.contentDigest;
 const foreignPending=op.operation.status==='unknown'&&!!pendingCommand&&!ownPending;
 const pendingDecision=ownPending&&pendingCommand.command==='review.decide'&&(pendingCommand.payload.decision==='accept'||pendingCommand.payload.decision==='request-changes')?pendingCommand.payload.decision:undefined;
 const revision=recordOf(records,'flow-revision',submission.flowRevisionId);
 const intents=recordsOf(records,'intent').filter(intent=>intent.flowId===flow.id);
 const required=intents.filter(intent=>revision?.requiredIntentIds.includes(intent.id));
 const complete=!!revision&&required.length>0&&required.length===revision.requiredIntentIds.length&&required.every(intent=>intent.state==='accepted'&&submission.acceptedIntents.some(entry=>entry.intentId===intent.id&&entry.decisionId===intent.acceptanceDecisionId&&entry.intentRevisionId===intent.approvedRevisionId));
 const human=hub.principal.kind==='human'&&!hub.principal.readOnly&&['operator','reviewer'].includes(hub.principal.role)&&(!hub.principal.projectIds||hub.principal.projectIds.includes(hub.projectId??''));const eligible=human&&can('review.decide')&&complete&&flow.state==='in-review'&&flow.approvedRevisionId===submission.flowRevisionId&&pendingAmendments(records,flow.id).length===0;
 const criteria:ReviewCriterion[]=(revision?.criteria??[]).map(criterion=>{
  const mapped=submission.criterionCoverage.filter(entry=>entry.flowCriterionId===criterion.criterionId);
  const supports=mapped.flatMap(entry=>{const child=recordOf(records,'submission',entry.submissionId),ir=recordOf(records,'intent-revision',submission.acceptedIntents.find(item=>item.intentId===entry.intentId)?.intentRevisionId);return child&&ir?canonicalCriteria(ir.criteria,child,records).filter(row=>row.id===entry.intentCriterionId):[];});
  const status=supports.some(row=>row.status==='conflicting')?'conflicting':supports.some(row=>row.status==='fail')?'fail':supports.some(row=>row.status==='inconclusive')?'inconclusive':supports.length&&supports.every(row=>row.status==='reportedPass')?'reportedPass':'missing';
  return {id:criterion.criterionId,text:criterion.text,status,reports:supports.flatMap(row=>row.reports),waivers:supports.flatMap(row=>row.waivers)};
 });
 const scope=JSON.stringify([window.location.origin,hub.projectId,'canonical-flow',flow.id,hub.principal.id]);
 return <ReviewPresentation title={flow.title} summary={revision?.expectedOutcome??''} author={submission.createdBy} submittedAt={submission.createdAt} guide={{status:'missing',reason:'aggregate-manifest'}} criteria={criteria} technical={<><code>{submission.contentDigest}</code><pre>{JSON.stringify(submission,null,2)}</pre></>} decision={{scope,subjectKey:submission.id+":"+submission.contentDigest,targetKey:JSON.stringify([submission.id,submission.contentDigest,flow.version,...intents.map(intent=>intent.version)]),criteria,effect:'effectFlow',acceptAllowed:eligible,returnAllowed:eligible,blockedReason:!human?'permission':!eligible?'blocked':undefined,readonly:flow.state==='accepted'?'acceptedReadonly':undefined,pending:op.blocked,pendingCode:foreignPending?"foreign-pending":op.operation.status==="sending"?"sending":op.operation.code??undefined,pendingDecision,refresh,onCheck:foreignPending?undefined:()=>op.run(),onRetry:foreignPending?undefined:op.retry,onDecision:input=>op.run({command:'review.decide',expectedVersions:{...aggregateVersions(flow),...Object.fromEntries(intents.map(intent=>[intent.id,intent.version]))},payload:{targetType:'flow-review',targetId:flow.id,submissionId:submission.id,submissionDigest:submission.contentDigest,decision:input.decision,reason:input.decision==='accept'?t('acceptedReason'):returnReason(input.comment,input.criterionIds),waivers:[]}})}}><h3>{t('aggregate')}</h3><ul aria-label={t('aggregate')}>{submission.acceptedIntents.map(entry=><li key={entry.intentId}>{recordOf(records,'intent',entry.intentId)?.title??entry.intentId}</li>)}</ul></ReviewPresentation>;
}
