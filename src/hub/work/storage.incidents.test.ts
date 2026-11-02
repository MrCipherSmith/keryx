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
