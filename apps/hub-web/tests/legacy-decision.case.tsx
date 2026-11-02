import {act,renderHook} from '@testing-library/react';
import {beforeEach,expect,test,vi} from 'vitest';
import {HubContext,type HubContextValue} from '../src/app/hub-context';
import type {HubFlow} from '../src/api/types';
import {resetClient} from '../src/api/client';
import {useDraftStore} from '../src/state/drafts';
import {useLegacyDecision} from '../src/features/acceptance/use-legacy-decision';
import type {DecisionInput} from '../src/features/acceptance/model';
const hash='a'.repeat(64);
const flow:HubFlow={id:'flow',projectId:'p',title:'Result',specDocumentId:'spec',specContentDigest:hash,criteria:['First','Second'],status:'implemented',version:4,subjectRevisionId:'subject'};
const context:HubContextValue={projectId:'p',principal:{id:'human:reviewer',kind:'human',role:'reviewer'},scopeKey:1,location:{projectId:'p',tab:'flows'},navigate:()=>undefined,refresh:async()=>undefined};
const input:DecisionInput={decision:'request-changes',comment:'  Fix the result  ',criterionIds:[`legacy:${hash}:2`],waivers:[]};
type Sent={url:string;method:string;key:string|null;body:Record<string,unknown>};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
function sent(path:RequestInfo|URL,init?:RequestInit):Sent{return{url:String(path),method:init?.method??'GET',key:new Headers(init?.headers).get('Idempotency-Key'),body:init?.body?JSON.parse(String(init.body)):{}};}
function receipt(request:Sent){return{status:'committed',operationId:request.key,flowVersion:5,flowState:'in-progress',decision:{id:'return',flowId:'flow',subjectRevisionId:'subject',specContentDigest:hash,comment:'Fix the result',criterionRefs:[{specContentDigest:hash,position:2}],actorId:'human:reviewer',actorKind:'human',createdAt:'2026-11-03T00:00:00.000Z'}};}
function mount(onCommitted=vi.fn(),initialFlow=flow,initialContext=context){
 let ctx=initialContext;
 const view=renderHook(({candidate})=>useLegacyDecision(candidate,onCommitted),{initialProps:{candidate:initialFlow},wrapper:({children})=><HubContext.Provider value={ctx}>{children}</HubContext.Provider>});
 return{...view,onCommitted,change(candidate:HubFlow,nextContext=ctx){ctx=nextContext;view.rerender({candidate});}};
}
beforeEach(()=>{useDraftStore.getState().clearAll();resetClient();sessionStorage.clear();});

