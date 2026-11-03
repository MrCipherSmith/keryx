import {fireEvent,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,test} from 'vitest';
import {acceptanceFixture,mountAcceptance,mutationRequests,type AcceptanceFixture,type ObservedRequest} from './flow-acceptance.fixture';
import {useDraftStore} from '../src/state/drafts';
let fixture:AcceptanceFixture;
beforeEach(async()=>{fixture=await acceptanceFixture();});
const log=(id:string,value:unknown)=>console.log('EMPIRICAL_PROBE '+id+' '+JSON.stringify(value));
function returnReceipt(original:ObservedRequest){return {status:'committed',operationId:original.headers.get('Idempotency-Key'),flowVersion:5,flowState:'in-progress',decision:{id:'return-original-A',flowId:fixture.legacyFlow.id,subjectRevisionId:fixture.legacyResult.id,specContentDigest:fixture.spec.contentDigest,comment:original.body!.comment,criterionRefs:original.body!.criterionRefs,actorId:'human:reviewer',actorKind:'human',createdAt:'2026-11-03T08:10:00Z'}};}

test.each(['check','retry'] as const)('F-001 %s of original return A preserves newer unsent B',async recovery=>{
 let original:ObservedRequest|undefined;
 fixture.respond=request=>{
  if(request.method==='POST'&&request.url.endsWith('/request-changes')){
   if(!original){original=request;return Promise.reject(new TypeError('Synthetic lost response after original A committed'));}
   return Response.json(returnReceipt(original));
  }
  if(request.method==='GET'&&request.url.includes('/review-operations/'))return Response.json(returnReceipt(original!));
 };
 const mounted=mountAcceptance('legacy');
 const open=await screen.findByRole('button',{name:'Return for changes'});await waitFor(()=>expect(open).toBeEnabled());fireEvent.click(open);
 const comment=await screen.findByRole('textbox',{name:'Return comment'});fireEvent.change(comment,{target:{value:'Original return comment A'}});fireEvent.click(screen.getByRole('button',{name:'Confirm return'}));
 const recoveryButton=await screen.findByRole('button',{name:recovery==='check'?'Check decision status':'Retry identical decision'});await waitFor(()=>expect(recoveryButton).toBeEnabled());
 expect(original?.body?.comment).toBe('Original return comment A');
 fireEvent.change(comment,{target:{value:'New unsent reviewer draft B'}});expect(comment).toHaveValue('New unsent reviewer draft B');
 const before=structuredClone(useDraftStore.getState().drafts);expect(Object.values(before)).toContain('New unsent reviewer draft B');fireEvent.click(recoveryButton);
 await screen.findByText('Returned for changes',{selector:'[role=status]'});
 const after=structuredClone(useDraftStore.getState().drafts);const requests=fixture.requests.filter(r=>r.url.includes('/request-changes')||r.url.includes('/review-operations/')).map(r=>({method:r.method,url:r.url,key:r.headers.get('Idempotency-Key'),body:r.body}));
 log('F-001',{recovery,before,after,requests,originalCommittedComment:original!.body!.comment});
 expect.soft(original!.body!.comment).toBe('Original return comment A');
 if(recovery==='check')expect.soft(mutationRequests(fixture)).toHaveLength(1);else expect.soft(mutationRequests(fixture)[1]!.body).toEqual(original!.body);
 expect(Object.values(after),'A successful reconciliation of A must preserve the newer unsent draft B').toContain('New unsent reviewer draft B');
 mounted.unmount();mounted.cache.clear();
});
