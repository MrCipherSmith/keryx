import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,test,vi} from 'vitest';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {HubContext,type HubContextValue} from '../src/app/hub-context';
import {acceptanceFixture,mutationRequests,type AcceptanceFixture} from './flow-acceptance.fixture';
import {FlowReview} from '../src/features/managed-work/flow-review';
import {liveWorkAdapter} from '../src/features/managed-work/adapter';
import {recordOf} from '../src/features/managed-work/model';
import type {ReactNode} from 'react';
let fixture:AcceptanceFixture;
beforeEach(async()=>{fixture=await acceptanceFixture();});
const log=(id:string,value:unknown)=>console.log('EMPIRICAL_EXTRA_UI '+id+' '+JSON.stringify(value));
function mount(children:ReactNode,intent=false){
 const cache=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 let context:HubContextValue={projectId:'p',scopeKey:73,principal:{id:'human:reviewer',kind:'human',role:'operator'},location:{projectId:'p',tab:'work',flowId:'flow-demo',...(intent?{intentId:'i1',attemptId:'a-agent'}:{})},navigate:vi.fn(),refresh:async()=>undefined};
 const tree=(node:ReactNode)=><QueryClientProvider client={cache}><HubContext.Provider value={context}>{node}</HubContext.Provider></QueryClientProvider>;
 const view=render(tree(children));
 return{...view,cache,update:(node:ReactNode,patch:Partial<HubContextValue>={})=>{context={...context,...patch};view.rerender(tree(node));}};
}
function revealTechnical(){act(()=>{for(const node of document.querySelectorAll('details'))node.open=true;});}

function aggregateFixture(){
 const flow=recordOf(fixture.records,'flow','flow-demo')!;flow.state='in-review';
 const intents=fixture.records.filter(record=>record.kind==='intent');for(const intent of intents){intent.state='accepted';intent.acceptanceDecisionId='accepted-'+intent.id;}
 const submission={kind:'flow-submission' as const,id:'aggregate-extra-ui',projectId:'p',createdBy:'human:reviewer',createdAt:'2026-11-03T08:00:00Z',flowId:flow.id,flowRevisionId:flow.approvedRevisionId!,acceptedIntents:intents.map(intent=>({intentId:intent.id,intentRevisionId:intent.approvedRevisionId!,decisionId:intent.acceptanceDecisionId!,submissionId:intent.id===fixture.intent.id?fixture.submission.id:'accepted-submission-'+intent.id,subjectDigest:intent.id===fixture.intent.id?fixture.submission.subjectDigest:'a'.repeat(64)})),knowledgeProposalIds:[],contentDigest:'c'.repeat(64),criterionCoverage:[{flowCriterionId:'fc1',intentId:fixture.intent.id,intentCriterionId:fixture.revision.criteria[0]!.criterionId,submissionId:fixture.submission.id,decisionId:'accepted-'+fixture.intent.id}]};
 fixture.records.push(submission);
 return {flow,submission,intents};
}

test('FLOW-REJECT an authorized aggregate reviewer can submit terminal reject with exact bindings',async()=>{
 const {flow,submission,intents}=aggregateFixture();
 const view=mount(<FlowReview adapter={liveWorkAdapter('p')} flow={flow} records={fixture.records} can={()=>true} onDone={()=>undefined}/>);
 revealTechnical();expect(screen.getAllByText(submission.contentDigest,{exact:true}).length,'Exact aggregate submission must actually be rendered').toBeGreaterThan(0);
 const options=screen.queryAllByRole('option',{name:'Reject result',hidden:true});const buttons=screen.queryAllByRole('button',{name:'Reject result',hidden:true});
 log('FLOW-REJECT',{flowId:flow.id,state:flow.state,submissionId:submission.id,submissionDigest:submission.contentDigest,requiredAccepted:intents.every(i=>i.state==='accepted'),rejectOptionCount:options.length,rejectButtonCount:buttons.length,visibleButtons:screen.queryAllByRole('button',{hidden:true}).map(n=>n.textContent)});
 expect(options.length+buttons.length,'A separate terminal aggregate rejection action must remain reachable').toBeGreaterThan(0);
 if(options.length){const select=options[0]!.closest('select')!;fireEvent.change(select,{target:{value:'reject'}});}
 else {expect(buttons[0]).toBeEnabled();fireEvent.click(buttons[0]!);}
 const reason=screen.getByRole('textbox',{name:'Decision reason'});fireEvent.change(reason,{target:{value:'Terminal rejection of this exact aggregate'}});
 fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
 await waitFor(()=>expect(mutationRequests(fixture)).toHaveLength(1));
 const command=mutationRequests(fixture)[0]!.body!;log('FLOW-REJECT-COMMAND',command);
 expect(command).toMatchObject({command:'review.decide',expectedVersions:{[flow.id]:flow.version,...Object.fromEntries(intents.map(i=>[i.id,i.version]))},payload:{targetType:'flow-review',targetId:flow.id,submissionId:submission.id,submissionDigest:submission.contentDigest,decision:'reject',reason:'Terminal rejection of this exact aggregate',waivers:[]}});
 view.unmount();view.cache.clear();
});


test.each(['capability','human','version'] as const)('FLOW-REJECT reconfirms after %s changes and sends no stale rejection',async guard=>{
 const {flow}=aggregateFixture();const adapter=liveWorkAdapter('p');let allowed=true;
 const node=()=> <FlowReview adapter={adapter} flow={flow} records={fixture.records} can={()=>allowed} onDone={()=>undefined}/>;
 const view=mount(node());revealTechnical();fireEvent.click(screen.getByRole('button',{name:'Reject result'}));
 const confirm=screen.getByRole('button',{name:'Confirm'});expect(confirm).toBeDisabled();
 fireEvent.change(screen.getByRole('textbox',{name:'Decision reason'}),{target:{value:'Exact aggregate reason'}});expect(confirm).toBeEnabled();
 if(guard==='capability')allowed=false;
 if(guard==='version')flow.version++;
 view.update(node(),guard==='human'?{principal:{id:'agent:reviewer',kind:'agent',role:'operator'}}:{});
 if(guard==='version'){expect(screen.queryByRole('form',{name:'Reject result'})).not.toBeInTheDocument();}
 else {expect(screen.getByRole('button',{name:'Confirm'})).toBeDisabled();fireEvent.submit(screen.getByRole('form',{name:'Reject result'}));}
 expect(mutationRequests(fixture)).toHaveLength(0);view.unmount();view.cache.clear();
});
