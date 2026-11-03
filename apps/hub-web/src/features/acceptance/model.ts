import type { Criterion, Decision, EvidenceRecord, ReviewSubmission, WorkRecord } from '../managed-work/types';
export type SupportStatus='reportedPass'|'fail'|'inconclusive'|'missing'|'conflicting'|'legacyUnknown';
export type ReviewCriterion={id:string;text:string;status:SupportStatus;reports:EvidenceRecord[];waivers:Decision[];waivable?:boolean};
export type DecisionInput={decision:'accept'|'request-changes';comment:string;criterionIds:string[];waivers:{criterionId:string;reason:string}[]};
export type DecisionOutcome={status:'committed'|'unknown'|'rejected';code?:string};
export function returnReason(comment:string,ids:readonly string[]){return comment.trim()+(ids.length?'\n\nCriteria: '+ids.join(', '):'');}
export function canonicalCriteria(criteria:Criterion[],submission:ReviewSubmission,records:WorkRecord[]):ReviewCriterion[]{
 return criteria.map(criterion=>{
  const coverage=submission.coverage.find(row=>row.criterionId===criterion.criterionId);
  const reports=records.filter((record):record is EvidenceRecord=>record.kind==='evidence'&&record.projectId===submission.projectId&&record.attemptId===submission.attemptId&&record.subjectId===submission.subjectId&&record.subjectDigest===submission.subjectDigest&&record.criterionIds.includes(criterion.criterionId));
  const results=new Set(reports.map(report=>report.result));
  const status:SupportStatus=results.has('pass')&&results.has('fail')?'conflicting':results.has('fail')?'fail':results.has('inconclusive')?'inconclusive':results.has('pass')&&coverage?.result==='pass'&&reports.some(report=>report.result==='pass'&&submission.evidenceIds.includes(report.id)&&coverage.evidenceIds.includes(report.id))?'reportedPass':'missing';
  const waivers=records.filter((record):record is Decision=>record.kind==='decision'&&record.projectId===submission.projectId&&record.targetType==='criterion-waiver'&&record.targetId===criterion.criterionId&&record.targetDigest===submission.contentDigest&&record.decision==='waive');
  return{id:criterion.criterionId,text:criterion.text,status,reports,waivers,waivable:criterion.waivable};
 });
}
