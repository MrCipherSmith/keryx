import {validateLegacyGuideStructure,validateLegacyGuideForSubmission} from './review-guide-validation';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { CodeRevision, HubDocument } from './contracts';
import type { DocumentRef, ResultSubject } from './work/model';
import { type ReviewGuide, legacyReviewCriterionId, parseReviewReport, validateReviewGuide, validateReviewGuideStructure } from './review-guide';
import { resolveCanonicalReviewGuide, resolveLegacyReviewGuide } from './review-guide-resolution';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const criterionIds=['criterion-a','criterion-b'];
function guide():ReviewGuide{return {format:'review-guide/v1',summary:'Added understandable result review',userImpact:'A reviewer sees reproducible checks',limitations:['Manual browser check remains'],prerequisites:['Open the disposable project'],steps:[{stepId:'check-a',criterionIds:['criterion-a'],location:'Hub browser',instruction:'Open the review result',expectedResult:'The submitted result is visible'}]};}
function canonical(){
 const content=JSON.stringify(guide());
 const reference:DocumentRef={documentId:'guide-document',version:1,contentDigest:digest(content)};
 const document:HubDocument={id:reference.documentId,projectId:'project',path:'guides/result.json',kind:'wiki',version:1,content,contentDigest:reference.contentDigest,approval:'unreviewed',sourceRevision:'fixture'};
 const report=JSON.stringify({format:'review-report/v1',summary:'Delivery summary',body:'Contributor report',reviewGuide:reference});
 const subject:ResultSubject={id:'subject',projectId:'project',createdBy:'agent:contributor',createdAt:'2026-11-03T00:00:00.000Z',kind:'subject',attemptId:'attempt',artifacts:[{kind:'document',reference,proposalId:null}],report,contentDigest:'a'.repeat(64)};
 return {reference,document,subject};
}
function legacy(){
 const content=JSON.stringify(guide());
 const revision:CodeRevision={id:'revision',projectId:'project',baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'Review packet',files:[{path:'attempt/review-guide.json',mode:'100644',contentBase64:Buffer.from(content).toString('base64'),contentDigest:digest(content)}],createdBy:'agent:contributor',createdAt:'2026-11-03T00:00:00.000Z',treeDigest:'b'.repeat(64),purpose:'review-bundle'};
 return revision;
}

