import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import type { HubContextValue } from "../src/app/hub-context";
import { resetClient } from "../src/api/client";
import i18n from "../src/i18n";
import { liveWorkAdapter } from "../src/features/managed-work/adapter";
import { demoWorkAdapter } from "../src/features/managed-work/demo";
import { useWorkEvents } from "../src/features/managed-work/updates";
import { useWorkOperation } from "../src/features/managed-work/operation";
import { ManagedWorkView } from "../src/features/managed-work/view";
import { workSnapshotKey } from "../src/features/managed-work/cache";
import { recordOf } from "../src/features/managed-work/model";
import type { WorkEvent, WorkSnapshot, WorkCommand, WorkRecord } from "../src/features/managed-work/types";
import { renderHub } from "./hub-render";

const context: HubContextValue = {projectId:"p",scopeKey:99,principal:{id:"human:test",kind:"human",role:"operator"},location:{projectId:"p",tab:"work"},navigate:()=>undefined,refresh:async()=>undefined};
const key=workSnapshotKey(99,"p","live");
const attentionKey=[99,"p","work","live","attention"];
const observationsKey=[99,"p","work","live","observations","subject-agent"];
const documentKey=[99,"p","work","live","document","exact"];
let snapshot: WorkSnapshot;
const requests:string[]=[];
const adapter=liveWorkAdapter("p");
const capabilities={protocolVersion:1,enabled:true,allowedCommands:["attempt.select","review.decide"],limits:{},features:{managedExecution:false,gitObserver:false,legacyConversion:false}};
function event(record: WorkRecord, sequence=1): WorkEvent {
  return {protocolVersion:1,projectId:"p",sequence,eventId:"event-"+sequence,operationId:"operation-"+sequence,actorId:"human:test",actorKind:"human",occurredAt:"2026-11-02T00:00:00Z",type:record.kind==="intent"?"intent-changed":"flow-changed",entityType:record.kind==="intent"?"intent":"flow",entityId:record.id,entityVersion:"version" in record?record.version:null,contentDigest:"contentDigest" in record?record.contentDigest:null,causationId:null};
}
function client() {return new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});}
function response(records=snapshot.records,cursor="cursor-1"){return Response.json({records,eventCursor:cursor,nextCursor:null});}
function route(handler:(path:string,init?:RequestInit)=>Response|Promise<Response>){vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{const path=String(input);requests.push(path);return handler(path,init);});}
function Probe(){return <span>{useWorkEvents(adapter,"cursor-0")}</span>;}
beforeEach(async()=>{resetClient();requests.length=0;snapshot=await demoWorkAdapter("p").snapshot();snapshot.eventCursor="cursor-0";await i18n.changeLanguage("en");});

test("live overview events refresh attention without discarded per-record requests",async()=>{
  const flow=recordOf(snapshot.records,"flow","flow-demo")!;
  const events=Array.from({length:40},(_,index)=>event({...flow,id:"flow-"+index},index+1));
  route(path=>path.includes("/events?")?Response.json({events,nextCursor:"cursor-40"}):path.includes("/records/")?Response.json({record:{...flow,id:path.split("/").at(-1)!},eventCursor:"cursor-40"}):response());
  const cache=client();cache.setQueryData(attentionKey,{pages:[],pageParams:[]});
  renderHub(<Probe/>,context,cache);
  await screen.findByText("connected");
  expect(requests.filter(path=>path.includes("/records/"))).toHaveLength(0);
  expect(cache.getQueryState(attentionKey)?.isInvalidated).toBe(true);
  expect(cache.getQueryData(key)).toBeUndefined();
});

test("live burst catch-up uses one canonical snapshot instead of unbounded record fanout",async()=>{
  const flow=recordOf(snapshot.records,"flow","flow-demo")!;
  const changed=Array.from({length:80},(_,index)=>({...flow,id:"flow-"+index}));
  route(path=>path.includes("/events?")?Response.json({events:changed.map((record,index)=>event(record,index+1)),nextCursor:"cursor-80"}):path.includes("/records/")?Response.json({record:changed.find(record=>path.endsWith(record.id)),eventCursor:"cursor-80"}):response([...snapshot.records,...changed],"cursor-80"));
  const cache=client();cache.setQueryData(key,snapshot);
  renderHub(<Probe/>,context,cache);await screen.findByText("connected");
  expect(requests.filter(path=>path.includes("/records/"))).toHaveLength(0);
  expect(requests.filter(path=>path.includes("/snapshot?"))).toHaveLength(1);
  expect(cache.getQueryData<WorkSnapshot>(key)?.records.some(record=>record.id==="flow-79")).toBe(true);
});

