import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { HubContext, type HubContextValue } from '../src/app/hub-context';
import { useWorkEvents } from '../src/features/managed-work/updates';
import { demoWorkAdapter } from '../src/features/managed-work/demo';
import type { WorkEvent } from '../src/features/managed-work/types';

test('one work event fetches its canonical record without restarting snapshots or immutable documents',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const base=demoWorkAdapter('p'); const snapshot=await base.snapshot();
 const flow=snapshot.records.find(record=>record.kind==='flow')!;
 const next={...flow,version:flow.version+1};
 const key=[99,'p','work','live','snapshot']; client.setQueryData(key,snapshot);
 const immutable=[99,'p','work','live','document','exact']; const document={content:'immutable'};client.setQueryData(immutable,document);
 const event={entityId:flow.id,entityVersion:next.version} as WorkEvent;
 const record=vi.fn(async()=>({record:next,eventCursor:'next'}));
 const adapter={...base,mode:'live' as const,record,events:vi.fn(async()=>({events:[event],nextCursor:'next'})),snapshot:vi.fn(base.snapshot)};
 const context={projectId:'p',scopeKey:99,principal:{id:'human',kind:'human',role:'operator'},location:{projectId:'p',tab:'work'},navigate:()=>undefined,refresh:async()=>undefined} satisfies HubContextValue;
 function Probe(){useWorkEvents(adapter,'initial');return null;}
 const mounted=render(<QueryClientProvider client={client}><HubContext.Provider value={context}><Probe/></HubContext.Provider></QueryClientProvider>);
 await waitFor(()=>expect(record).toHaveBeenCalledTimes(1));
 expect(adapter.snapshot).not.toHaveBeenCalled();expect(client.getQueryState(immutable)?.isInvalidated).toBe(false);expect(client.getQueryData(immutable)).toBe(document);
 expect(client.getQueryData<typeof snapshot>(key)?.records.find(record=>record.id===flow.id)).toEqual(next);
 mounted.unmount();await act(async()=>{await Promise.resolve();});
});

test('receipt merges preserve unrelated identities and suppress duplicate event reads',async()=>{
 const {mergeWorkRecords,fetchEventRecords}=await import('../src/features/managed-work/cache');
 const base=demoWorkAdapter('p');const snapshot=await base.snapshot();
 const flow=snapshot.records.find(record=>record.kind==='flow')!;
 const newer={...flow,version:flow.version+1};const merged=mergeWorkRecords(snapshot,[newer]);
 expect(merged.records.find(record=>record.id!==flow.id)).toBe(snapshot.records.find(record=>record.id!==flow.id));
 expect(mergeWorkRecords(merged,[flow])).toBe(merged);
 const record=vi.fn();await fetchEventRecords({...base,record},merged,[{entityId:flow.id,entityVersion:newer.version} as WorkEvent],new AbortController().signal);
 expect(record).not.toHaveBeenCalled();
});

test('expired event cursors resync once and keep polling even when the cursor is unchanged',async()=>{
 const {ApiError}=await import('../src/api/client');
 vi.useFakeTimers();const client=new QueryClient();const base=demoWorkAdapter('p');const snapshot=await base.snapshot();snapshot.eventCursor='same';
 client.setQueryData([99,'p','work','live','snapshot'],snapshot);
 const events=vi.fn().mockRejectedValueOnce(new ApiError(410,'expired','expired')).mockResolvedValue({events:[],nextCursor:'same'});
 const adapter={...base,mode:'live' as const,events,snapshot:vi.fn(async()=>snapshot)};
 const context={projectId:'p',scopeKey:99,principal:{id:'human',kind:'human',role:'operator'},location:{projectId:'p',tab:'work'},navigate:()=>undefined,refresh:async()=>undefined} satisfies HubContextValue;
 function Probe(){useWorkEvents(adapter,'same');return null;}
 try {
  const mounted=render(<QueryClientProvider client={client}><HubContext.Provider value={context}><Probe/></HubContext.Provider></QueryClientProvider>);
  await act(async()=>{await Promise.resolve();});expect(adapter.snapshot).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(4000);});expect(events).toHaveBeenCalledTimes(2);
  mounted.unmount();
 }finally{vi.useRealTimers();}
});


test('Git observation events do not request a nonexistent WorkRecord',async()=>{
 const {fetchEventRecords}=await import('../src/features/managed-work/cache');
 const base=demoWorkAdapter('p');const record=vi.fn();
 const changes=await fetchEventRecords({...base,record},undefined,[{entityType:'git-observation',entityId:'observation-id',entityVersion:null} as WorkEvent],new AbortController().signal);
 expect(record).not.toHaveBeenCalled();expect(changes).toEqual([]);
});

test('Git observation refresh advances the event cursor and a later WorkRecord event still applies',async()=>{
 vi.useFakeTimers();const client=new QueryClient();const base=demoWorkAdapter('p');const snapshot=await base.snapshot();
 const flow=snapshot.records.find(record=>record.kind==='flow')!;const next={...flow,version:flow.version+1};
 const key=[99,'p','work','live','snapshot'];client.setQueryData(key,snapshot);
 const observationKey=[99,'p','work','live','observations','subject-agent'];client.setQueryData(observationKey,{pages:[],pageParams:[]});
 const events=vi.fn().mockResolvedValueOnce({events:[{entityType:'git-observation',entityId:'observation-id',entityVersion:null}],nextCursor:'after-observation'}).mockResolvedValue({events:[{entityType:'flow',entityId:flow.id,entityVersion:next.version}],nextCursor:'after-flow'});
 const record=vi.fn(async()=>({record:next,eventCursor:'after-flow'}));const adapter={...base,mode:'live' as const,events,record};
 const context={projectId:'p',scopeKey:99,principal:{id:'human',kind:'human',role:'operator'},location:{projectId:'p',tab:'work'},navigate:()=>undefined,refresh:async()=>undefined} satisfies HubContextValue;
 function Probe(){useWorkEvents(adapter,'initial');return null;}
 try {
 const mounted=render(<QueryClientProvider client={client}><HubContext.Provider value={context}><Probe/></HubContext.Provider></QueryClientProvider>);
 await act(async()=>{await Promise.resolve();});expect(record).not.toHaveBeenCalled();expect(client.getQueryState(observationKey)?.isInvalidated).toBe(true);
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});expect(events.mock.calls[1][0]).toBe('after-observation');expect(record).toHaveBeenCalledTimes(1);
 expect(client.getQueryData<typeof snapshot>(key)?.records.find(record=>record.id===flow.id)).toEqual(next);mounted.unmount();
 }finally{vi.useRealTimers();}
});