describe('immutable review-guide validation',()=>{
 test('accepts the exact reviewed schema as contributor instructions without adding verification authority',()=>{
  const value=guide();expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toEqual({ok:true,value});
 });
 for(const field of ['summary','location','instruction','expectedResult'] as const)test(`rejects whitespace-only ${field}`,()=>{
  const value=guide();if(field==='summary')value.summary=' \n ';else value.steps[0]![field]=' \n ';
  expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toMatchObject({ok:false});
 });
 for(const field of ['limitations','prerequisites'] as const)test(`rejects blank ${field} entries`,()=>{
  const value=guide();value[field]=[' \t '];expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toMatchObject({ok:false});
 });
 test('rejects duplicated step IDs and criterion IDs within a step',()=>{
  const value=guide();value.steps.push({...value.steps[0]!});expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toMatchObject({ok:false});
  value.steps=[{...value.steps[0]!,criterionIds:['criterion-a','criterion-a']}];expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toMatchObject({ok:false});
 });
 test('rejects criterion mappings absent from the pinned requirement revision',()=>{
  const value=guide();value.steps[0]!.criterionIds=['criterion-foreign'];expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toMatchObject({ok:false});
 });
 test('rejects undeclared pass claims and authority fields instead of displaying them as verification',()=>{
  expect(validateReviewGuide(JSON.stringify({...guide(),verified:true}),criterionIds)).toMatchObject({ok:false});
  const value=guide();expect(validateReviewGuide(JSON.stringify({...value,steps:[{...value.steps[0],result:'pass'}]}),criterionIds)).toMatchObject({ok:false});
 });
 test('allows empty steps and unmapped contributor instructions without fabricating criteria',()=>{
  expect(validateReviewGuide(JSON.stringify({...guide(),steps:[]}),criterionIds)).toMatchObject({ok:true});
  const value=guide();value.steps[0]!.criterionIds=[];expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toMatchObject({ok:true});
 });
 test('enforces thirty steps and per-field schema limits',()=>{
  const value=guide();value.steps=Array.from({length:30},(_,n)=>({...value.steps[0]!,stepId:'step-'+n}));
  expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toMatchObject({ok:true});value.steps.push({...value.steps[0]!,stepId:'step-31'});
  expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toMatchObject({ok:false});
  expect(validateReviewGuide(JSON.stringify({...guide(),summary:'x'.repeat(2001)}),criterionIds)).toMatchObject({ok:false});
 });
 test('enforces 32KiB by UTF-8 bytes rather than JavaScript character count',()=>{
  const value=guide();value.steps=Array.from({length:6},(_,n)=>({...value.steps[0]!,stepId:'step-'+n,instruction:'界'.repeat(1900)}));
  const text=JSON.stringify(value);expect(text.length).toBeLessThan(32768);expect(Buffer.byteLength(text)).toBeGreaterThan(32768);
  expect(validateReviewGuide(text,criterionIds)).toMatchObject({ok:false});
 });
 test('accepts exactly 32KiB and refuses the next byte without exceeding any field limit',()=>{
  const value=guide();value.steps=Array.from({length:10},(_,n)=>({...value.steps[0]!,stepId:'step-'+n,instruction:'x'.repeat(3000)}));
  const remaining=32768-Buffer.byteLength(JSON.stringify(value));expect(remaining).toBeGreaterThan(0);value.userImpact+='x'.repeat(remaining);expect(value.userImpact.length).toBeLessThanOrEqual(2000);
  expect(Buffer.byteLength(JSON.stringify(value))).toBe(32768);expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toMatchObject({ok:true});
  value.userImpact+='x';expect(validateReviewGuide(JSON.stringify(value),criterionIds)).toMatchObject({ok:false});
 });
 test('allows canonical criterion IDs up to 200 characters, never a longer mapping',()=>{
  const value=guide(),id='c'.repeat(200);value.steps[0]!.criterionIds=[id];expect(validateReviewGuide(JSON.stringify(value),[id])).toMatchObject({ok:true});
  value.steps[0]!.criterionIds=[id+'c'];expect(validateReviewGuide(JSON.stringify(value),[id+'c'])).toMatchObject({ok:false});
 });
 test('rejects malformed JSON and non-object guide content',()=>{
  for(const text of ['{','null','[]','"review-guide/v1"'])expect(validateReviewGuide(text,criterionIds)).toMatchObject({ok:false});
 });
});

describe('review-report envelope in the existing immutable report string',()=>{
 test('keeps an old plain report as submitted text without guessing a guide',()=>{
  expect(parseReviewReport('Existing contributor report')).toEqual({kind:'plain',text:'Existing contributor report'});
  const ordinary='{"message":"review-report/v1",';expect(parseReviewReport(ordinary)).toEqual({kind:'plain',text:ordinary});
 });
 test('parses an explicit exact document selector and permits a null selector',()=>{
  const {subject,reference}=canonical();expect(parseReviewReport(subject.report)).toMatchObject({kind:'envelope',value:{format:'review-report/v1',reviewGuide:reference}});
  expect(parseReviewReport(JSON.stringify({format:'review-report/v1',summary:'No guide',body:'Report',reviewGuide:null}))).toMatchObject({kind:'envelope',value:{reviewGuide:null}});
 });
 test('rejects invalid selectors, blank summary, undeclared keys and oversized body',()=>{
  const {reference}=canonical();
  for(const change of [{reviewGuide:{...reference,version:0}},{reviewGuide:{...reference,contentDigest:'bad'}},{summary:'  '},{body:'x'.repeat(30001)},{verified:true}]){
   expect(parseReviewReport(JSON.stringify({format:'review-report/v1',summary:'Summary',body:'Report',reviewGuide:reference,...change}))).toMatchObject({kind:'invalid'});
  }
 });
 test('never treats a malformed designated report as an unrelated ordinary guide',()=>{
  expect(parseReviewReport('{"format":"review-report/v1","summary":')).toMatchObject({kind:'invalid'});
 });
});