test("matching live events still invalidate attention after a receipt already merged the version",async()=>{
  const flow=recordOf(snapshot.records,"flow","flow-demo")!;
  route(path=>path.includes("/events?")?Response.json({events:[event(flow)],nextCursor:"cursor-1"}):response());
  const cache=client();cache.setQueryData(key,snapshot);cache.setQueryData(attentionKey,{pages:[],pageParams:[]});
  renderHub(<Probe/>,context,cache);await screen.findByText("connected");
  expect(requests.filter(path=>path.includes("/records/"))).toHaveLength(0);
  expect(cache.getQueryState(attentionKey)?.isInvalidated).toBe(true);
});

test("live retention-gap resync refreshes attention and observations while exact documents stay immutable",async()=>{
  const flow=recordOf(snapshot.records,"flow","flow-demo")!;const newer={...flow,version:flow.version+1};
  route(path=>path.includes("/events?")?Response.json({error:{code:"expired",message:"retention gap"}},{status:410}):response(snapshot.records.map(record=>record.id===flow.id?newer:record)));
  const cache=client();cache.setQueryData(key,snapshot);cache.setQueryData(attentionKey,{pages:[],pageParams:[]});cache.setQueryData(observationsKey,{pages:[],pageParams:[]});cache.setQueryData(documentKey,{content:"immutable"});
  renderHub(<Probe/>,context,cache);
  await waitFor(()=>expect(recordOf(cache.getQueryData<WorkSnapshot>(key)!.records,"flow",flow.id)?.version).toBe(newer.version));
  expect(cache.getQueryState(attentionKey)?.isInvalidated).toBe(true);
  expect(cache.getQueryState(observationsKey)?.isInvalidated).toBe(true);
  expect(cache.getQueryState(documentKey)?.isInvalidated).toBe(false);
});

test("slow live snapshot refresh cannot overwrite a newer event already applied to the board",async()=>{
  const flow=recordOf(snapshot.records,"flow","flow-demo")!;const newer={...flow,version:flow.version+1,title:"Newer canonical title"};
  let finishSnapshot!:(value:Response)=>void;let finishEvents!:(value:Response)=>void;
  route(path=>path.endsWith("/capabilities")?Response.json(capabilities):path.includes("/events?")?new Promise(resolve=>{finishEvents=resolve;}):path.includes("/snapshot?")?new Promise(resolve=>{finishSnapshot=resolve;}):path.includes("/records/")?Response.json({record:newer,eventCursor:"cursor-1"}):Response.json({records:[],nextCursor:null,eventCursor:"cursor-0"}));
  const cache=client();cache.setQueryData(key,snapshot);renderHub(<ManagedWorkView/>,context,cache);
  fireEvent.click(await screen.findByRole("button",{name:"Refresh"}));
  await waitFor(()=>expect(finishSnapshot).toBeTypeOf("function"));
  await act(async()=>{finishEvents(Response.json({events:[event(newer)],nextCursor:"cursor-1"}));});
  await waitFor(()=>expect(recordOf(cache.getQueryData<WorkSnapshot>(key)!.records,"flow",flow.id)?.version).toBe(newer.version));
  await act(async()=>{finishSnapshot(response(snapshot.records,"cursor-0"));});
  await waitFor(()=>expect(cache.isFetching({queryKey:key,exact:true})).toBe(0));
  expect(recordOf(cache.getQueryData<WorkSnapshot>(key)!.records,"flow",flow.id)).toMatchObject({version:newer.version,title:newer.title});
});

