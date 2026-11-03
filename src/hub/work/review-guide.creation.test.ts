import {afterEach,expect,test} from 'bun:test';
import type {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import type {HubDocument} from '../contracts';
import {workCommand} from './domain';
import {scopedFixture,context,human} from './storage.fixture.test-support';
const databases:Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function fixture(){
 const f=scopedFixture();databases.push(f.db);
 f.cmd('attempt.withdraw',{attemptId:f.a.id,submissionId:f.sub.id,submissionDigest:f.sub.contentDigest,reason:'New attempt'});
 const a=f.cmd('attempt.create',{intentRevisionId:f.ir.id,contextSnapshotId:f.ctx.id,participantId:'h',method:'human',summary:'Guide attempt',supersedesAttemptId:null});
 f.cmd('attempt.start',{attemptId:a.id,flowRevisionDigest:f.fr.contentDigest,intentRevisionDigest:f.ir.contentDigest,contextDigest:f.ctx.contentDigest});
 let n=0;
 const guide={format:'review-guide/v1',summary:'Delivery',userImpact:'Clear review',limitations:[],prerequisites:[],steps:[{stepId:'one',criterionIds:['ic'],location:'Browser',instruction:'Open the result',expectedResult:'Visible'}]};
 const content=JSON.stringify(guide),hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 const document:HubDocument={id:'guide',projectId:'p',path:'guides/result.json',kind:'wiki',version:1,content,contentDigest:hash(content),approval:'unreviewed',sourceRevision:'fixture'};
 const reference={documentId:document.id,version:document.version,contentDigest:document.contentDigest};
 const artifacts=[{kind:'document',reference,proposalId:null}];
 const envelope=(selector:unknown=reference)=>JSON.stringify({format:'review-report/v1',summary:'Delivery',body:'Report',reviewGuide:selector});
 const create=(report:string,manifest:unknown=artifacts,doc=document)=>{
  const input={operationId:'guide-create-'+(++n),expectedVersions:Object.fromEntries(f.state.records.filter(r=>'version'in r).map(r=>[r.id,'version'in r?r.version:1])),command:'subject.create',payload:{attemptId:a.id,artifacts:manifest,report}};
  const scoped=f.repository.commandState('p',input,human.id),result=workCommand(scoped,human,'p',input,{...context,resolveDocument:(_project,ref)=>ref.documentId===doc.id&&ref.version===doc.version&&ref.contentDigest===doc.contentDigest?doc:undefined});
  f.repository.save('p',scoped);f.state.records=f.repository.load('p').records;return result;
 };
 return {...f,create,guide,document,reference,artifacts,envelope,hash};
}
test('subject.create refuses a malformed designated report before storing a subject',()=>{
 const f=fixture(),before=JSON.stringify(f.repository.load('p'));
 expect(()=>f.create(JSON.stringify({format:'review-report/v1',summary:' ',body:'Report',reviewGuide:null}))).toThrow();
 expect(JSON.stringify(f.repository.load('p'))).toBe(before);
});
test('subject.create binds one exact designated artifact and rejects absent or duplicate matches',()=>{
 const f=fixture(),before=JSON.stringify(f.repository.load('p'));
 const ordinary=[{kind:'report',text:'Report',contentDigest:f.hash('Report')}];
 expect(()=>f.create(f.envelope(),ordinary)).toThrow();expect(()=>f.create(f.envelope(),[...f.artifacts,...f.artifacts])).toThrow();
 expect(JSON.stringify(f.repository.load('p'))).toBe(before);
});
test('subject.create validates pinned criterion membership and actual immutable guide bytes',()=>{
 const f=fixture(),before=JSON.stringify(f.repository.load('p'));
 const content=JSON.stringify({...f.guide,steps:[{...f.guide.steps[0],criterionIds:['foreign']}]}),doc={...f.document,content,contentDigest:f.hash(content)},reference={...f.reference,contentDigest:doc.contentDigest};
 expect(()=>f.create(f.envelope(reference),[{kind:'document',reference,proposalId:null}],doc)).toThrow();
 expect(()=>f.create(f.envelope(),f.artifacts,{...f.document,content:f.document.content+' '})).toThrow();
 expect(JSON.stringify(f.repository.load('p'))).toBe(before);
});
test('subject.create preserves plain reports and permits a valid exact historical guide without granting verification',()=>{
 const f=fixture();expect(()=>f.create('{"ordinary":"JSON report"}',[{kind:'report',text:'Report',contentDigest:f.hash('Report')}])).not.toThrow();
 expect(()=>f.create(f.envelope())).not.toThrow();
 const subjects=f.repository.load('p').records.filter(r=>r.kind==='subject');expect(subjects).toHaveLength(3);
 const guided=subjects.find(r=>r.kind==='subject'&&r.report===f.envelope());expect(guided).toMatchObject({kind:'subject',createdBy:'h',artifacts:f.artifacts});
 expect(guided).not.toHaveProperty('verified');
});