describe('canonical exact-manifest guide resolution',async()=>{
 test('resolves the exact sealed document and retains contributor provenance',async()=>{
  const {subject,document,reference}=canonical();const before=structuredClone(subject);
  const result=await resolveCanonicalReviewGuide({projectId:'project',subject,criterionIds,resolveDocument:(ref:DocumentRef)=>{expect(ref).toEqual(reference);return document;}});
  expect(result).toMatchObject({status:'available',guide:guide(),provenance:{kind:'contributor-authored',createdBy:subject.createdBy,createdAt:subject.createdAt}});expect(subject).toEqual(before);
 });
 test('a missing selector never scans document artifacts or filenames',async()=>{
  const {subject}=canonical();subject.report='Ordinary report';
  expect(await resolveCanonicalReviewGuide({projectId:'project',subject,criterionIds,resolveDocument:()=>{throw Error('Undesignated artifact must not be read');}})).toMatchObject({status:'missing'});
 });
 test('rejects a selector missing from the same immutable subject before resolving anything',async()=>{
  const {subject}=canonical();subject.artifacts=[];
  expect(await resolveCanonicalReviewGuide({projectId:'project',subject,criterionIds,resolveDocument:()=>{throw Error('Foreign selector must not be resolved');}})).toMatchObject({status:'invalid'});
 });
 test('does not substitute a newer version or another digest of the selected document',async()=>{
  const {subject,document}=canonical();
  for(const replacement of [{...document,id:'other-document'},{...document,version:2},{...document,contentDigest:'f'.repeat(64)}]){
   expect(await resolveCanonicalReviewGuide({projectId:'project',subject,criterionIds,resolveDocument:()=>replacement})).toMatchObject({status:'invalid'});
  }
 });
 test('rejects duplicate designated artifacts rather than choosing the first valid guide',async()=>{
  const {subject,document}=canonical();subject.artifacts.push({...subject.artifacts[0]!});
  expect(await resolveCanonicalReviewGuide({projectId:'project',subject,criterionIds,resolveDocument:()=>document})).toMatchObject({status:'ambiguous'});
 });
 test('foreign project documents and foreign subjects cannot supply review guidance',async()=>{
  const {subject,document}=canonical();
  expect(await resolveCanonicalReviewGuide({projectId:'project',subject,criterionIds,resolveDocument:()=>({...document,projectId:'foreign'})})).toMatchObject({status:'invalid'});
  expect(await resolveCanonicalReviewGuide({projectId:'foreign',subject,criterionIds,resolveDocument:()=>{throw Error('Foreign subject must not be resolved');}})).toMatchObject({status:'invalid'});
 });
 test('missing historical document is explicit and never falls back to an unpinned artifact',async()=>{
  const {subject}=canonical();expect(await resolveCanonicalReviewGuide({projectId:'project',subject,criterionIds,resolveDocument:()=>undefined})).toMatchObject({status:'unavailable'});
 });
 test('checks actual document bytes and pinned criterion membership after reference resolution',async()=>{
  const {subject,document}=canonical();
  expect(await resolveCanonicalReviewGuide({projectId:'project',subject,criterionIds,resolveDocument:()=>({...document,content:document.content+' '})})).toMatchObject({status:'invalid'});
  expect(await resolveCanonicalReviewGuide({projectId:'project',subject,criterionIds:['other'],resolveDocument:()=>document})).toMatchObject({status:'invalid'});
 });
});

describe('legacy exact immutable packet guide resolution',async()=>{
 test('reads only attempt/review-guide.json and labels its original contributor',async()=>{
  const revision=legacy();expect(await resolveLegacyReviewGuide({projectId:'project',revision,criterionIds})).toMatchObject({status:'available',guide:guide(),provenance:{kind:'contributor-authored',createdBy:revision.createdBy,createdAt:revision.createdAt}});
 });
 test('old packets and similarly named files remain honestly missing',async()=>{
  const revision=legacy();revision.files[0]!.path='review-guide.json';
  expect(await resolveLegacyReviewGuide({projectId:'project',revision,criterionIds})).toMatchObject({status:'missing'});
  expect(await resolveLegacyReviewGuide({projectId:'project',revision:{...revision,files:[]},criterionIds})).toMatchObject({status:'missing'});
 });
 test('ambiguous packet files are not resolved by picking a valid one',async()=>{
  const revision=legacy();revision.files.push({...revision.files[0]!});expect(await resolveLegacyReviewGuide({projectId:'project',revision,criterionIds})).toMatchObject({status:'ambiguous'});
 });
 test('rejects malformed, oversized or digest-mismatched packet guidance',async()=>{
  for(const text of ['{','x'.repeat(32769)]){
   const revision=legacy();revision.files[0]!.contentBase64=Buffer.from(text).toString('base64');revision.files[0]!.contentDigest=digest(text);
   expect(await resolveLegacyReviewGuide({projectId:'project',revision,criterionIds})).toMatchObject({status:'invalid'});
  }
  const invalidEncoding=legacy();invalidEncoding.files[0]!.contentBase64='%%%=';expect(await resolveLegacyReviewGuide({projectId:'project',revision:invalidEncoding,criterionIds})).toMatchObject({status:'invalid'});
  const revision=legacy();revision.files[0]!.contentDigest='f'.repeat(64);expect(await resolveLegacyReviewGuide({projectId:'project',revision,criterionIds})).toMatchObject({status:'invalid'});
 });
 test('rejects a foreign-project packet and foreign criterion mappings without modifying the revision',async()=>{
  const revision=legacy(),before=structuredClone(revision);
  expect(await resolveLegacyReviewGuide({projectId:'foreign',revision,criterionIds})).toMatchObject({status:'invalid'});
  expect(await resolveLegacyReviewGuide({projectId:'project',revision,criterionIds:['other']})).toMatchObject({status:'invalid'});expect(revision).toEqual(before);
 });
});


