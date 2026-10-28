import {afterEach,expect,test} from "bun:test";
import {fixture,admittedSession,appliedController,success,type Fixture} from "./fixture.test-support";
import type {Control,FrameOf} from "../../remote-control/protocol";
import {openHubStore} from "../store";
import {expirePendingCommands} from "./delivery";
let f:Fixture;afterEach(async()=>{if(f)await f.close();});
test("an expired delivered unacknowledged start becomes unknown without retrying or claiming cancellation",async()=>{
 f=await fixture();const s=await admittedSession(f);const c=await appliedController(f,s);
 const turn=await success<Control["TurnReceipt"]>(await f.call(`${s.path}/messages`,{method:"POST",cookie:f.cookie,body:{expectedSessionVersion:2,controller:{controllerLeaseId:c.lease.controllerLeaseId,expectedControllerVersion:c.lease.version},expectedConfigVersion:1,text:"uncertain start",interpretation:"literal-message",busyPolicy:"reject",association:{mode:"ad-hoc",profileConsentVersion:1}}}));
 const command=(await s.peer.next("command")).payload as FrameOf<"command">["payload"];
 const store=openHubStore(f.dataDir);store.writeTransaction((_state,repo)=>expirePendingCommands(repo,Date.parse(command.expiresAt)+1));store.close();
 const run=await success<{state:string;cancelRequested?:boolean}>(await f.call(`/hub/v2/projects/${f.project.id}/runs/${turn.runId}`,{cookie:f.cookie}));expect(run.state).toBe("unknown");expect(run.cancelRequested).not.toBe(true);
 const recovery=await success<Control["RecoveryPage"]>(await f.call(`/hub/v2/machines/${s.machine.machineId}/recovery`,{token:s.machine.secret,origin:null}));expect(recovery.runs.find(r=>r.runId===turn.runId)?.commandDigest).toBe(command.commandDigest);
 const response=await f.call(`${s.path}/operations/${turn.operationId}`,{cookie:f.cookie});expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:{code:"recovery-required"}});
});
