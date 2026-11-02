import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useHub } from '../../app/hub-context';
import { getJson } from '../../api/client';
import type { CodeRevision, Evidence, HubFlow } from '../../api/types';
import { legacyReviewCriterionId } from '../../../../../src/hub/review-guide';
import { resolveLegacyReviewGuide } from '../../../../../src/hub/review-guide-resolution';
import { Markdown } from '../../components/Markdown';
import { ReviewPresentation } from './presentation';
import type { ReviewCriterion } from './model';
import { useLegacyDecision } from './use-legacy-decision';
export function LegacyAcceptance({flow,evidence,refresh}:{flow:HubFlow;evidence:Evidence[];refresh:()=>void}){
 const hub=useHub();const {t}=useTranslation('acceptance');
 const subjectId=flow.subjectRevisionId??flow.reviewFeedback?.subjectRevisionId;
 const revision=useQuery({queryKey:[hub.scopeKey,hub.projectId,'revision',subjectId],enabled:!!subjectId,queryFn:({signal})=>getJson<CodeRevision>(`/projects/${encodeURIComponent(hub.projectId??'')}/revisions/${encodeURIComponent(subjectId??'')}`,signal),retry:false});
 const pinned=/^[a-f0-9]{64}$/.test(flow.specContentDigest)&&flow.criteria.length<=200;
 const criteria:ReviewCriterion[]=flow.criteria.map((text,index)=>({id:pinned?legacyReviewCriterionId(flow.specContentDigest,index+1):'unavailable-'+index,text,status:'legacyUnknown',reports:[],waivers:[]}));
 const exact=!!revision.data&&revision.data.projectId===hub.projectId&&revision.data.id===subjectId;
 const guide=useQuery({queryKey:[hub.scopeKey,hub.projectId,'legacy-review-guide',subjectId,revision.data?.treeDigest,flow.specContentDigest],enabled:exact,retry:false,queryFn:()=>resolveLegacyReviewGuide({projectId:hub.projectId??'',revision:revision.data!,criterionIds:criteria.map(row=>row.id)})});
 const op=useLegacyDecision(flow,refresh);
 const human=hub.principal.kind==='human'&&!hub.principal.readOnly&&['operator','reviewer'].includes(hub.principal.role)&&(!hub.principal.projectIds||hub.principal.projectIds.includes(hub.projectId??''));
 const eligible=pinned&&human&&flow.status==='implemented'&&!!flow.subjectRevisionId&&exact&&!revision.isPending&&!revision.error;
 const scope=JSON.stringify([window.location.origin,hub.projectId,'legacy',flow.id,hub.principal.id]);
 const reports=evidence.filter(report=>report.projectId===hub.projectId&&report.flowId===flow.id&&report.subjectRevisionId===subjectId);
 return <ReviewPresentation title={flow.title} summary={revision.data?.message??''} author={revision.data?.createdBy??'—'} submittedAt={revision.data?.createdAt??''} createdTime guide={guide.data} loading={!!subjectId&&revision.isPending||guide.isFetching} criteria={criteria}
  decision={{scope,subjectKey:subjectId??'unsubmitted',targetKey:JSON.stringify([subjectId,flow.version,flow.specContentDigest]),criteria,effect:'effectLegacy',legacy:true,acceptAllowed:eligible,returnAllowed:eligible,blockedReason:!human?'permission':revision.error?'offline':!eligible&&flow.status!=='done'?'blocked':undefined,readonly:flow.status==='done'?'doneReadonly':undefined,pending:op.pending,pendingCode:op.code,pendingDecision:op.pendingDecision,onDecision:op.run,onCheck:op.check,onRetry:op.retry,refresh}}
  technical={<><h3>{t('reference')}</h3><code>{subjectId}</code><code>{flow.specContentDigest}</code>{revision.data&&<dl><dt>Revision ID</dt><dd>{revision.data.id}</dd><dt>Tree</dt><dd>{revision.data.treeDigest}</dd></dl>}{reports.map(report=><details id={'legacy-evidence-'+report.id} key={report.id}><summary>{report.checkId}</summary><code>{report.subjectRevisionId}</code><pre>{report.command}</pre><p>{report.exitCode}</p><pre>{report.output.slice(0,32000)}</pre><p>{report.actorId}</p></details>)}{flow.reviewFeedback&&<><h3>{t('returnedHistory')}</h3><code>{flow.reviewFeedback.subjectRevisionId}</code></>}</>}
 ><section><h3>{t('unmapped')}</h3><p>{t('unmappedHelp')}</p>{reports.map(report=><div key={report.id}><p>{t('contributor')} · {report.actorId}</p><Markdown safeLinksOnly content={report.checkId}/><a href={'#legacy-evidence-'+report.id} onClick={()=>{let node=document.getElementById('legacy-evidence-'+report.id);while(node){if(node instanceof HTMLDetailsElement)node.open=true;node=node.parentElement;}}}>{t('openEvidence')}</a></div>)}</section></ReviewPresentation>;
}
export function LegacyReturnFeedback({flow}:{flow:HubFlow}){const {t}=useTranslation('acceptance');const decision=flow.reviewFeedback;if(!decision)return null;return <section className="acceptance-confirmation" role="note" aria-label={t('returnedFeedback')}><h3>{t('returnedFeedback')}</h3><p>{decision.comment}</p><small>{decision.actorId} · {decision.createdAt}</small></section>;}
