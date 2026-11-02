/** Browser-safe decoding of contributor instructions. These values never grant verification or decision authority. */
import type { DocumentRef } from './work/model';

export const REVIEW_GUIDE_MAX_BYTES=32*1024;
export type ReviewGuide={format:'review-guide/v1';summary:string;userImpact:string;limitations:string[];prerequisites:string[];steps:Array<{stepId:string;criterionIds:string[];location:string;instruction:string;expectedResult:string}>};
export type ReviewReport={format:'review-report/v1';summary:string;body:string;reviewGuide:DocumentRef|null};
export type GuideValidation={ok:true;value:ReviewGuide}|{ok:false;reason:string};
export type ParsedReviewReport={kind:'plain';text:string}|{kind:'envelope';value:ReviewReport}|{kind:'invalid';reason:string};
export type GuideResolution={status:'available';guide:ReviewGuide;provenance:{kind:'contributor-authored';createdBy:string;createdAt:string}}|{status:'missing'|'invalid'|'ambiguous'|'unavailable';reason:string};

const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const fields=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value:unknown,max:number,nonblank=false):value is string=>typeof value==='string'&&Array.from(value).length<=max&&(!nonblank||value.trim().length>0);
const strings=(value:unknown,maxItems:number,maxLength:number,nonblank=true):value is string[]=>Array.isArray(value)&&value.length<=maxItems&&value.every(item=>text(item,maxLength,nonblank));
export function isReviewDocumentRef(value:unknown):value is DocumentRef {
 return object(value)&&fields(value,['documentId','version','contentDigest'])&&text(value.documentId,200,true)&&Number.isSafeInteger(value.version)&&Number(value.version)>=1&&typeof value.contentDigest==='string'&&/^[a-f0-9]{64}$/.test(value.contentDigest);
}
function validateGuide(content:string,criterionIds:readonly string[]|null):GuideValidation {
 if(content.length>REVIEW_GUIDE_MAX_BYTES||new TextEncoder().encode(content).byteLength>REVIEW_GUIDE_MAX_BYTES)return {ok:false,reason:'guide-too-large'};
 let value:unknown;try{value=JSON.parse(content);}catch{return {ok:false,reason:'invalid-json'};}
 if(!object(value)||!fields(value,['format','summary','userImpact','limitations','prerequisites','steps'])||value.format!=='review-guide/v1'||!text(value.summary,2000,true)||!text(value.userImpact,2000)||!strings(value.limitations,20,1000)||!strings(value.prerequisites,20,1000)||!Array.isArray(value.steps)||value.steps.length>30)return {ok:false,reason:'invalid-guide'};
 const pinned=criterionIds===null?null:new Set(criterionIds),ids=new Set<string>();
 const steps:ReviewGuide['steps']=[];
 for(const step of value.steps){
  if(!object(step)||!fields(step,['stepId','criterionIds','location','instruction','expectedResult'])||!text(step.stepId,100,true)||!strings(step.criterionIds,200,200)||new Set(step.criterionIds).size!==step.criterionIds.length||!text(step.location,500,true)||!text(step.instruction,3000,true)||!text(step.expectedResult,2000,true))return {ok:false,reason:'invalid-step'};
  if(ids.has(step.stepId))return {ok:false,reason:'duplicate-step'};
  if(pinned&&step.criterionIds.some(id=>!pinned.has(id)))return {ok:false,reason:'foreign-criterion'};
  ids.add(step.stepId);steps.push({stepId:step.stepId,criterionIds:[...step.criterionIds],location:step.location,instruction:step.instruction,expectedResult:step.expectedResult});
 }
 return {ok:true,value:{format:'review-guide/v1',summary:value.summary,userImpact:value.userImpact,limitations:[...value.limitations],prerequisites:[...value.prerequisites],steps}};
}
export function parseReviewReport(report:string):ParsedReviewReport {
 let value:unknown;
 try{value=JSON.parse(report);}catch{return report.trimStart().startsWith('{')&&/(?:^|[{,])\s*"format"\s*:\s*"review-report\//.test(report)?{kind:'invalid',reason:'invalid-report-json'}:{kind:'plain',text:report};}
 if(!object(value)||typeof value.format!=='string'||!value.format.startsWith('review-report/'))return {kind:'plain',text:report};
 if(!fields(value,['format','summary','body','reviewGuide'])||value.format!=='review-report/v1'||!text(value.summary,2000,true)||!text(value.body,30000)||(value.reviewGuide!==null&&!isReviewDocumentRef(value.reviewGuide)))return {kind:'invalid',reason:'invalid-report'};
 return {kind:'envelope',value:{format:'review-report/v1',summary:value.summary,body:value.body,reviewGuide:value.reviewGuide}};
}
/** A legacy presentation reference, never a canonical Work criterion identity or a return-request wire field. */
export function legacyReviewCriterionId(specContentDigest:string,position:number):string {
 if(!/^[a-f0-9]{64}$/.test(specContentDigest)||!Number.isSafeInteger(position)||position<1||position>200)throw new TypeError('Invalid frozen legacy criterion reference');
 return `legacy:${specContentDigest}:${position}`;
}

export const validateReviewGuide=(content:string,criterionIds:readonly string[]):GuideValidation=>validateGuide(content,criterionIds);
/** Unbound packet upload validates shape; only a later pinned submission can validate membership. */
export const validateReviewGuideStructure=(content:string):GuideValidation=>validateGuide(content,null);