test('return freezes the exact target, trims the comment and decodes only frozen legacy criterion references',async()=>{
 const requests:Sent[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(path,init)=>{const request=sent(path,init);requests.push(request);return json(receipt(request));});
 const view=mount();let result;await act(async()=>{result=await view.result.current.run(input);});
 expect(result).toEqual({status:'committed'});expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({url:'/hub/v1/projects/p/flows/flow/request-changes',method:'POST',body:{expectedVersion:4,subjectRevisionId:'subject',comment:'Fix the result',criterionRefs:[{specContentDigest:hash,position:2}]}});
 expect(requests[0]!.key).toBeTruthy();expect(view.onCommitted).toHaveBeenCalledOnce();expect(view.result.current.pending).toBe(false);
});
test('lost response survives remount; receipt404 stays unknown and only explicit retry uses the original key/body',async()=>{
 const requests:Sent[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(path,init)=>{const request=sent(path,init);requests.push(request);if(request.method==='GET')return json({error:{code:'operation-not-found',message:'Unknown'}},404);if(requests.length===1)throw new TypeError('Reply lost');return json(receipt(request));});
 const first=mount();await act(async()=>{expect(await first.result.current.run(input)).toMatchObject({status:'unknown'});});expect(first.result.current.pending).toBe(true);const original=structuredClone(requests[0]);first.unmount();useDraftStore.getState().clearAll();
 const recovered=mount();expect(recovered.result.current.pending).toBe(true);expect(requests).toHaveLength(1);
 await act(async()=>{expect(await recovered.result.current.check()).toMatchObject({status:'unknown'});});expect(recovered.result.current.pending).toBe(true);expect(recovered.onCommitted).not.toHaveBeenCalled();
 expect(requests[1]!.url).toBe(`/hub/v1/projects/p/flows/flow/review-operations/${original.key}`);
 await act(async()=>{expect(await recovered.result.current.run({...input,comment:'Changed'})).toMatchObject({status:'unknown'});});expect(requests).toHaveLength(2);
 await act(async()=>{expect(await recovered.result.current.retry()).toEqual({status:'committed'});});expect(requests[2]).toEqual(original);expect(recovered.onCommitted).toHaveBeenCalledOnce();
});
test('a later403 cannot erase a possibly committed original or retarget its retry to a new Flow version',async()=>{
 const requests:Sent[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(path,init)=>{requests.push(sent(path,init));if(requests.length===1)throw new TypeError('Lost');return json({error:{code:'forbidden',message:'Revoked'}},403);});
 const view=mount();await act(()=>view.result.current.run(input));view.change({...flow,version:8});await act(async()=>{expect(await view.result.current.retry()).toMatchObject({status:'unknown'});});expect(requests[1]).toEqual(requests[0]);expect(view.result.current.pending).toBe(true);expect(view.onCommitted).not.toHaveBeenCalled();
});
test('same-tick double click starts one request and a foreign target cannot receive its completion callback',async()=>{
 let finish!:(response:Response)=>void;const requests:Sent[]=[];vi.spyOn(globalThis,'fetch').mockImplementation((path,init)=>{requests.push(sent(path,init));return new Promise(resolve=>{finish=resolve;});});
 const view=mount();let first!:ReturnType<typeof view.result.current.run>;
 act(()=>{first=view.result.current.run(input);void view.result.current.run(input);});expect(requests).toHaveLength(1);
 view.change({...flow,id:'other',subjectRevisionId:'other-subject'});await act(async()=>{finish(json(receipt(requests[0]!)));await first;});expect(view.onCommitted).not.toHaveBeenCalled();
});
test('project/reviewer and authentication switches do not receive an old request completion',async()=>{
 let finish!:(response:Response)=>void;const requests:Sent[]=[];vi.spyOn(globalThis,'fetch').mockImplementation((path,init)=>{requests.push(sent(path,init));return new Promise(resolve=>{finish=resolve;});});
 const view=mount();let first!:ReturnType<typeof view.result.current.run>;act(()=>{first=view.result.current.run(input);});
 view.change({...flow,projectId:'q'},{...context,projectId:'q',principal:{...context.principal,id:'other'}});resetClient();await act(async()=>{finish(json(receipt(requests[0]!)));await first;});expect(view.onCommitted).not.toHaveBeenCalled();
});
test('first-send403/409 are definite rejections, while a mismatched200 receipt remains unknown',async()=>{
 for(const [status,code] of [[403,'human-required'],[409,'stale-version']] as const){
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(json({error:{code,message:'Refused'}},status));const view=mount();await act(async()=>{expect(await view.result.current.run(input)).toEqual({status:'rejected',code});});expect(view.result.current.pending).toBe(false);expect(view.onCommitted).not.toHaveBeenCalled();view.unmount();fetch.mockRestore();
 }
 vi.spyOn(globalThis,'fetch').mockResolvedValue(json({status:'committed',operationId:'foreign',flowVersion:5,flowState:'in-progress'}));const view=mount();await act(async()=>{expect(await view.result.current.run(input)).toMatchObject({status:'unknown'});});expect(view.result.current.pending).toBe(true);expect(view.onCommitted).not.toHaveBeenCalled();
});
test('invalid comments, foreign or out-of-range criterion IDs and agents cannot send a decision',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch');const view=mount();
 for(const invalid of [{...input,comment:' '},{...input,comment:'x'.repeat(4001)},{...input,criterionIds:[`legacy:${'b'.repeat(64)}:1`]},{...input,criterionIds:[`legacy:${hash}:3`]},{...input,criterionIds:[`legacy:${hash}:1`,`legacy:${hash}:1`]}])await act(async()=>{expect(await view.result.current.run(invalid)).toMatchObject({status:'rejected'});});
 view.change(flow,{...context,principal:{id:'agent',kind:'agent',role:'agent'}});await act(async()=>{expect(await view.result.current.run(input)).toMatchObject({status:'rejected'});});expect(fetch).not.toHaveBeenCalled();
});
test('accept uses the existing acknowledgment and exact subject/version without inventing a legacy waiver',async()=>{
 const requests:Sent[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(path,init)=>{const request=sent(path,init);requests.push(request);return json({...flow,status:'done',version:5,acceptedBy:context.principal.id,receipt:{id:'accept-receipt',actorId:context.principal.id,createdAt:'2026-11-03T00:00:00.000Z'}});});
 const view=mount();await act(async()=>{expect(await view.result.current.run({...input,decision:'accept',criterionIds:[],waivers:[]})).toEqual({status:'committed'});});
 expect(requests[0]).toMatchObject({url:'/hub/v1/projects/p/flows/flow/accept',body:{expectedVersion:4,subjectRevisionId:'subject',acknowledgeSelfReportedEvidence:true}});expect(view.onCommitted).toHaveBeenCalledOnce();
});

test('an unmounted review cannot receive an in-flight completion callback',async()=>{
 let finish!:(response:Response)=>void;let request!:Sent;vi.spyOn(globalThis,'fetch').mockImplementation((path,init)=>{request=sent(path,init);return new Promise(resolve=>{finish=resolve;});});
 const view=mount();let first!:ReturnType<typeof view.result.current.run>;act(()=>{first=view.result.current.run(input);});view.unmount();await act(async()=>{finish(json(receipt(request)));await first;});expect(view.onCommitted).not.toHaveBeenCalled();
});
test('a same-principal authority downgrade cannot receive the previous completion callback',async()=>{
 let finish!:(response:Response)=>void;let request!:Sent;vi.spyOn(globalThis,'fetch').mockImplementation((path,init)=>{request=sent(path,init);return new Promise(resolve=>{finish=resolve;});});
 const view=mount();let first!:ReturnType<typeof view.result.current.run>;act(()=>{first=view.result.current.run(input);});view.change(flow,{...context,principal:{...context.principal,readOnly:true}});await act(async()=>{finish(json(receipt(request)));await first;});expect(view.onCommitted).not.toHaveBeenCalled();
});
test('receipt recovery commits the original result without sending another mutation',async()=>{
 const requests:Sent[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(path,init)=>{requests.push(sent(path,init));if(requests.length===1)throw new TypeError('Reply lost');return json(receipt(requests[0]!));});
 const view=mount();await act(()=>view.result.current.run(input));await act(async()=>{expect(await view.result.current.check()).toEqual({status:'committed'});});expect(requests.map(r=>r.method)).toEqual(['POST','GET']);expect(view.onCommitted).toHaveBeenCalledOnce();expect(view.result.current.pending).toBe(false);
});
