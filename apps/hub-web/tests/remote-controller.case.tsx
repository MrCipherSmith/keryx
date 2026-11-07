import { act,fireEvent,render,screen } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { HubContext,type HubContextValue } from '../src/app/hub-context';
import { useController } from '../src/features/remote/shared';
import { resetClient } from '../src/api/client';
import { useDraftStore } from '../src/state/drafts';
import { sessionFixture } from './remote-fixtures';
import type { Control } from '../src/api/remote';
const context:HubContextValue={projectId:'p',principal:{id:'human:test',kind:'human',role:'operator'},scopeKey:1,location:{projectId:'p',tab:'sessions'},navigate:()=>undefined,refresh:async()=>undefined};
function Probe({record=sessionFixture}:{record?:Control['SessionRecord']}){const control=useController(record);return <button onClick={control.claim}>{control.active?'controlled':'claim'}</button>;}
beforeEach(()=>{resetClient();useDraftStore.getState().clearAll();vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({receiptId:'r',sessionVersion:3,lease:sessionFixture.controller}));});
afterEach(()=>vi.useRealTimers());
test('explicit controller renews despite per-second expiry rendering',async()=>{vi.useFakeTimers();render(<QueryClientProvider client={new QueryClient()}><HubContext.Provider value={context}><Probe/></HubContext.Provider></QueryClientProvider>);await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'claim'}));await vi.advanceTimersByTimeAsync(50);});expect(screen.getByRole('button',{name:'controlled'})).toBeVisible();for(let n=0;n<21;n++)await act(async()=>{vi.advanceTimersByTime(1000);});expect(vi.mocked(globalThis.fetch).mock.calls.some(([url])=>String(url).endsWith('/controller/renew'))).toBe(true);});

test('a stale renewal during a long turn retries against the current session and keeps the same control',async()=>{
 vi.useFakeTimers();
 const record={...sessionFixture,controller:{...sessionFixture.controller!,expiresAt:new Date(Date.now()+60000).toISOString()}};
 const current={...record,version:record.version+1,state:'busy',activeRunId:'run',activeTurnId:'turn'} satisfies Control['SessionRecord'];
 const versions:number[]=[];
 let claims=0;
 vi.mocked(globalThis.fetch).mockImplementation(async(url,init)=>{
  const path=String(url);
  if(path.endsWith('/controller/claim')){
   claims++;
   return Response.json({receiptId:'claim',sessionVersion:record.version,lease:record.controller});
  }
  if(path.endsWith('/controller/renew')){
   const request=JSON.parse(String(init?.body)) as Control['ControllerClaim'];
   versions.push(request.expectedSessionVersion);
   expect(request.controllerLeaseId).toBe(record.controller.controllerLeaseId);
   if(request.expectedSessionVersion!==current.version){
    return Response.json({error:{code:'stale-version',message:'Version changed'}},{status:409});
   }
   return Response.json({receiptId:'renew',sessionVersion:current.version+1,lease:{...record.controller,expiresAt:new Date(Date.now()+60000).toISOString()}});
  }
  if(path.endsWith('/sessions/s'))return Response.json(current);
  return Response.json({});
 });
 render(<QueryClientProvider client={new QueryClient()}><HubContext.Provider value={context}><Probe record={record}/></HubContext.Provider></QueryClientProvider>);
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'claim'}));await vi.advanceTimersByTimeAsync(50);});
 for(let n=0;n<24;n++)await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
 expect(versions.slice(0,2)).toEqual([record.version,current.version]);
 for(let n=0;n<37;n++)await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
 expect(screen.getByRole('button',{name:'controlled'})).toBeVisible();
 expect(claims).toBe(1);
});
