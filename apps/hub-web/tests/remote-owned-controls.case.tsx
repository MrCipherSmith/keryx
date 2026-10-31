import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { beforeEach,expect,test,vi } from 'vitest';
import { HubContext,type HubContextValue } from '../src/app/hub-context';
import { useController } from '../src/features/remote/shared';
import { Commands } from '../src/features/remote/settings';
import { sessionFixture } from './remote-fixtures';
import { useDraftStore } from '../src/state/drafts';
import i18n from '../src/i18n';
import type { Control } from '../src/api/remote';
const record={...sessionFixture,state:'busy' as const,activeRunId:'r',activeTurnId:'t'};const context:HubContextValue={projectId:'p',principal:{id:'human:test',kind:'human',role:'operator'},scopeKey:1,location:{projectId:'p',tab:'sessions'},navigate:()=>undefined,refresh:async()=>undefined};
const entry=(commandName:string):Control['CommandCatalogueEntry']=>({commandName,summary:commandName,handlerId:commandName,inputSchema:{type:'object',additionalProperties:false,properties:{taskId:{type:'string',maxLength:200}},required:['taskId']},resultSchema:{type:'object',additionalProperties:false,properties:{},required:[]},mutationClass:'session',states:['idle','busy','paused'],busyPolicy:'reject',confirmation:'none',availability:'available',reason:'none'});
function Probe(){const control=useController(record);return <><button onClick={control.claim}>claim</button><Commands record={record} control={control}/></>;}
beforeEach(async()=>{useDraftStore.getState().clearAll();await i18n.changeLanguage('en');vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>String(url).endsWith('/controller/claim')?Response.json({receiptId:'r',sessionVersion:3,lease:record.controller}):Response.json({catalogueVersion:1,catalogueDigest:'a'.repeat(64),capabilityDigest:'a'.repeat(64),entries:[entry('tasks.kill'),entry('session.configure')]}));});
test('busy exception is only for exact shared owned-resource commands, never general session mutation',async()=>{render(<QueryClientProvider client={new QueryClient()}><HubContext.Provider value={context}><Probe/></HubContext.Provider></QueryClientProvider>);fireEvent.click(screen.getByRole('button',{name:'claim'}));await screen.findByRole('option',{name:'tasks.kill · available'});fireEvent.change(screen.getByLabelText('Command'),{target:{value:'session.configure'}});await waitFor(()=>expect(screen.getByRole('button',{name:'Invoke command'})).toBeDisabled());fireEvent.change(screen.getByLabelText('Command'),{target:{value:'tasks.kill'}});fireEvent.change(screen.getByLabelText('Structured arguments'),{target:{value:'{"taskId":"owned-task"}'}});await waitFor(()=>expect(screen.getByRole('button',{name:'Invoke command'})).toBeEnabled());});
