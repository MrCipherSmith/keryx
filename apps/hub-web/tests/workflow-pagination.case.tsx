import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { FlowsView } from '../src/features/workflow';
import type { HubContextValue } from '../src/app/hub-context';
import { resetClient } from '../src/api/client';
import i18n from '../src/i18n';
import { renderHub } from './hub-render';

const context:HubContextValue={projectId:'p',scopeKey:71,principal:{id:'human:owner',kind:'human',role:'operator'},location:{projectId:'p',tab:'flows',flowId:'f'},navigate:()=>undefined,refresh:async()=>undefined};
const flow={id:'f',projectId:'p',title:'Exact candidate',status:'in-progress',version:3,criteria:['Keep exact subject'],specDocumentId:'s',specContentDigest:'abc',subjectRevisionId:null};
beforeEach(async()=>{resetClient();await i18n.changeLanguage('en');});
test.each(['candidate','evidence'] as const)('%s form loads and selects a revision on a later page',async kind=>{
 const requests:string[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
  const path=String(input);requests.push(path);
  if(path.includes('/revisions?summary=1'))return Response.json(path.includes('afterId=')?{revisions:[{id:'later',projectId:'p',message:'Later revision',fileCount:0}],nextCursor:null}:{revisions:[{id:'first',projectId:'p',message:'First revision',fileCount:0}],nextCursor:'first'});
  if(path.endsWith('/flows/f'))return Response.json(flow);
  if(path.endsWith('/evidence'))return Response.json({evidence:[]});
  if(path.endsWith('/documents'))return Response.json({documents:[]});
  return Response.json({flows:[flow]});
 });
 renderHub(<FlowsView/>,context);
 if(kind==='evidence')fireEvent.click(await screen.findByRole('button',{name:'Add self-reported check'}));
 const label=kind==='candidate'?'Candidate revision':'Evidence subject revision';
 await screen.findByLabelText(label);
 const form=screen.getByLabelText(label).closest('form')!;
 fireEvent.click(within(form).getByRole('button',{name:'Load more revisions'}));
 await waitFor(()=>expect(requests.some(path=>path.includes('afterId=first'))).toBe(true));
 await screen.findAllByRole('option',{name:/Later revision/});
 fireEvent.change(screen.getByLabelText(label),{target:{value:'later'}});
 expect(screen.getByLabelText(label)).toHaveValue('later');
});