test("live-shaped decision-only receipt immediately reconciles related Intent state without waiting for idle polling",async()=>{
  const intent=recordOf(snapshot.records,"intent","i1")!;const attempt=recordOf(snapshot.records,"attempt","a-agent")!;const submission=recordOf(snapshot.records,"submission",attempt.submissionId)!;
  const command:Omit<WorkCommand,"operationId">={command:"attempt.select",expectedVersions:{"flow-demo":1,i1:intent.version,[attempt.id]:attempt.version},payload:{intentId:intent.id,attemptId:attempt.id,submissionId:submission.id,submissionDigest:submission.contentDigest,reason:"Review this exact candidate"}};
  const demo=demoWorkAdapter("p");await demo.command({...command,operationId:"fixture-select"});const selectedSnapshot=await demo.snapshot();const decision=selectedSnapshot.records.find(record=>record.kind==="decision")!;
  let committed=false;
  route((path,init)=>{
    if(init?.method==="POST"){committed=true;const posted=JSON.parse(String(init.body));return Response.json({operationId:posted.operationId,status:"committed",receiptId:"selection-receipt",entities:[{...decision,operationId:posted.operationId}],eventCursor:"cursor-selected"});}
    if(path.includes("/events?"))return Response.json({events:committed?[event(recordOf(selectedSnapshot.records,"intent",intent.id)!)]:[],nextCursor:committed?"cursor-selected":"cursor-0"});
    if(path.includes("/records/"))return Response.json({record:recordOf(selectedSnapshot.records,"intent",intent.id),eventCursor:"cursor-selected"});
    return response();
  });
  function Selection(){const query=useQuery({queryKey:key,queryFn:({signal})=>adapter.snapshot(signal),staleTime:Infinity});useWorkEvents(adapter,query.data?.eventCursor);const operation=useWorkOperation(adapter,()=>undefined);return <><button onClick={()=>void operation.run(command)}>Select exact attempt</button><span>{recordOf(query.data?.records??[],"intent",intent.id)?.selectedSubmissionId??"none"}</span></>;}
  const cache=client();cache.setQueryData(key,snapshot);renderHub(<Selection/>,context,cache);
  await waitFor(()=>expect(requests.some(path=>path.includes("/events?"))).toBe(true));
  fireEvent.click(screen.getByRole("button",{name:"Select exact attempt"}));
  await waitFor(()=>expect(screen.getByText(submission.id)).toBeVisible(),{timeout:1000});
  expect(requests.filter(path=>path.includes("/snapshot?"))).toHaveLength(0);
});

test("live overview retention gap refreshes a bounded attention page without inventing a snapshot owner", async () => {
  const flow=recordOf(snapshot.records,"flow","flow-demo")!;
  route(path=>path.includes("/events?")?Response.json({error:{code:"expired",message:"retention gap"}},{status:410}):response([flow],"retained-current"));
  const cache=client();
  renderHub(<Probe/>,context,cache);
  await waitFor(()=>expect(requests.filter(path=>path.includes("/attention?"))).toHaveLength(1));
  expect(requests.filter(path=>path.includes("/snapshot?"))).toHaveLength(0);
  expect(cache.getQueryData(key)).toBeUndefined();
  expect(cache.getQueryData(attentionKey)).toEqual({pages:[{records:[flow],nextCursor:null,eventCursor:"retained-current"}],pageParams:[""]});
});

test('late retention snapshot merges without replacing a newer cached record',async()=>{
  const flow=recordOf(snapshot.records,'flow','flow-demo')!, newer={...flow,version:flow.version+1,title:'Newer event'};
  let finish!:(value:Response)=>void;
  route(path=>path.includes('/events?')?(path.includes('after=newer-feed')?Response.json({events:[event(newer)],nextCursor:'newer-next'}):Response.json({error:{code:'expired',message:'gap'}},{status:410})):path.includes('/records/')?Response.json({record:newer,eventCursor:'newer-next'}):path.includes('/snapshot?')?new Promise(resolve=>{finish=resolve;}):response());
  const cache=client();cache.setQueryData(key,snapshot);cache.setQueryData(attentionKey,{pages:[],pageParams:[]});renderHub(<Probe/>,context,cache);
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  function NewerFeed(){useWorkEvents(adapter,'newer-feed');return null;}
  renderHub(<NewerFeed/>,context,cache);
  await waitFor(()=>expect(recordOf(cache.getQueryData<WorkSnapshot>(key)!.records,'flow',flow.id)?.version).toBe(newer.version));
  await act(async()=>{finish(response(snapshot.records,'gap-cursor'));});
  await waitFor(()=>expect(cache.getQueryState(attentionKey)?.isInvalidated).toBe(true));
  expect(recordOf(cache.getQueryData<WorkSnapshot>(key)!.records,'flow',flow.id)).toEqual(newer);
});

