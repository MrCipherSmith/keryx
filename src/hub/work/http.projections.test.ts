import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubApplication } from '../server';
import type { HubApplication } from '../contracts';
import { createWorkClient } from './client';
import { matchesWorkSchema } from './openapi';
import { context, scopedFixture } from './storage.fixture.test-support';

const directories:string[]=[],apps:HubApplication[]=[];
afterEach(()=>{for(const app of apps.splice(0))app.close();for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
function acceptedIncident() {
    const f=scopedFixture();
    const {cmd,intentId,a,subject,sub}=f;
    cmd('attempt.select',{intentId,attemptId:a.id,submissionId:sub.id,submissionDigest:sub.contentDigest,reason:'Select'});
    cmd('review.decide',{targetType:'intent-review',targetId:intentId,submissionId:sub.id,submissionDigest:sub.contentDigest,decision:'accept',reason:'Accept',waivers:[]});
    const late=cmd('evidence.record',{attemptId:a.id,subjectId:subject.id,subjectDigest:subject.contentDigest,criterionIds:['ic'],result:'fail',method:'late-test',report:'Regression',outputDigest:'b'.repeat(64),sourceRunId:null,sourceObservationId:null});
    const dir=mkdtempSync(join(tmpdir(),'hub-http-projection-'));directories.push(dir);
    f.db.query('INSERT INTO hub_state(id,body) VALUES(1,?)').run(JSON.stringify(context.legacy));
    writeFileSync(join(dir,'hub.sqlite'),f.db.serialize());f.db.close();
    const token='operator-'+'o'.repeat(64),app=createHubApplication({dataDir:dir,operatorToken:token,agentToken:'agent-'+'a'.repeat(64),workManagement:{enabled:true}});apps.push(app);
    const client=createWorkClient({baseUrl:'http://127.0.0.1',headers:{authorization:'Bearer '+token},fetch:request=>app.fetch(request)});
    const get=(suffix:string)=>app.fetch(new Request('http://127.0.0.1/hub/work/v1/projects/p/'+suffix,{headers:{authorization:'Bearer '+token}}));
    return {client,get,flowId:f.flowId,intentId,late};
}
test('live Flow and Intent aggregates expose a late contradictory Evidence incident from indexed persistence',async()=>{
    const {client,flowId,intentId,late}=acceptedIncident();
    for(const [route,parameters] of [['get_flow',{flowId}],['get_intent',{intentId}]] as const){
        const projection=await client.read(route,'p',parameters);
        expect(projection.records.filter(record=>record.id===late.id)).toHaveLength(1);
    }
});
test('live attention Evidence response satisfies the closed API schema and Work client',async()=>{
    const {client,get,late}=acceptedIncident();
    const response=await get('attention');expect(response.status).toBe(200);
    const page=await response.json();expect(matchesWorkSchema(page,{$ref:'#/components/schemas/AttentionPage'})).toBe(true);
    const parsed=await client.read('attention','p');expect(parsed.records.some(record=>record.id===late.id&&record.kind==='evidence')).toBe(true);
});
test('live capabilities expose the published closed limit contract to the Work client',async()=>{
    const {client}=acceptedIncident();
    const capabilities=await client.read('capabilities','p');
    expect(capabilities.limits.maxCommandBytes).toBe(65536);
    expect(Object.keys(capabilities.limits).sort()).toEqual(['maxCommandBytes','defaultPageSize','maxPageSize','maxEventPageSize','maxEventBytes','maxSnapshotBytes'].sort());
});
