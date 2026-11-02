import { useState } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { resetClient } from '../src/api/client';
import type { HubContextValue } from '../src/app/hub-context';
import { liveWorkAdapter } from '../src/features/managed-work/adapter';
import { demoWorkAdapter } from '../src/features/managed-work/demo';
import { recordOf } from '../src/features/managed-work/model';
import { RevisionEditor } from '../src/features/managed-work/revision-editor';
import { useDraftStore } from '../src/state/drafts';
import i18n from '../src/i18n';
import { renderHub } from './hub-render';
const context:HubContextValue={projectId:'p',scopeKey:99,principal:{id:'human:test',kind:'human',role:'operator'},location:{projectId:'p',tab:'work'},navigate:()=>undefined,refresh:async()=>undefined};
beforeEach(async()=>{resetClient();useDraftStore.getState().clearAll();await i18n.changeLanguage('en');});
test.each(['initial','submit'] as const)('filters cancelled required Intent at %s',async phase=>{
 const snapshot=await demoWorkAdapter('p').snapshot();const flow=recordOf(snapshot.records,'flow','flow-demo')!;const intent=recordOf(snapshot.records,'intent','i2')!;
 const adapter=liveWorkAdapter('p');let posted:unknown;
 vi.spyOn(globalThis,'fetch').mockImplementation(async (_input,init)=>{posted=JSON.parse(String(init?.body));return Response.json({operationId:'receipt',status:'committed',receiptId:'receipt',entities:[],eventCursor:'c'});});
 function Subject(){const [cancelled,setCancelled]=useState(phase==='initial');const records=snapshot.records.map(r=>r.id===intent.id?{...intent,state:cancelled?'cancelled' as const:intent.state}:r);return <><button onClick={()=>setCancelled(true)}>Cancel member</button><RevisionEditor adapter={adapter} flow={flow} records={records} onDone={()=>undefined}/></>;}
 renderHub(<Subject/>,context);
 const problem=screen.getByLabelText('Problem');fireEvent.change(problem,{target:{value:'Updated problem'}});
 const draft=Object.values(useDraftStore.getState().drafts)[0] as {requiredIntentIds:string[]};
 expect(draft.requiredIntentIds).toEqual(phase==='initial'?['i1']:['i1','i2']);
 if(phase==='submit')fireEvent.click(screen.getByRole('button',{name:'Cancel member'}));
 fireEvent.click(screen.getByRole('button',{name:'Save proposal'}));
 await waitFor(()=>expect(posted).toMatchObject({command:'revision.propose',payload:{requiredIntentIds:['i1']}}));
});