describe('legacy criterion presentation references',()=>{
 test('binds a presentation-only ID to the frozen spec digest and one-based position',()=>{
  const frozen='a'.repeat(64);expect(legacyReviewCriterionId(frozen,1)).toBe(`legacy:${frozen}:1`);
  expect(legacyReviewCriterionId(frozen,2)).not.toBe(legacyReviewCriterionId(frozen,1));
  expect(legacyReviewCriterionId('b'.repeat(64),1)).not.toBe(legacyReviewCriterionId(frozen,1));
 });
 test('refuses invalid digests and out-of-range positions instead of inventing canonical IDs',()=>{
  for(const [hash,position] of [['bad',1],['a'.repeat(64),0],['a'.repeat(64),201],['a'.repeat(64),1.5]] as const)expect(()=>legacyReviewCriterionId(hash,position)).toThrow();
 });
});

test('legacy guide refuses noncanonical base64 and invalid UTF-8 instead of guessing content',async()=>{
 const revision=legacy();let content=JSON.stringify(guide());while(Buffer.byteLength(content)%3===0)content+=' ';
 const encoded=Buffer.from(content).toString('base64'),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',index=encoded.endsWith('==')?encoded.length-3:encoded.length-2;
 const alias=encoded.slice(0,index)+alphabet[alphabet.indexOf(encoded[index]!)|1]+encoded.slice(index+1);
 expect(Buffer.from(alias,'base64').equals(Buffer.from(content))).toBe(true);
 revision.files[0]!.contentBase64=alias;revision.files[0]!.contentDigest=digest(content);
 expect(await resolveLegacyReviewGuide({projectId:'project',revision,criterionIds})).toMatchObject({status:'invalid'});
 const bytes=Buffer.from([255]);revision.files[0]!.contentBase64=bytes.toString('base64');revision.files[0]!.contentDigest=createHash('sha256').update(bytes).digest('hex');
 expect(await resolveLegacyReviewGuide({projectId:'project',revision,criterionIds})).toMatchObject({status:'invalid'});
});

test('unavailable cryptographic verification returns an explicit fallback for either model',async()=>{
 const {subject,document}=canonical(),unavailable=async()=>{throw Error('Cryptographic service unavailable');};
 expect(await resolveCanonicalReviewGuide({projectId:'project',subject,criterionIds,resolveDocument:async()=>document,digest:unavailable})).toMatchObject({status:'unavailable'});
 expect(await resolveLegacyReviewGuide({projectId:'project',revision:legacy(),criterionIds,digest:unavailable})).toMatchObject({status:'unavailable'});
});


test('unbound packet validation enforces structure while submission additionally binds pinned criterion IDs',()=>{
 const revision=legacy();expect(validateLegacyGuideStructure(revision)).toMatchObject({ok:true});
 expect(validateLegacyGuideForSubmission(revision,['foreign'])).toMatchObject({ok:false});
 expect(validateLegacyGuideForSubmission(revision,criterionIds)).toMatchObject({ok:true});
 expect(validateLegacyGuideStructure({...revision,files:[]})).toBeNull();
 const value=guide();value.steps[0]!.criterionIds=['future-pinned-id'];expect(validateReviewGuideStructure(JSON.stringify(value))).toMatchObject({ok:true});
 value.summary=' ';expect(validateReviewGuideStructure(JSON.stringify(value))).toMatchObject({ok:false});
});
