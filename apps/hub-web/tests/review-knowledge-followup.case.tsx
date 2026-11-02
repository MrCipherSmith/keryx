import {act,render,screen} from '@testing-library/react';
import {beforeEach,expect,test,vi} from 'vitest';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {HubContext,type HubContextValue} from '../src/app/hub-context';
import {acceptanceFixture,mutationRequests,type AcceptanceFixture} from './flow-acceptance.fixture';
import {AttemptDetail} from '../src/features/managed-work/attempt-detail';
import {liveWorkAdapter} from '../src/features/managed-work/adapter';
import {recordOf} from '../src/features/managed-work/model';
import type {ReactNode} from 'react';
let fixture:AcceptanceFixture;
beforeEach(async()=>{fixture=await acceptanceFixture();});
const log=(id:string,value:unknown)=>console.log('EMPIRICAL_EXTRA_UI '+id+' '+JSON.stringify(value));
function mount(children:ReactNode,intent=false){
 const cache=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const context:HubContextValue={projectId:'p',scopeKey:73,principal:{id:'human:reviewer',kind:'human',role:'operator'},location:{projectId:'p',tab:'work',flowId:'flow-demo',...(intent?{intentId:'i1',attemptId:'a-agent'}:{})},navigate:vi.fn(),refresh:async()=>undefined};
 const view=render(<QueryClientProvider client={cache}><HubContext.Provider value={context}>{children}</HubContext.Provider></QueryClientProvider>);
 return{...view,cache};
}
function revealTechnical(){act(()=>{for(const node of document.querySelectorAll('details'))node.open=true;});}

test.each([{proposalIds:['knowledge-alpha','knowledge-beta'],noUpdateReason:null},{proposalIds:['knowledge-alpha'],noUpdateReason:'Existing documentation remains valid.'},{proposalIds:[],noUpdateReason:'Existing documentation remains valid.'},{proposalIds:[],noUpdateReason:null}])('KNOWLEDGE-REFS technical follow-up reflects $proposalIds / $noUpdateReason',async({proposalIds,noUpdateReason})=>{
 fixture.submission.knowledgeFollowup={proposalIds,noUpdateReason};
 const flow=recordOf(fixture.records,'flow','flow-demo')!,adapter=liveWorkAdapter('p'),capabilities=await adapter.capabilities();
 const view=mount(<AttemptDetail capabilities={capabilities} adapter={adapter} refresh={()=>undefined} flow={flow} intent={fixture.intent} attempt={fixture.attempt} records={fixture.records} can={()=>true} human prepare={vi.fn()}/>,true);
 revealTechnical();expect(screen.getByRole('heading',{name:'Knowledge follow-up'})).toBeVisible();
 expect(screen.getAllByText(fixture.submission.contentDigest,{exact:true}).length,'Exact submitted Attempt metadata must be rendered').toBeGreaterThan(0);
 const observations=proposalIds.map(id=>({id,matches:screen.queryAllByText(id,{exact:true}).length}));
 log('KNOWLEDGE-REFS',{submissionId:fixture.submission.id,proposalIds:fixture.submission.knowledgeFollowup.proposalIds,noUpdateReason:fixture.submission.knowledgeFollowup.noUpdateReason,observations,emptyClaimShown:screen.queryAllByText('No linked knowledge proposals.',{exact:true}).length>0});
 for(const id of proposalIds)expect.soft(screen.queryAllByText(id,{exact:true}).length,'Submitted knowledge proposal '+id+' must remain accessible').toBeGreaterThan(0);
 if(noUpdateReason)expect(screen.getByText(noUpdateReason,{exact:true})).toBeVisible();
 expect(screen.queryByText('No linked knowledge proposals.',{exact:true})!==null).toBe(proposalIds.length===0&&!noUpdateReason);
 expect(mutationRequests(fixture)).toHaveLength(0);view.unmount();view.cache.clear();
});
