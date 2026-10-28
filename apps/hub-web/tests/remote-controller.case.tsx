import { act,fireEvent,render,screen } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { HubContext,type HubContextValue } from '../src/app/hub-context';
import { useController } from '../src/features/remote/shared';
import { resetClient } from '../src/api/client';
import { useDraftStore } from '../src/state/drafts';
import { sessionFixture } from './remote-fixtures';
const context:HubContextValue={projectId:'p',principal:{id:'human:test',kind:'human',role:'operator'},scopeKey:1,location:{projectId:'p',tab:'sessions'},navigate:()=>undefined,refresh:async()=>undefined};
function Probe(){const control=useController(sessionFixture);return <button onClick={control.claim}>{control.active?'controlled':'claim'}</button>;}
beforeEach(()=>{resetClient();useDraftStore.getState().clearAll();vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({receiptId:'r',sessionVersion:3,lease:sessionFixture.controller}));});
afterEach(()=>vi.useRealTimers());
test('explicit controller renews despite per-second expiry rendering',async()=>{vi.useFakeTimers();render(<QueryClientProvider client={new QueryClient()}><HubContext.Provider value={context}><Probe/></HubContext.Provider></QueryClientProvider>);await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'claim'}));await vi.advanceTimersByTimeAsync(50);});expect(screen.getByRole('button',{name:'controlled'})).toBeVisible();for(let n=0;n<21;n++)await act(async()=>{vi.advanceTimersByTime(1000);});expect(vi.mocked(globalThis.fetch).mock.calls.some(([url])=>String(url).endsWith('/controller/renew'))).toBe(true);});
