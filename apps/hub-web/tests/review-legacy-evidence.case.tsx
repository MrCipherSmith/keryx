import {fireEvent,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,test} from 'vitest';
import {acceptanceFixture,mountAcceptance,mutationRequests,type AcceptanceFixture} from './flow-acceptance.fixture';
let fixture:AcceptanceFixture;
beforeEach(async()=>{fixture=await acceptanceFixture();});
const log=(id:string,value:unknown)=>console.log('EMPIRICAL_PROBE '+id+' '+JSON.stringify(value));
test.each(['pending','error'] as const)('F-003 legacy %s evidence is explicit and blocks decisions',async state=>{
 let recovered=false;
 fixture.respond=request=>request.method==='GET'&&request.url.endsWith('/flows/legacy-flow/evidence')?(recovered?Response.json({evidence:[]}):state==='pending'?new Promise<Response>(()=>{}):Response.json({error:{code:'synthetic-evidence-unavailable',message:'Synthetic evidence request failed'}},{status:503})):undefined;
 const mounted=mountAcceptance('legacy');
 // Wait for the independent revision and guide to finish. Only evidence is unavailable.
 await screen.findByText('The highlighted result is visible');
 await waitFor(()=>{const query=mounted.cache.getQueryState([73,'p','flow','legacy-flow','evidence']);expect(query?.status).toBe(state==='pending'?'pending':'error');});
 const accept=screen.getByRole('button',{name:'Accept result'}),ret=screen.getByRole('button',{name:'Return for changes'});
 const availability={alerts:screen.queryAllByRole('alert').map(x=>x.textContent),statuses:screen.queryAllByRole('status').map(x=>x.textContent),retryButtons:screen.queryAllByRole('button',{name:/retry/i}).map(x=>x.textContent)};
 log('F-003',{state,query:mounted.cache.getQueryState([73,'p','flow','legacy-flow','evidence'])?.status,acceptDisabled:(accept as HTMLButtonElement).disabled,returnDisabled:(ret as HTMLButtonElement).disabled,availability,evidenceLinkCount:screen.queryAllByRole('link',{name:'Read evidence'}).length,mutations:mutationRequests(fixture).length});
 expect.soft(accept,'Unavailable required evidence must disable acceptance').toBeDisabled();expect.soft(ret,'Unavailable required evidence must disable return').toBeDisabled();
 if(state==='pending')expect.soft(availability.statuses.some(text=>/loading|evidence/i.test(text??'')),'A visible evidence loading state must distinguish pending from empty success').toBe(true);
 else {expect.soft(availability.alerts.length,'Evidence load failure must be visible').toBeGreaterThan(0);expect.soft(availability.retryButtons.length,'Evidence load failure must offer retry').toBeGreaterThan(0);}
 if(state==='error'){recovered=true;fireEvent.click(screen.getByRole('button',{name:'Retry evidence'}));await waitFor(()=>expect(accept).toBeEnabled());expect(ret).toBeEnabled();}
 expect(mutationRequests(fixture)).toHaveLength(0);mounted.unmount();mounted.cache.clear();
});

test('F-003 successfully loaded empty legacy evidence preserves human review compatibility',async()=>{
 fixture.respond=request=>request.method==='GET'&&request.url.endsWith('/flows/legacy-flow/evidence')?Response.json({evidence:[]}):undefined;
 const mounted=mountAcceptance('legacy');await screen.findByText('The highlighted result is visible');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Accept result'})).toBeEnabled());
 expect(screen.getByRole('button',{name:'Return for changes'})).toBeEnabled();expect(screen.queryAllByRole('link',{name:'Read evidence'})).toHaveLength(0);
 mounted.unmount();mounted.cache.clear();
});
