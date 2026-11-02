import { expect, test } from 'bun:test';
import { scopedFixture } from './storage.fixture.test-support';

function amendmentFixture() {
    const fixture=scopedFixture();
    const {cmd,flowId,intentId,fr,intentPayload}=fixture;
    const revision=cmd('revision.propose',{targetType:'intent',intentId,flowRevisionId:fr.id,deliverable:'Updated result',approach:'Manual',outOfScope:'Other',criteria:intentPayload.criteria,flowCriterionIds:['fc'],criterionMappings:intentPayload.criterionMappings});
    const amendment=cmd('requirements.amend',{flowId,sourceFlowRevisionId:fr.id,affectedIntentIds:[intentId],replacements:[{targetType:'intent',targetId:intentId,revisionId:revision.id,contentDigest:revision.contentDigest}],reason:'Update intent'});
    return {...fixture,revision,amendment};
}
test.each([['approve','approve'],['approve','withdraw'],['withdraw','approve'],['withdraw','withdraw']] as const)('durable amendment resolution %s cannot be followed by %s under a fresh operation/version', (first,second)=>{
    const {db,cmd,state,amendment}=amendmentFixture();
    try{
        cmd('requirements.resolve-amendment',{amendmentId:amendment.id,manifestDigest:amendment.contentDigest,decision:first,reason:'First resolution'});
        const before=JSON.stringify(state.records);
        expect(()=>cmd('requirements.resolve-amendment',{amendmentId:amendment.id,manifestDigest:amendment.contentDigest,decision:second,reason:'Second fresh operation'})).toThrow('Amendment is stale or resolved');
        expect(JSON.stringify(state.records)).toBe(before);
        expect(db.query("SELECT count(*) AS n FROM hub_work_records WHERE json_extract(body,'$.kind')='decision' AND json_extract(body,'$.targetType')='amendment'").get()).toEqual({n:1});
    }finally{db.close();}
});
test('Flow-only membership amendment accepts an empty affected Intent set in command and immutable record schemas',()=>{
    const {db,cmd,flowId,intentId,fr}=scopedFixture();
    try{
        cmd('work.cancel',{targetType:'intent',targetId:intentId,reason:'Remove cancelled dependent work'});
        const revision=cmd('revision.propose',{targetType:'flow',flowId,problem:'Flow-only adjustment',expectedOutcome:'Updated scope',scope:'Scope',outOfScope:'Other',specification:null,criteria:[{criterionId:'fc',text:'Works',waivable:false}],requiredIntentIds:[]});
        const amendment=cmd('requirements.amend',{flowId,sourceFlowRevisionId:fr.id,affectedIntentIds:[],replacements:[{targetType:'flow',targetId:flowId,revisionId:revision.id,contentDigest:revision.contentDigest}],reason:'Flow-only change'});
        expect(amendment.affectedIntentIds).toEqual([]);
        cmd('requirements.resolve-amendment',{amendmentId:amendment.id,manifestDigest:amendment.contentDigest,decision:'approve',reason:'Accept exact Flow-only replacement'});
    }finally{db.close();}
});
