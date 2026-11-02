import { useState } from 'react';
import { act,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { beforeEach,expect,test,vi } from 'vitest';
import { HubContext,type HubContextValue } from '../src/app/hub-context';
import { MessageComposer } from '../src/features/remote/work';
import {validNativeSubmission} from '../src/features/remote/work-pending';
import { useController } from '../src/features/remote/shared';
import { remoteMutate,type Control } from '../src/api/remote';
import { resetClient } from '../src/api/client';
import {useDraftStore} from '../src/state/drafts';
import {demoWorkAdapter} from '../src/features/managed-work/demo';
import {recordOf} from '../src/features/managed-work/model';
import type {WorkRecord} from '../src/features/managed-work/types';
import {sessionFixture} from './remote-fixtures';
import i18n from '../src/i18n';

let records:WorkRecord[];
let client:QueryClient;
const sent:{body:string;headers:Headers;path:string}[]=[];
let failFirst=false;
let refuseRetry=false;
let update:(scope:{record:Control['SessionRecord'];context:HubContextValue})=>void;
const context:HubContextValue={projectId:'p',principal:{id:'human:test',kind:'human',role:'operator'},scopeKey:63,location:{projectId:'p',tab:'sessions',sessionId:'s'},navigate:()=>undefined,refresh:async()=>undefined};
beforeEach(async()=>{
 resetClient();useDraftStore.getState().clearAll();sent.length=0;failFirst=false;refuseRetry=false;await i18n.changeLanguage('en');
 records=(await demoWorkAdapter('p').snapshot()).records;
 for(const id of ['a-agent','a-manual']){const a=recordOf(records,'attempt',id)!;a.state='running';a.submissionId=null;a.executionOutcome='none';}
 recordOf(records,'intent','i1')!.state='in-progress';
 useDraftStore.getState().put('remote-controller:63:p:s',{lease:structuredClone(sessionFixture.controller),renewals:[]});
 client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 vi.spyOn(globalThis,'fetch').mockImplementation(async(path,init)=>{
  const url=String(path);
  if(url.endsWith('/capabilities'))return Response.json({protocolVersion:1,enabled:true,allowedCommands:[],limits:{},features:{managedExecution:true,gitObserver:false,legacyConversion:false}});
  if(url.includes('/snapshot?'))return Response.json({records,nextCursor:null,eventCursor:'work-cursor'});
  if(url.includes('/events?'))return Response.json({events:[],nextCursor:'work-next'});
  if(url.endsWith('/flows'))return Response.json({flows:[]});
  if(url.endsWith('/messages')){sent.push({body:String(init?.body),headers:new Headers(init?.headers),path:url});if(failFirst&&sent.length===1)throw new TypeError('lost response');if(refuseRetry&&sent.length>1)return Response.json({error:{code:'read-only',message:'Current authority refused before receipt lookup'}},{status:403});return Response.json({operationId:'opaque-server-operation',messageId:'message',sessionId:'s',sessionVersion:4,queueItemId:null,status:'admitted',runId:'run',turnId:'turn',turnOrdinal:1});}
  return Response.json({error:{code:'not-found'}},{status:404});
 });
});
function show(initialContext=context){
 function Probe(){const[scope,setScope]=useState({record:structuredClone(sessionFixture),context:initialContext});update=setScope;return <HubContext.Provider value={scope.context}><Composer record={scope.record}/></HubContext.Provider>;}
 function Composer({record}:{record:Control['SessionRecord']}){return <MessageComposer record={record} control={useController(record)}/>;}
 return render(<QueryClientProvider client={client}><Probe/></QueryClientProvider>);
}
async function selectManaged(){
 await screen.findByRole('option',{name:'Managed Attempt'});
 fireEvent.change(screen.getByRole('combobox',{name:'Work mode'}),{target:{value:'managed'}});
 const attempt=await screen.findByRole('option',{name:/a-agent/});expect(attempt).toBeInTheDocument();
 fireEvent.change(screen.getByRole('combobox',{name:'Choose a started Attempt'}),{target:{value:'a-agent'}});
 fireEvent.change(screen.getByRole('textbox',{name:'Message'}),{target:{value:'Original managed message'}});
 fireEvent.click(screen.getByRole('checkbox',{name:'I checked this exact Flow, deliverable, Attempt and pinned context.'}));
}
test('managed mode never enables ad-hoc consent silently and sends paired headers only after explicit pins and consent',async()=>{
 show();await selectManaged();
 expect(screen.getByRole('checkbox',{name:'I explicitly choose locally permitted ad-hoc work'})).not.toBeChecked();expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox',{name:'I explicitly choose locally permitted ad-hoc work'}));fireEvent.click(screen.getByRole('button',{name:'Send message'}));
 await waitFor(()=>expect(sent).toHaveLength(1));const body=JSON.parse(sent[0].body);
 expect(body.association).toEqual({mode:'ad-hoc',profileConsentVersion:1});expect(body).not.toHaveProperty('attemptId');expect(sent[0].headers.get('X-Keryx-Work-Attempt')).toBe('a-agent');expect(sent[0].headers.get('X-Keryx-Work-Version')).toBe('1');expect(sent[0].headers.get('Idempotency-Key')).toBeTruthy();
});
test('unknown managed submission freezes original body, Attempt headers and request key across edits and retry',async()=>{
 failFirst=true;show();await selectManaged();fireEvent.click(screen.getByRole('checkbox',{name:'I explicitly choose locally permitted ad-hoc work'}));fireEvent.click(screen.getByRole('button',{name:'Send message'}));
 const retry=await screen.findByRole('button',{name:'Retry original message'});expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();
 fireEvent.change(screen.getByRole('textbox',{name:'Message'}),{target:{value:'New draft must not replace the original'}});
 fireEvent.change(screen.getByRole('combobox',{name:'Choose a started Attempt'}),{target:{value:'a-manual'}});
 fireEvent.click(retry);await waitFor(()=>expect(sent).toHaveLength(2));
 expect(sent[1].body).toBe(sent[0].body);expect(sent[1].headers.get('Idempotency-Key')).toBe(sent[0].headers.get('Idempotency-Key'));expect(sent[1].headers.get('X-Keryx-Work-Attempt')).toBe('a-agent');expect(sent[1].headers.get('X-Keryx-Work-Version')).toBe('1');
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Retry original message'})).not.toBeInTheDocument());expect(screen.getByRole('textbox',{name:'Message'})).toHaveValue('New draft must not replace the original');
});
test('a changed Attempt version disables send until explicitly refreshed and reconfirmed',async()=>{
 show();await selectManaged();fireEvent.click(screen.getByRole('checkbox',{name:'I explicitly choose locally permitted ad-hoc work'}));
 recordOf(records,'attempt','a-agent')!.version=2;
 await act(async()=>{await client.invalidateQueries({queryKey:[63,'p','work','live','snapshot']});});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled());expect(screen.getByText(/Attempt or its requirements have changed/)).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Review current Attempt version'}));expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox',{name:'I checked this exact Flow, deliverable, Attempt and pinned context.'}));expect(screen.getByRole('button',{name:'Send message'})).toBeEnabled();
});
test('project/session switch clears selected binding and retains unresolved original in its own session scope',async()=>{
 failFirst=true;show();await selectManaged();fireEvent.click(screen.getByRole('checkbox',{name:'I explicitly choose locally permitted ad-hoc work'}));fireEvent.click(screen.getByRole('button',{name:'Send message'}));await screen.findByRole('button',{name:'Retry original message'});
 const nextRecord={...structuredClone(sessionFixture),projectId:'q',sessionId:'s2'};
 await act(async()=>update({record:nextRecord,context:{...context,projectId:'q',location:{projectId:'q',tab:'sessions',sessionId:'s2'}}}));
 expect(screen.getByRole('combobox',{name:'Work mode'})).toHaveValue('flow');expect(screen.queryByRole('button',{name:'Retry original message'})).not.toBeInTheDocument();
 const original=JSON.parse(sessionStorage.getItem('keryx.pending.v1:'+JSON.stringify(['native','human:test','p','s']))!);expect(original.value).toMatchObject({phase:'unknown',hint:{attemptId:'a-agent',attemptVersion:1}});expect(sent).toHaveLength(1);
});
test('read-only principals cannot select a Managed Attempt or send execution',async()=>{
 show({...context,principal:{id:'human:reviewer',kind:'human',role:'reviewer'}});const option=await screen.findByRole('option',{name:'Managed Attempt'});expect(option).toBeDisabled();
 fireEvent.change(screen.getByRole('combobox',{name:'Work mode'}),{target:{value:'managed'}});expect(screen.getByText(/Only a human operator controlling this session/)).toBeVisible();expect(screen.getByRole('combobox',{name:'Choose a started Attempt'})).toBeDisabled();expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();expect(sent).toHaveLength(0);
});
test('transport refuses paired managed headers for legacy Flow association and non-message endpoints',async()=>{
 const transport={operationId:'original-key',workHint:{attemptId:'a-agent',attemptVersion:1}};
 expect(()=>remoteMutate('POST','/projects/p/sessions/s/messages',{association:{mode:'flow',flowId:'legacy'}},transport)).toThrow(/explicit consent/);
 expect(()=>remoteMutate('PUT','/projects/p/sessions/s/config',{association:{mode:'ad-hoc',profileConsentVersion:1}},transport)).toThrow(/explicit consent/);expect(fetch).not.toHaveBeenCalled();
});

