import { createHash, webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { HubContext, type HubContextValue } from '../src/app/hub-context';
import { FlowsView, OverviewView } from '../src/features/workflow';
import { ManagedWorkView } from '../src/features/managed-work/view';
import { demoWorkAdapter } from '../src/features/managed-work/demo';
import { recordOf } from '../src/features/managed-work/model';
import { resetClient } from '../src/api/client';
import { useDraftStore } from '../src/state/drafts';
import i18n from '../src/i18n';

const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
export type ObservedRequest={url:string;method:string;body:Record<string,unknown>|undefined;headers:Headers};
export async function acceptanceFixture(language:'en'|'ru'='en'){
 vi.stubGlobal('crypto',webcrypto);
 resetClient();useDraftStore.getState().clearAll();await i18n.changeLanguage(language);
 const records=(await demoWorkAdapter('p').snapshot()).records;
 const intent=recordOf(records,'intent','i1')!;intent.selectedSubmissionId='sub-agent';
 const attempt=recordOf(records,'attempt','a-agent')!;
 const subject=recordOf(records,'subject','subject-agent')!;
 const submission=recordOf(records,'submission','sub-agent')!;
 const revision=recordOf(records,'intent-revision',submission.intentRevisionId)!;
 const specContent='# Pinned product specification';const specDigest=digest(specContent);
 const guide={format:'review-guide/v1',summary:'Keyboard navigation delivered',userImpact:'Reviewers can navigate without a mouse',limitations:['Safari requires a manual check'],prerequisites:['Open the disposable project'],steps:[{stepId:'keyboard-check',criterionIds:[revision.criteria[0]!.criterionId],location:'Hub browser',instruction:"printf 'review-only'",expectedResult:'The highlighted result is visible'}]};
 const guideContent=JSON.stringify(guide), guideDigest=digest(guideContent);
 const guideRef={documentId:'guide-doc',version:1,contentDigest:guideDigest};
 subject.report=JSON.stringify({format:'review-report/v1',summary:'Keyboard navigation delivered',body:'Contributor implementation report',reviewGuide:guideRef});
 subject.artifacts.push({kind:'document',reference:guideRef,proposalId:null});
 const legacyGuide={...guide,steps:guide.steps.map(step=>({...step,criterionIds:[`legacy:${specDigest}:1`]}))};
 const legacyGuideContent=JSON.stringify(legacyGuide);
 const spec={id:'spec-doc',projectId:'p',path:'specs/acceptance.md',kind:'spec',version:1,contentDigest:specDigest,content:specContent,approval:'unreviewed',sourceRevision:'test-fixture'};
 const legacyFlow={id:'legacy-flow',projectId:'p',title:'Keyboard navigation',status:'implemented',version:4,criteria:['Keyboard focus remains visible','Screen reader labels are clear'],specDocumentId:spec.id,specContentDigest:specDigest,subjectRevisionId:'legacy-result' as string|null,acceptedBy:null as string|null,acceptedAt:null as string|null,lastReturnDecisionId:null as string|null,reviewFeedback:null as null|Record<string,unknown>};
 const legacyResult={id:'legacy-result',projectId:'p',baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'Keyboard navigation candidate',purpose:'review-bundle',createdBy:'agent:author',createdAt:'2026-11-03T08:00:00Z',treeDigest:'b'.repeat(64),files:[{path:'attempt/review-guide.json',mode:'100644',contentBase64:Buffer.from(legacyGuideContent).toString('base64'),contentDigest:digest(legacyGuideContent)}]};
 const legacyEvidence=[{id:'legacy-evidence',projectId:'p',flowId:legacyFlow.id,subjectRevisionId:legacyResult.id,checkId:'Named CI check (contributor claim)',command:'bun test',exitCode:0,output:'All checks passed',actorId:'agent:author',createdAt:'2026-11-03T08:05:00Z'}];
 const requests:ObservedRequest[]=[];
 const fixture={records,attempt,intent,subject,submission,revision,guide,guideContent,guideDigest,guideRef,spec,legacyFlow,legacyResult,legacyEvidence,requests,respond:undefined as undefined|((request:ObservedRequest)=>Response|Promise<Response>|undefined),documentStatus:200};
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=String(input);const request={url,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:undefined,headers:new Headers(init?.headers)};requests.push(request);
  const overridden=fixture.respond?.(request);if(overridden)return overridden;
  const path=new URL(url,'http://localhost').pathname;const project=path.split('/projects/')[1]?.split('/')[0]??'p';
  if(path.startsWith('/hub/work/v1/')){
   if(path.endsWith('/capabilities'))return Response.json({protocolVersion:1,enabled:true,allowedCommands:['attempt.select','review.decide','flow.submit','context.create','requirements.amend'],limits:{maxCommandBytes:65536,defaultPageSize:50,maxPageSize:200,maxEventPageSize:1000,maxEventBytes:1048576,maxSnapshotBytes:20971520},features:{managedExecution:false,gitObserver:false,legacyConversion:false}});
   if(path.includes('/documents/guide-doc/versions/1'))return fixture.documentStatus===200?Response.json({document:{id:'guide-doc',projectId:'p',path:'guides/result.json',version:1,contentDigest:guideDigest,kind:'spec',content:fixture.guideContent}}):Response.json({error:{code:'not-found',message:'Guide unavailable'}},{status:fixture.documentStatus});
   if(path.endsWith('/snapshot'))return Response.json({records:fixture.records,eventCursor:'cursor-1',nextCursor:null});
   if(path.endsWith('/events'))return Response.json({events:[],nextCursor:'cursor-1'});
   if(path.endsWith('/attention'))return Response.json({records:[],nextCursor:null,eventCursor:'cursor-1'});
   if(path.endsWith('/commands'))return Response.json({operationId:request.body?.operationId,status:'committed',receiptId:'test-receipt',entities:[],eventCursor:'cursor-2'});
   if(path.includes('/operations/'))return Response.json({error:{code:'operation-not-found',message:'Outcome unknown'}},{status:404});
  }
  if(path==='/hub/v1/projects')return Response.json({projects:[{id:'p',name:'Disposable project'}]});
  if(path.endsWith('/projects/'+project))return Response.json({id:project,name:'Disposable project',lineVersion:0,lineRevisionId:null});
  if(path.endsWith('/flows'))return Response.json({flows:[{...fixture.legacyFlow,projectId:project}]});
  if(path.endsWith('/flows/legacy-flow'))return Response.json({...fixture.legacyFlow,projectId:project});
  if(path.endsWith('/evidence'))return Response.json({evidence:fixture.legacyEvidence});
  if(path.endsWith('/review-decisions'))return Response.json({decisions:[],nextAfter:null});
  if(path.endsWith('/documents'))return Response.json({documents:[{...spec,projectId:project}]});
  if(path.endsWith('/revisions/legacy-result'))return Response.json({...fixture.legacyResult,projectId:project});
  if(path.endsWith('/revisions'))return Response.json({revisions:[{...fixture.legacyResult,fileCount:fixture.legacyResult.files.length}]});
  if(path.endsWith('/proposals'))return Response.json({proposals:[]});
  if(path.endsWith('/machines'))return Response.json({machines:[]});
  if(path.endsWith('/sessions'))return Response.json({sessions:[],cursor:0,hasMore:false});
  return Response.json({error:{code:'not-found',message:'No test route'}},{status:404});
 });
 return fixture;
}
export type AcceptanceFixture=Awaited<ReturnType<typeof acceptanceFixture>>;
export function mountAcceptance(model:'canonical'|'legacy'|'overview',patch:Partial<HubContextValue>={}){
 const cache=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 let context:HubContextValue={projectId:'p',scopeKey:73,principal:{id:'human:reviewer',kind:'human',role:'operator'},location:model==='canonical'?{projectId:'p',tab:'work',flowId:'flow-demo',intentId:'i1',attemptId:'a-agent'}:{projectId:'p',tab:'flows',flowId:'legacy-flow'},navigate:vi.fn(),refresh:async()=>undefined,...patch};
 const tree=()=> <QueryClientProvider client={cache}><HubContext.Provider value={context}>{model==='canonical'?<ManagedWorkView/>:model==='legacy'?<FlowsView/>:<OverviewView/>}</HubContext.Provider></QueryClientProvider>;
 const mounted=render(tree());return{...mounted,cache,get context(){return context;},scope(next:Partial<HubContextValue>){context={...context,...next};mounted.rerender(tree());}};
}
export function addCoverageCases(fixture:AcceptanceFixture){
 const criteria=[['ci1','Passing criterion'],['ci-fail','Failing criterion'],['ci-unknown','Inconclusive criterion'],['ci-missing','Missing criterion'],['ci-conflict','Conflicting criterion']] as const;
 fixture.revision.criteria=criteria.map(([criterionId,text])=>({criterionId,text,waivable:false}));
 const template=recordOf(fixture.records,'evidence','ev-agent')!;
 const coverage=criteria.map(([criterionId],index)=>{
  const kinds=index===4?['pass','fail'] as const:[index===0?'pass':index===1?'fail':'inconclusive'] as const;
  const evidence=index===3?[]:kinds.map((result,j)=>({...template,id:`support-${index}-${j}`,criterionIds:[criterionId],result,report:`Evidence for ${criterionId}: ${result}`}));
  fixture.records.push(...evidence);
  return {criterionId,result:index===0||index===4?'pass' as const:index===1?'fail' as const:index===3?'missing' as const:'inconclusive' as const,evidenceIds:evidence.map(record=>record.id)};
 });
 fixture.submission.coverage=coverage;fixture.submission.evidenceIds=coverage.flatMap(row=>row.evidenceIds);
}
export function returnedDecision(fixture:AcceptanceFixture){return{id:'return-1',flowId:fixture.legacyFlow.id,subjectRevisionId:fixture.legacyResult.id,specContentDigest:fixture.spec.contentDigest,comment:'Please verify keyboard focus in Safari',criterionRefs:[{specContentDigest:fixture.spec.contentDigest,position:1}],actorId:'human:reviewer',actorKind:'human',createdAt:'2026-11-03T08:10:00Z'};}
export function mutationRequests(fixture:AcceptanceFixture){return fixture.requests.filter(request=>request.method==='POST');}
