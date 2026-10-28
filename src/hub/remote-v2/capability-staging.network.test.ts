import {afterEach,expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {join} from "node:path";
import {fixture,admittedSession,type Fixture} from "./fixture.test-support";
import {parseMachineFrame,type Control} from "../../remote-control/protocol";
let f:Fixture;afterEach(async()=>{if(f)await f.close();});
test("new incomplete capability generations replace old staging and cannot use impossible cursor ranges",async()=>{
 f=await fixture();const s=await admittedSession(f);const db=new Database(join(f.dataDir,"hub.sqlite"));const published=JSON.parse(db.query<{body:string},[]>('SELECT body FROM remote_projection').get()!.body) as import('./model').Projection;const original:Extract<Control['CapabilityPage'],{kind:'routing'}>={projectId:published.projectId,checkoutId:published.checkoutId,agentProfileId:published.agentProfileId,projectionVersion:published.projectionVersion,inventoryVersion:published.inventoryVersion,policyDigest:published.policyDigest,capabilityDigest:published.capabilityDigest,catalogueVersion:published.catalogueVersion,catalogueDigest:published.catalogueDigest,cursor:0,nextCursor:null,kind:'routing',totalEntries:published.candidates.length,entries:published.candidates,profileIds:published.profileIds};
 s.peer.send("capability-page",{...original,projectionVersion:2,entries:[],totalEntries:1,nextCursor:1});const rejected=await s.peer.next("error");expect(parseMachineFrame(JSON.stringify(rejected),"hub-to-machine").ok).toBe(true);expect(rejected.payload).toMatchObject({code:"invalid-frame"});
 for(let version=3;version<30;version++)s.peer.send("capability-page",{...original,projectionVersion:version,totalEntries:original.entries.length+1,nextCursor:original.entries.length});s.peer.send("heartbeat",{daemonId:"daemon-1"});await s.peer.next("heartbeat-ack");
 const rows=db.query<{body:string},[]>("SELECT body FROM remote_capability_page").all();expect(rows).toHaveLength(1);expect(JSON.parse(rows[0]!.body).projectionVersion).toBe(29);db.close();
});