test('reload recovers the exact native message without auto-sending or copying it into a new draft',async()=>{
 failFirst=true;const view=show();await selectManaged();fireEvent.click(screen.getByRole('checkbox',{name:'I explicitly choose locally permitted ad-hoc work'}));fireEvent.click(screen.getByRole('button',{name:'Send message'}));await screen.findByRole('button',{name:'Retry original message'});
 const key="keryx.pending.v1:"+JSON.stringify(["native","human:test","p","s"]);const pending=JSON.parse(sessionStorage.getItem(key)!);pending.value.phase="sending";sessionStorage.setItem(key,JSON.stringify(pending));
 view.unmount();useDraftStore.getState().clearAll();resetClient();
 useDraftStore.getState().put('remote-controller:64:p:s',{lease:structuredClone(sessionFixture.controller),renewals:[]});
 show({...context,scopeKey:64});const retry=await screen.findByRole('button',{name:'Retry original message'});
 expect(sent).toHaveLength(1);expect(screen.getByRole('textbox',{name:'Message'})).toHaveValue('');
 fireEvent.click(retry);await waitFor(()=>expect(sent).toHaveLength(2));expect(sent[1].body).toBe(sent[0].body);expect(sent[1].headers.get('Idempotency-Key')).toBe(sent[0].headers.get('Idempotency-Key'));expect(sent[1].headers.get('X-Keryx-Work-Attempt')).toBe(sent[0].headers.get('X-Keryx-Work-Attempt'));expect(sent[1].headers.get('X-Keryx-Work-Version')).toBe(sent[0].headers.get('X-Keryx-Work-Version'));
});

