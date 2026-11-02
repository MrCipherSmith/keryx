import type { CodeRevision, HubDocument } from './contracts';
import type { DocumentRef, ResultSubject } from './work/model';
import { isReviewDocumentRef, parseReviewReport, REVIEW_GUIDE_MAX_BYTES, validateReviewGuide, type GuideResolution } from './review-guide';
export type ReviewGuideDocument=Pick<HubDocument,'id'|'projectId'|'version'|'contentDigest'|'content'>;
export type ReviewGuideDigest=(content:Uint8Array)=>Promise<string>;
const digest:ReviewGuideDigest=async content=>Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new Uint8Array(content))),byte=>byte.toString(16).padStart(2,'0')).join('');
const provenance=(author:{createdBy:string;createdAt:string})=>({kind:'contributor-authored' as const,createdBy:author.createdBy,createdAt:author.createdAt});
const readDigest=async(bytes:Uint8Array,port:ReviewGuideDigest)=>{try{return await port(bytes);}catch{return null;}};

/** Resolves only the designated artifact in this sealed subject; the port must support historical exact document references. */
export async function resolveCanonicalReviewGuide(input:{projectId:string;subject:ResultSubject;criterionIds:readonly string[];resolveDocument:(reference:DocumentRef)=>ReviewGuideDocument|undefined|Promise<ReviewGuideDocument|undefined>;digest?:ReviewGuideDigest}):Promise<GuideResolution> {
 const {subject,projectId,criterionIds}=input,author=provenance(input.subject);
 if(subject.projectId!==projectId)return {status:'invalid',reason:'foreign-subject'};
 const parsed=parseReviewReport(subject.report);
 if(parsed.kind==='invalid')return {status:'invalid',reason:parsed.reason};
 if(parsed.kind==='plain'||!parsed.value.reviewGuide)return {status:'missing',reason:'no-guide-selector'};
 const reference=parsed.value.reviewGuide;
 const matches=subject.artifacts.filter(artifact=>artifact.kind==='document'&&isReviewDocumentRef(artifact.reference)&&artifact.reference.documentId===reference.documentId&&artifact.reference.version===reference.version&&artifact.reference.contentDigest===reference.contentDigest);
 if(matches.length>1)return {status:'ambiguous',reason:'duplicate-guide-artifact'};
 if(matches.length!==1)return {status:'invalid',reason:'guide-not-in-subject'};
 let document:ReviewGuideDocument|undefined;
 try{document=await input.resolveDocument({...reference});}catch{return {status:'unavailable',reason:'guide-document-unavailable'};}
 if(!document)return {status:'unavailable',reason:'guide-document-unavailable'};
 if(document.projectId!==projectId||document.id!==reference.documentId||document.version!==reference.version||document.contentDigest!==reference.contentDigest)return {status:'invalid',reason:'guide-document-mismatch'};
 const content=document.content,actual=await readDigest(new TextEncoder().encode(content),input.digest??digest);
 if(actual===null)return {status:'unavailable',reason:'guide-verification-unavailable'};
 if(actual!==reference.contentDigest)return {status:'invalid',reason:'guide-document-mismatch'};
 const validated=validateReviewGuide(content,criterionIds);
 return validated.ok?{status:'available',guide:validated.value,provenance:author}:{status:'invalid',reason:validated.reason};
}
export type LegacyGuideContent={status:'available';content:string;bytes:Uint8Array;contentDigest:string}|Exclude<GuideResolution,{status:'available'}>;
/** Decode only the exact designated path with a bounded allocation; never verify or execute its instructions here. */
export function readLegacyGuideContent(revision:CodeRevision):LegacyGuideContent {
 const matches=revision.files.filter(file=>file.path==='attempt/review-guide.json');
 if(matches.length>1)return {status:'ambiguous',reason:'duplicate-guide-file'};
 const file=matches[0];if(!file)return {status:'missing',reason:'no-guide-file'};
 if(!['100644','100755'].includes(file.mode)||file.contentBase64.length>4*Math.ceil(REVIEW_GUIDE_MAX_BYTES/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64))return {status:'invalid',reason:'invalid-guide-file'};
 const padding=file.contentBase64.endsWith('==')?2:file.contentBase64.endsWith('=')?1:0;
 if(file.contentBase64.length/4*3-padding>REVIEW_GUIDE_MAX_BYTES)return {status:'invalid',reason:'guide-too-large'};
 const decoded=atob(file.contentBase64),bytes=Uint8Array.from(decoded,char=>char.charCodeAt(0));
 if(btoa(decoded)!==file.contentBase64)return {status:'invalid',reason:'invalid-guide-encoding'};
 let content:string;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return {status:'invalid',reason:'invalid-guide-encoding'};}
 return {status:'available',content,bytes,contentDigest:file.contentDigest};
}
/** Legacy guidance is read from one immutable packet; the digest port defaults to native WebCrypto. */
export async function resolveLegacyReviewGuide(input:{projectId:string;revision:CodeRevision;criterionIds:readonly string[];digest?:ReviewGuideDigest}):Promise<GuideResolution> {
 const {revision,projectId,criterionIds}=input,author=provenance(input.revision);
 if(revision.projectId!==projectId)return {status:'invalid',reason:'foreign-revision'};
 const source=readLegacyGuideContent(revision);if(source.status!=='available')return source;
 const actual=await readDigest(source.bytes,input.digest??digest);
 if(actual===null)return {status:'unavailable',reason:'guide-verification-unavailable'};
 if(actual!==source.contentDigest)return {status:'invalid',reason:'invalid-guide-file'};
 const validated=validateReviewGuide(source.content,criterionIds);
 return validated.ok?{status:'available',guide:validated.value,provenance:author}:{status:'invalid',reason:validated.reason};
}