test('overview gap refresh invalidates existing observations without snapshot ownership',async()=>{
  const flow=recordOf(snapshot.records,'flow','flow-demo')!;
  route(path=>path.includes('/events?')?Response.json({error:{code:'expired',message:'gap'}},{status:410}):response([flow],'gap-cursor'));
  const cache=client();cache.setQueryData(observationsKey,{pages:[],pageParams:[]});renderHub(<Probe/>,context,cache);
  await waitFor(()=>expect(cache.getQueryState(observationsKey)?.isInvalidated).toBe(true));
  expect(cache.getQueryData(key)).toBeUndefined();
});

test.each(['record','snapshot','attention'] as const)('late %s response after unmount cannot mutate old cache',async kind=>{
  const flow=recordOf(snapshot.records,'flow','flow-demo')!, newer={...flow,version:flow.version+1,title:'Late stale response'};
  let finish!:(value:Response)=>void;
  route(path=>{
    if(path.includes('/events?'))return kind==='record'?Response.json({events:[event(newer)],nextCursor:'later'}):Response.json({error:{code:'expired',message:'gap'}},{status:410});
    if(path.includes('/records/')&&kind==='record')return new Promise(resolve=>{finish=resolve;});
    if(path.includes('/snapshot?')&&kind==='snapshot')return new Promise(resolve=>{finish=resolve;});
    if(path.includes('/attention?')&&kind==='attention')return new Promise(resolve=>{finish=resolve;});
    return response();
  });
  const cache=client();if(kind!=='attention')cache.setQueryData(key,snapshot);
  const mounted=renderHub(<Probe/>,context,cache);await waitFor(()=>expect(finish).toBeTypeOf('function'));
  mounted.unmount();
  await act(async()=>{finish(kind==='record'?Response.json({record:newer,eventCursor:'later'}):response([newer],'later'));});
  if(kind==='attention')expect(cache.getQueryData(attentionKey)).toBeUndefined();
  else expect(cache.getQueryData(key)).toEqual(snapshot);
});

test.each([false,true])('receipt wakes an in-flight poll promptly (hidden=%s)',async hidden=>{
  const intent=recordOf(snapshot.records,'intent','i1')!, attempt=recordOf(snapshot.records,'attempt','a-agent')!, submission=recordOf(snapshot.records,'submission',attempt.submissionId)!;
  const command:Omit<WorkCommand,'operationId'>={command:'attempt.select',expectedVersions:{'flow-demo':1,i1:intent.version,[attempt.id]:attempt.version},payload:{intentId:intent.id,attemptId:attempt.id,submissionId:submission.id,submissionDigest:submission.contentDigest,reason:'Select exact candidate'}};
  const demo=demoWorkAdapter('p');await demo.command({...command,operationId:'fixture-select'});const decision=(await demo.snapshot()).records.find(record=>record.kind==='decision')!;
  let finish!:(value:Response)=>void, calls=0;
  route((path,init)=>{
    if(init?.method==='POST'){const posted=JSON.parse(String(init.body));return Response.json({operationId:posted.operationId,status:'committed',receiptId:'r',entities:[{...decision,operationId:posted.operationId}],eventCursor:'selected'});}
    if(path.includes('/events?'))return ++calls===1?new Promise(resolve=>{finish=resolve;}):Response.json({events:[],nextCursor:'selected'});
    return response();
  });
  function Selection(){useWorkEvents(adapter,'cursor-0');const operation=useWorkOperation(adapter,()=>undefined);return <button onClick={()=>void operation.run(command)}>Select</button>;}
  const cache=client();cache.setQueryData(key,snapshot);const mounted=renderHub(<Selection/>,context,cache);
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  const original=Object.getOwnPropertyDescriptor(document,'visibilityState');
  try {
    if(hidden)Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    fireEvent.click(screen.getByRole('button',{name:'Select'}));
    await waitFor(()=>expect(cache.getQueryData<WorkSnapshot>(key)?.records.some(record=>record.kind==='decision')).toBe(true));
    vi.useFakeTimers();
    await act(async()=>{finish(Response.json({events:[],nextCursor:'cursor-0'}));await Promise.resolve();await vi.advanceTimersByTimeAsync(0);});
    expect(calls).toBe(2);
  } finally {mounted.unmount();vi.useRealTimers();if(original)Object.defineProperty(document,'visibilityState',original);else delete (document as {visibilityState?:string}).visibilityState;}
});
