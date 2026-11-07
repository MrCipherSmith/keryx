import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { formatDate } from '../../i18n/format';
import type { GuideResolution } from '../../../../../src/hub/review-guide';
import { DecisionControls, type ReviewDecisionProps } from './decision-controls';
import type { ReviewCriterion } from './model';
import './acceptance.css';
export function ReviewPresentation({title,summary,author,submittedAt,createdTime=false,guide,loading,criteria,decision,technical,children}:{title:string;summary:string;author:string;submittedAt:string;createdTime?:boolean;guide:GuideResolution|undefined;loading?:boolean;criteria:ReviewCriterion[];decision:ReviewDecisionProps;technical:ReactNode;children?:ReactNode}){
 const {t,i18n}=useTranslation('acceptance');const [copyStatus,setCopyStatus]=useState<'copied'|'copyFailed'|null>(null);
 const content=guide?.status==='available'?guide.guide:null;
 const mappedCriteria = new Set(content?.steps.flatMap(step => step.criterionIds));
 // Only a resolved guide (available or explicitly missing) can say a criterion has no steps; an unavailable or unloaded one says nothing.
 const guideResolved = guide?.status==='available'||guide?.status==='missing';
 const missingSteps = guideResolved ? criteria.filter(row => !mappedCriteria.has(row.id)).length : 0;
 const missingEvidence = criteria.filter(row => !row.reports.length && !row.waivers.length).length;
 return <article className="acceptance-review" aria-label={title}>
  <section><h2>{t('what')}</h2><Markdown safeLinksOnly content={content?.summary||summary||t('noSummary')}/><p>{content?.userImpact||t('impactMissing')}</p><h3>{t('limitations')}</h3>{content?.limitations.length?<ul>{content.limitations.map((item,index)=><li key={index}>{item}</li>)}</ul>:<p>{t('noLimitation')}</p>}<p className="acceptance-byline">{t(createdTime?'created':'submitted',{author,time:Number.isFinite(Date.parse(submittedAt))?formatDate(submittedAt,i18n.language):"—"})}</p>{createdTime&&<p className="acceptance-byline">{t('submittedUnknown')}</p>}</section>
  <section><h2>{t('how')}</h2>{loading?<p>{t('guideLoading')}</p>:content?<>
   <p className="acceptance-byline">{t('guideAuthor')}</p><h3>{t('prerequisites')}</h3><ul>{content.prerequisites.map((item,index)=><li key={index}>{item}</li>)}</ul>
   <ol className="acceptance-steps">{content.steps.map(step=><li key={step.stepId}><strong>{step.location}</strong><pre className="acceptance-instruction">{step.instruction}</pre><Button variant="secondary" onClick={()=>{void Promise.resolve().then(()=>{if(!navigator.clipboard?.writeText)throw new Error('clipboard-unavailable');return navigator.clipboard.writeText(step.instruction);}).then(()=>setCopyStatus('copied')).catch(()=>setCopyStatus('copyFailed'));}}>{t('copy')}</Button><p><strong>{t('expected')}: </strong>{step.expectedResult}</p></li>)}</ol>
  </>:<p>{t(guide?.status==='missing'?'guideMissing':'guideUnavailable')}</p>}{copyStatus&&<p role="status">{t(copyStatus)}</p>}</section>
  <section><h2>{t('criteria')}</h2><div className="acceptance-criteria">{criteria.map((row,index)=><section className="acceptance-criterion" role="group" aria-label={row.text} key={row.id}><p className="acceptance-criterion-title"><span aria-hidden="true">{index+1}.</span> {row.text}</p><span className="acceptance-support" data-state={row.status}>{t(row.status)}</span>{row.reports.map(report=><div key={report.id} role="group" aria-label={report.method}><p><span>{t(report.source==='ci-observation'?(report.sourceObservationId?'ci':'unverified'):report.source==='human-review'?'human':report.source==='machine-observation'?(report.sourceRunId?'agent':'unverified'):'contributor')}</span> · {report.createdBy}</p><p>{report.report.slice(0,2000)}</p><a aria-label={t('openEvidence') + ': ' + report.method} href={'#review-evidence-'+report.id} onClick={()=>{let element=document.getElementById('review-evidence-'+report.id);while(element){if(element instanceof HTMLDetailsElement)element.open=true;element=element.parentElement;}}}>{report.method}</a></div>)}{row.waivers.map(waiver=><div key={waiver.id}><strong>{t('waiver')}</strong><p>{waiver.reason}</p><small>{waiver.createdBy} · {formatDate(waiver.createdAt,i18n.language)}</small></div>)}</section>)}</div>{children}</section>
  {!loading && (missingSteps > 0 || missingEvidence > 0) && <section aria-label={t('reviewGaps')}>
    <h2>{t('reviewGaps')}</h2>
    {missingSteps > 0 && <p>{t('missingStepsCount', {count:missingSteps})}</p>}
    {missingEvidence > 0 && <p>{t('missingEvidenceCount', {count:missingEvidence})}</p>}
    <p>{t('manualReviewNext')}</p>
  </section>}
  <DecisionControls key={decision.scope} {...decision}/>
  <details className="acceptance-technical"><summary>{t('technical')}</summary>{technical}</details>
 </article>;
}