test('an authorization refusal on native original retry preserves its uncertain envelope and prevents replacement',async()=>{
 failFirst=true;refuseRetry=true;show();await selectManaged();fireEvent.click(screen.getByRole('checkbox',{name:'I explicitly choose locally permitted ad-hoc work'}));fireEvent.click(screen.getByRole('button',{name:'Send message'}));
 fireEvent.click(await screen.findByRole('button',{name:'Retry original message'}));await waitFor(()=>expect(sent).toHaveLength(2));
 const retry=await screen.findByRole('button',{name:'Retry original message'});expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();expect(sent[1].body).toBe(sent[0].body);expect(sent[1].headers.get('Idempotency-Key')).toBe(sent[0].headers.get('Idempotency-Key'));
 expect(JSON.parse(sessionStorage.getItem('keryx.pending.v1:'+JSON.stringify(['native','human:test','p','s']))!).value.phase).toBe('unknown');
 fireEvent.click(retry);await waitFor(()=>expect(sent).toHaveLength(3));expect(sent[2].headers.get('Idempotency-Key')).toBe(sent[0].headers.get('Idempotency-Key'));
});

test('native recovery accepts the printable Work Attempt ID contract while keeping envelope and body closed',()=>{
 const scope=JSON.stringify(['native','human:test','p','s']),path='/projects/p/sessions/s/messages';
 const envelope={scope,path,operationId:'original-key',phase:'unknown',hint:{attemptId:'attempt/custom #1',attemptVersion:1},body:{expectedSessionVersion:3,controller:{controllerLeaseId:'lease',expectedControllerVersion:1},expectedConfigVersion:1,text:'Original message',interpretation:'literal-message',association:{mode:'ad-hoc',profileConsentVersion:1},busyPolicy:'reject'}};
 expect(validNativeSubmission(envelope,scope,path)).toBe(true);expect(validNativeSubmission({...envelope,hint:{...envelope.hint,attemptId:'bad\nheader'}},scope,path)).toBe(false);expect(validNativeSubmission({...envelope,Authorization:'forbidden'},scope,path)).toBe(false);
});
