import { expect,test } from 'bun:test';
import { scopedFixture } from './storage.fixture.test-support';

test('many incidents on one Attempt load its support once and overflow aggregates fail within a bounded incident page',()=>{
 const f=scopedFixture(),{db,repository,cmd,intentId,a,sub,subject,flowId}=f;
 try{
  cmd('attempt.select',{intentId,attemptId:a.id,submissionId:sub.id,submissionDigest:sub.contentDigest,reason:'Select'});
  cmd('review.decide',{targetType:'intent-review',targetId:intentId,submissionId:sub.id,submissionDigest:sub.contentDigest,decision:'accept',reason:'Accept',waivers:[]});
  const late=cmd('evidence.record',{attemptId:a.id,subjectId:subject.id,subjectDigest:subject.contentDigest,criterionIds:['ic'],result:'fail',method:'late-test',report:'Regression',outputDigest:'b'.repeat(64),sourceRunId:null,sourceObservationId:null});
  const insert=db.query('INSERT INTO hub_work_records(project_id,id,body) VALUES(?,?,?)');
  for(let n=1;n<200;n++)insert.run('p','incident-'+n,JSON.stringify({...late,id:'incident-'+n}));
  const query=db.query.bind(db);let attemptLoads=0;
  db.query=((sql:string)=>{if(sql.includes("json_extract(body,'$.attemptId')=? AND json_extract(body,'$.kind') IN"))attemptLoads++;return query(sql);}) as typeof db.query;
  const aggregate=repository.readState('p',['flows',flowId],new URL('http://hub.test'));
  expect(aggregate.records.filter(record=>record.kind==='evidence'&&record.result==='fail')).toHaveLength(200);
  expect(attemptLoads).toBe(1);
  insert.run('p','incident-overflow',JSON.stringify({...late,id:'incident-overflow'}));
  attemptLoads=0;expect(()=>repository.readState('p',['flows',flowId],new URL('http://hub.test'))).toThrow('Use scoped attention pages');expect(attemptLoads).toBe(0);
 }finally{db.close();}
});

test('aggregate incidents share flow criterion support across distinct accepted attempts',()=>{
 const f=scopedFixture(false,'pass',false,true),{db,repository,cmd,intentId,a,sub,subject,flowId,fr,optional,optionalRevision}=f;
 try{
  cmd('attempt.select',{intentId,attemptId:a.id,submissionId:sub.id,submissionDigest:sub.contentDigest,reason:'Select'});
  const accepted1=cmd('review.decide',{targetType:'intent-review',targetId:intentId,submissionId:sub.id,submissionDigest:sub.contentDigest,decision:'accept',reason:'Accept',waivers:[]});
  const late1=cmd('evidence.record',{attemptId:a.id,subjectId:subject.id,subjectDigest:subject.contentDigest,criterionIds:['ic'],result:'fail',method:'late-test',report:'Regression one',outputDigest:'b'.repeat(64),sourceRunId:null,sourceObservationId:null});
  const ctx=cmd('context.create',{flowRevisionId:fr.id,intentRevisionId:optionalRevision!.id,entries:[],gitBases:[]});
  const second=cmd('attempt.create',{intentRevisionId:optionalRevision!.id,contextSnapshotId:ctx.id,participantId:'h',method:'human',summary:'Implement optional',supersedesAttemptId:null});
  cmd('attempt.start',{attemptId:second.id,flowRevisionDigest:fr.contentDigest,intentRevisionDigest:optionalRevision!.contentDigest,contextDigest:ctx.contentDigest});
  const subject2=cmd('subject.create',{attemptId:second.id,artifacts:[{kind:'git',repositoryId:'repo',commitOid:'b'.repeat(40),treeOid:null,pullRequestNumber:4}],report:'Implemented'});
  const e=cmd('evidence.record',{attemptId:second.id,subjectId:subject2.id,subjectDigest:subject2.contentDigest,criterionIds:['ic'],result:'pass',method:'test',report:'Pass',outputDigest:'a'.repeat(64),sourceRunId:null,sourceObservationId:null});
  const sub2=cmd('attempt.submit',{attemptId:second.id,subjectId:subject2.id,subjectDigest:subject2.contentDigest,evidenceIds:[e.id],coverage:[{criterionId:'ic',result:'pass',evidenceIds:[e.id]}],knowledgeFollowup:{proposalIds:[],noUpdateReason:'No updates'}});
  cmd('attempt.select',{intentId:optional!.id,attemptId:second.id,submissionId:sub2.id,submissionDigest:sub2.contentDigest,reason:'Select'});
  const accepted2=cmd('review.decide',{targetType:'intent-review',targetId:optional!.id,submissionId:sub2.id,submissionDigest:sub2.contentDigest,decision:'accept',reason:'Accept',waivers:[]});
  const late2=cmd('evidence.record',{attemptId:second.id,subjectId:subject2.id,subjectDigest:subject2.contentDigest,criterionIds:['ic'],result:'fail',method:'late-test',report:'Regression two',outputDigest:'c'.repeat(64),sourceRunId:null,sourceObservationId:null});
  const query=db.query.bind(db);let waiverQueries=0;
  db.query=((sql:string)=>{if(sql.includes("json_extract(body,'$.targetType')='criterion-waiver'"))waiverQueries++;return query(sql);}) as typeof db.query;
  const aggregate=repository.readState('p',['flows',flowId],new URL('http://hub.test'));
  expect(aggregate.records.filter(r=>r.id===late1.id||r.id===late2.id)).toHaveLength(2);
  expect(aggregate.records.some(r=>r.id===sub.id)).toBe(true);
  expect(aggregate.records.some(r=>r.id===sub2.id)).toBe(true);
  expect(aggregate.records.some(r=>r.id===accepted1.id)).toBe(true);
  expect(aggregate.records.some(r=>r.id===accepted2.id)).toBe(true);
  expect(waiverQueries).toBeLessThanOrEqual(3); // one Flow criterion and two Intent criteria
 }finally{db.close();}
});
