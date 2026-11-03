/** Synchronous server admission guards; browser presentation uses the portable async resolver instead. */
import {createHash} from 'node:crypto';
import type {CodeRevision,HubDocument} from './contracts';
import type {DocumentRef} from './work/model';
import {parseReviewReport,validateReviewGuide,validateReviewGuideStructure,type GuideValidation} from './review-guide';
import {readLegacyGuideContent} from './review-guide-resolution';
const digest=(content:string|Uint8Array)=>createHash('sha256').update(content).digest('hex');
function legacy(revision:CodeRevision,criterionIds:readonly string[]|null):GuideValidation|null {
 const source=readLegacyGuideContent(revision);if(source.status==='missing')return null;
 if(source.status!=='available')return {ok:false,reason:source.reason};
 if(digest(source.bytes)!==source.contentDigest)return {ok:false,reason:'guide-digest-mismatch'};
 return criterionIds===null?validateReviewGuideStructure(source.content):validateReviewGuide(source.content,criterionIds);
}
export const validateLegacyGuideStructure=(revision:CodeRevision):GuideValidation|null=>legacy(revision,null);
export const validateLegacyGuideForSubmission=(revision:CodeRevision,criterionIds:readonly string[]):GuideValidation|null=>legacy(revision,criterionIds);
export function validateCanonicalGuideForCreation(input:{projectId:string;report:string;artifacts:readonly {kind:string;reference?:DocumentRef}[];criterionIds:readonly string[];resolveDocument:(ref:DocumentRef)=>HubDocument|undefined}):GuideValidation|null {
 const parsed=parseReviewReport(input.report);
 if(parsed.kind==='invalid')return {ok:false,reason:parsed.reason};
 if(parsed.kind==='plain'||parsed.value.reviewGuide===null)return null;
 const ref=parsed.value.reviewGuide;
 if(input.artifacts.filter(a=>a.kind==='document'&&a.reference?.documentId===ref.documentId&&a.reference.version===ref.version&&a.reference.contentDigest===ref.contentDigest).length!==1)return {ok:false,reason:'guide-artifact-mismatch'};
 const doc=input.resolveDocument(ref);
 if(!doc||doc.projectId!==input.projectId||doc.id!==ref.documentId||doc.version!==ref.version||doc.contentDigest!==ref.contentDigest||digest(doc.content)!==ref.contentDigest)return {ok:false,reason:'guide-document-mismatch'};
 return validateReviewGuide(doc.content,input.criterionIds);
}
