import {fireEvent,screen} from '@testing-library/react';
import {beforeEach,expect,test} from 'vitest';
import {acceptanceFixture,mountAcceptance,type AcceptanceFixture} from './flow-acceptance.fixture';
import {recordOf} from '../src/features/managed-work/model';
let fixture:AcceptanceFixture;
beforeEach(async()=>{fixture=await acceptanceFixture();});
const log=(id:string,value:unknown)=>console.log('EMPIRICAL_PROBE '+id+' '+JSON.stringify(value));
test('F-002 aggregate Read evidence links resolve to exact report DOM targets',async()=>{
 const flow=recordOf(fixture.records,'flow','flow-demo')!;flow.state='in-review';
 const intents=fixture.records.filter(record=>record.kind==='intent');for(const intent of intents){intent.state='accepted';intent.acceptanceDecisionId='accepted-'+intent.id;}
 fixture.records.push({kind:'flow-submission',id:'aggregate-submission',projectId:'p',createdBy:'human:reviewer',createdAt:'2026-11-03T08:00:00Z',flowId:flow.id,flowRevisionId:flow.approvedRevisionId!,acceptedIntents:intents.map(intent=>({intentId:intent.id,intentRevisionId:intent.approvedRevisionId!,decisionId:intent.acceptanceDecisionId!,submissionId:intent.id===fixture.intent.id?fixture.submission.id:'accepted-submission-'+intent.id,subjectDigest:intent.id===fixture.intent.id?fixture.submission.subjectDigest:'a'.repeat(64)})),knowledgeProposalIds:[],contentDigest:'c'.repeat(64),criterionCoverage:[{flowCriterionId:'fc1',intentId:fixture.intent.id,intentCriterionId:fixture.revision.criteria[0]!.criterionId,submissionId:fixture.submission.id,decisionId:'accepted-'+fixture.intent.id}]});
 const mounted=mountAcceptance('canonical',{location:{projectId:'p',tab:'work',flowId:'flow-demo'}});
 await screen.findByRole('list',{name:'Flow composition'});const links=await screen.findAllByRole('link',{name:'Read evidence'});
 expect(links.length,'Fixture must actually produce at least one mapped evidence link').toBeGreaterThan(0);
 const observations=links.map(link=>{const href=link.getAttribute('href')!;const target=document.getElementById(href.slice(1));fireEvent.click(link);return {href,targetExists:!!target,targetText:target?.textContent??null,technicalOpen:!!target?.closest('details')?.open};});
 log('F-002',{route:mounted.context.location,observations,evidence:fixture.records.filter(r=>r.kind==='evidence').map(r=>({id:r.id,report:r.report}))});
 for(const observation of observations){expect.soft(observation.targetExists,observation.href+' must have a concrete exact evidence target').toBe(true);expect.soft(observation.technicalOpen).toBe(true);expect.soft(observation.targetText).toContain('Arrow navigation and focus restoration exercised.');}
 mounted.unmount();mounted.cache.clear();
});
