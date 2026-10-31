import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {fixture,admittedSession,appliedController,success,D,type Fixture} from './fixture.test-support';
import {catalogueDigest,type Control,type FrameOf} from '../../remote-control/protocol';
let f:Fixture;afterEach(async()=>{if(f)await f.close();});
const entry:Control['CommandCatalogueEntry']={commandName:'new',summary:'New',handlerId:'native.conversation.new',inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},resultSchema:{type:'string',maxLength:32768},mutationClass:'session',states:['idle'],busyPolicy:'reject',confirmation:'none',availability:'available',reason:''};
test('fresh lifecycle grant rechecks server selected child and current mapped inventory without changing immutable delivery',async()=>{
 f=await fixture();const s=await admittedSession(f,[entry]);const c=await appliedController(f,s);const controller={controllerLeaseId:c.lease.controllerLeaseId,expectedControllerVersion:c.lease.version};
 const receipt=await success<Control['SessionOperationReceipt']>(await f.call(`${s.path}/commands/invoke`,{method:'POST',cookie:f.cookie,body:{expectedSessionVersion:2,controller,expectedConfigVersion:1,catalogueDigest:catalogueDigest([entry]),commandName:'new',arguments:{},busyPolicy:'reject'}}));
 const envelope=(await s.peer.next('session-command')).payload as FrameOf<'session-command'>['payload'];const path=`/hub/v2/machines/${s.machine.machineId}/commands/${envelope.commandId}/authorize`;const request={commandDigest:envelope.commandDigest,policyDigest:D,target:envelope.target,controller};
 expect((await f.call(path,{method:'POST',token:s.machine.secret,origin:null,body:request})).status).toBe(200);
 const db=new Database(join(f.dataDir,'hub.sqlite'));const original=db.query<{body:string},[string]>('SELECT body FROM remote_inventory WHERE id=?').get(s.machine.machineId)!.body;const inventory=JSON.parse(original);inventory.checkouts[0].clean=false;db.query('UPDATE remote_inventory SET body=? WHERE id=?').run(JSON.stringify(inventory),s.machine.machineId);
 expect((await f.call(path,{method:'POST',token:s.machine.secret,origin:null,body:request})).status).toBe(409);
 db.query('UPDATE remote_inventory SET body=? WHERE id=?').run(original,s.machine.machineId);const child=JSON.parse(db.query<{body:string},[string]>('SELECT body FROM remote_session WHERE id=?').get(receipt.sessionId)!.body);child.record.version++;child.record.state='idle';db.query('UPDATE remote_session SET body=? WHERE id=?').run(JSON.stringify(child),receipt.sessionId);db.close();
 expect((await f.call(path,{method:'POST',token:s.machine.secret,origin:null,body:request})).status).toBe(409);
});

test('existing sessions cannot borrow a stale capability generation after inventory refresh and recover only after complete current pages',async()=>{
 const {publishCapabilities}=await import('./fixture.test-support');f=await fixture();const s=await admittedSession(f);const c=await appliedController(f,s);const metadata=await success<import('../../remote-control/protocol').MachineSummary>(await f.call(`/hub/v2/machines/${s.machine.machineId}`,{cookie:f.cookie}));s.peer.send('inventory',{...metadata.inventory,inventoryVersion:2});s.peer.send('heartbeat',{daemonId:'daemon-1'});await s.peer.next('heartbeat-ack');
 const request={expectedSessionVersion:2,controller:{controllerLeaseId:c.lease.controllerLeaseId,expectedControllerVersion:c.lease.version},expectedConfigVersion:1,text:'Only current registry',interpretation:'literal-message',busyPolicy:'reject',association:{mode:'ad-hoc',profileConsentVersion:1}};
 expect((await f.call(`${s.path}/messages`,{method:'POST',cookie:f.cookie,body:request})).status).toBe(409);
 await publishCapabilities(f,s.peer,[],2,2);expect((await f.call(`${s.path}/messages`,{method:'POST',cookie:f.cookie,body:request})).status).toBe(200);
});
