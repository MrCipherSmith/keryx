import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { acceptanceFixture, mountAcceptance, returnedDecision, type AcceptanceFixture } from './flow-acceptance.fixture';
let fixture:AcceptanceFixture;
beforeEach(async()=>{fixture=await acceptanceFixture();});
function openTechnical(){fireEvent.click(screen.getByText('Technical details',{selector:'summary'}));}
function history(){return screen.getByRole('region',{name:'Review decision history'});}

test('legacy return history survives a new submitted candidate and its acceptance through the live adapter boundary',async()=>{
 const decision=returnedDecision(fixture),replacement={...fixture.legacyResult,id:'replacement-result',files:[]};let returned=false;
 fixture.respond=request=>{
  if(request.url.includes('/review-decisions?'))return Response.json({decisions:returned?[decision]:[],nextAfter:null});
  if(request.url.includes('/revisions?summary=1'))return Response.json({revisions:[{...replacement,fileCount:0}]});
  if(request.url.endsWith('/revisions/replacement-result'))return Response.json(replacement);
  if(request.method==='POST'&&request.url.endsWith('/request-changes')){
   returned=true;Object.assign(fixture.legacyFlow,{version:5,status:'in-progress',subjectRevisionId:null,lastReturnDecisionId:decision.id,reviewFeedback:decision});
   return Response.json({status:'committed',operationId:request.headers.get('Idempotency-Key'),flowVersion:5,flowState:'in-progress',decision});
  }
  if(request.method==='POST'&&request.url.endsWith('/submit-for-review')){
   expect(request.body).toMatchObject({expectedVersion:5,subjectRevisionId:replacement.id,afterReturnDecisionId:decision.id});
   Object.assign(fixture.legacyFlow,{version:6,status:'implemented',subjectRevisionId:replacement.id,reviewFeedback:null});return Response.json(fixture.legacyFlow);
  }
  if(request.method==='POST'&&request.url.endsWith('/accept')){
   const accepted={...fixture.legacyFlow,version:7,status:'done',acceptedBy:'human:reviewer',acceptedAt:'2026-11-03T09:00:00Z',receipt:{id:'final-receipt',actorId:'human:reviewer',actorKind:'human',createdAt:'2026-11-03T09:00:00Z'}};
   Object.assign(fixture.legacyFlow,accepted);return Response.json(accepted);
  }
 };
 mountAcceptance('legacy');fireEvent.click(await screen.findByRole('button',{name:'Return for changes'}));
 fireEvent.change(screen.getByRole('textbox',{name:'Return comment'}),{target:{value:decision.comment}});
 fireEvent.click(screen.getByRole('checkbox',{name:'Relate to: Keyboard focus remains visible'}));fireEvent.click(screen.getByRole('button',{name:'Confirm return'}));
 const candidate=await screen.findByLabelText('Candidate revision');
 await waitFor(()=>expect(within(candidate).getByRole('option',{name:/Keyboard navigation candidate/})).toBeInTheDocument());
 fireEvent.change(candidate,{target:{value:replacement.id}});fireEvent.click(screen.getByRole('button',{name:'Submit for review'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Review updated result'})).toBeVisible());fireEvent.click(screen.getByRole('button',{name:'Review updated result'}));
 const accept=screen.getByRole('button',{name:'Accept result'});await waitFor(()=>expect(accept).toBeEnabled());fireEvent.click(accept);
 fireEvent.click(screen.getByRole('checkbox',{name:/self.reported|supplied reports/i}));fireEvent.click(screen.getByRole('button',{name:'Confirm acceptance'}));
 expect(await screen.findByText('Completed result — read only')).toBeVisible();openTechnical();
 expect(await within(history()).findByText(decision.comment)).toBeVisible();
 expect(history()).toHaveTextContent(decision.actorId);expect(history()).toHaveTextContent(decision.subjectRevisionId);expect(history()).toHaveTextContent('Criterion 1');
 expect(fixture.requests.filter(request=>request.method==='POST')).toHaveLength(3);
});

test('legacy history is explicitly empty for old Flows without inventing review decisions',async()=>{
 fixture.respond=request=>request.url.includes('/review-decisions?')?Response.json({decisions:[],nextAfter:null}):undefined;
 mountAcceptance('legacy');await screen.findByRole('heading',{name:'What was done'});openTechnical();
 expect(await within(history()).findByText('No recorded return decisions')).toBeVisible();
 expect(within(history()).queryByText('human:reviewer')).not.toBeInTheDocument();
});

test('legacy history loads bounded older pages without losing the current page',async()=>{
 const latest=returnedDecision(fixture),older={...latest,id:'older/id',comment:'Earlier keyboard regression',subjectRevisionId:'old-result',createdAt:'2026-11-02T08:00:00Z'};
 fixture.respond=request=>request.url.includes('/review-decisions?')?Response.json(request.url.includes('after=')?{decisions:[older],nextAfter:null}:{decisions:[latest],nextAfter:latest.id}):undefined;
 mountAcceptance('legacy');await screen.findByRole('heading',{name:'What was done'});openTechnical();
 expect(await within(history()).findByText(latest.comment)).toBeVisible();fireEvent.click(within(history()).getByRole('button',{name:'Load older decisions'}));
 expect(await within(history()).findByText(older.comment)).toBeVisible();expect(within(history()).getByText(latest.comment)).toBeVisible();
 expect(fixture.requests.filter(request=>request.url.includes('/review-decisions?')).map(request=>request.url)).toEqual(['/hub/v1/projects/p/flows/legacy-flow/review-decisions?limit=20','/hub/v1/projects/p/flows/legacy-flow/review-decisions?limit=20&after=return-1']);
 expect(within(history()).queryByRole('button',{name:'Load older decisions'})).not.toBeInTheDocument();
});

test('legacy history exposes loading and retry without replacing an unavailable page with fabricated history',async()=>{
 let resolve!:(response:Response)=>void;let calls=0;
 fixture.respond=request=>{if(request.url.includes('/review-decisions?')){calls++;return calls===1?new Promise<Response>(done=>{resolve=done;}):Response.json({decisions:[returnedDecision(fixture)],nextAfter:null});}};
 mountAcceptance('legacy');await screen.findByRole('heading',{name:'What was done'});openTechnical();
 expect(within(history()).getByText('Loading review history…')).toBeVisible();
 await act(async()=>resolve(Response.json({error:{code:'offline',message:'Unavailable'}},{status:503})));
 expect(await within(history()).findByText('Review history is unavailable')).toBeVisible();
 fireEvent.click(within(history()).getByRole('button',{name:'Retry history'}));expect(await within(history()).findByText(returnedDecision(fixture).comment)).toBeVisible();
});

test('a late legacy history response cannot appear under another project',async()=>{
 let resolve!:(response:Response)=>void;
 fixture.respond=request=>{if(request.url.includes('/review-decisions?'))return request.url.includes('/projects/p/')?new Promise<Response>(done=>{resolve=done;}):Response.json({decisions:[],nextAfter:null});};
 const view=mountAcceptance('legacy');await screen.findByRole('heading',{name:'What was done'});openTechnical();
 expect(within(history()).getByText('Loading review history…')).toBeVisible();
 view.scope({projectId:'other',location:{projectId:'other',tab:'flows',flowId:'legacy-flow'}});
 await act(async()=>resolve(Response.json({decisions:[returnedDecision(fixture)],nextAfter:null})));
 await screen.findByRole('heading',{name:'What was done'});openTechnical();
 expect(await within(history()).findByText('No recorded return decisions')).toBeVisible();expect(screen.queryByText(returnedDecision(fixture).comment)).not.toBeInTheDocument();
});
