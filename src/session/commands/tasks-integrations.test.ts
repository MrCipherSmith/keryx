import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJobRegistry, type BackgroundProcessHandle } from "../../harness/tool/builtin/background-job-registry";
import { createSessionApprovalService } from "../question-service";
import { executeTasksIntegration, tasksIntegrationsCommands, type TasksIntegrationContext } from "./tasks-integrations";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
 const cwd = await mkdtemp(path.join(tmpdir(), "native-integrations-")); roots.push(cwd);
 let output: ((text: string, stream: "stdout" | "stderr") => void) | undefined; let exit: ((info: {exitCode:number}) => void) | undefined;
 const handle: BackgroundProcessHandle = {pid:4242,onOutput(cb){output=cb;},onExit(cb){exit=cb;},kill(){exit?.({exitCode:143});}};
 const jobs=createJobRegistry({cwd,spawn:()=>handle,idleMs:0,killGraceMs:1,initialBufferMs:0});
 const context: TasksIntegrationContext={cwd,jobs,sessionId:"session-fixture",policyDigest:"a".repeat(64),actorId:"human-fixture",authorize:async()=>{},authorizeOwnedControl:async command=>{await context.authorize?.(command);}};
 return {cwd,jobs,context,emit:(text:string)=>output?.(text,"stdout"),cleanup:()=>jobs.sweepAll()};
}
test("tasks use actual session registry, explicit repeatable cursor, exact task IDs and real stop result",async()=>{
 const f=await fixture(); try {
 const started=await f.jobs.start("fixture"); if(!started.ok)throw new Error("fixture"); f.emit("actual output");
 expect(await executeTasksIntegration(f.context,"tasks",{})).toMatchObject({ok:true,data:[{taskId:started.jobId,status:"running"}]});
 const read=await executeTasksIntegration(f.context,"tasks.output",{taskId:started.jobId,cursor:0});
 expect(read).toMatchObject({ok:true,data:{output:"actual output",nextCursor:13}});
 expect(await executeTasksIntegration(f.context,"tasks.output",{taskId:started.jobId,cursor:0})).toEqual(read);
 expect(await executeTasksIntegration(f.context,"tasks.kill",{taskId:"4242"})).toMatchObject({ok:false,error:{code:"not-found"}});
 expect(await executeTasksIntegration(f.context,"tasks.kill",{taskId:started.jobId})).toMatchObject({ok:true,data:{status:"killed"}});
 }finally{await f.cleanup();}
});
test("demote shares actual registry domain guard and refuses strangers, malformed fields and already-background",async()=>{
 const f=await fixture(); try{
 const started=await f.jobs.start("fixture",{phase:"foreground"}); if(!started.ok)throw new Error("fixture");
 expect(await executeTasksIntegration(f.context,"demote",{taskId:"4242"})).toMatchObject({ok:false,error:{code:"not-found"}});
 expect(await executeTasksIntegration(f.context,"demote",{taskId:started.jobId})).toMatchObject({ok:true});
 expect(f.jobs.get(started.jobId)?.phase).toBe("background");
 expect(await executeTasksIntegration(f.context,"demote",{taskId:started.jobId})).toMatchObject({ok:false,error:{code:"domain-refused"}});
 expect(await executeTasksIntegration(f.context,"tasks.output",{taskId:started.jobId,cursor:-1})).toMatchObject({ok:false,error:{code:"invalid-arguments"}});
 }finally{await f.cleanup();}
});
test("task actions require fresh host authority; no arbitrary input actor or process authority",async()=>{
 const f=await fixture();try{
 const started=await f.jobs.start("fixture");if(!started.ok)throw new Error("fixture");f.context.authorize=async()=>{throw new Error("stale");};
 expect(await executeTasksIntegration(f.context,"tasks.kill",{taskId:started.jobId})).toMatchObject({ok:false,error:{code:"policy-denied"}});
 expect(f.jobs.get(started.jobId)?.status).toBe("running");
 expect(await executeTasksIntegration(f.context,"tasks.kill",{taskId:started.jobId,actorId:"forged"})).toMatchObject({ok:false,error:{code:"invalid-arguments"}});
 }finally{await f.cleanup();}
});
test("approval answers resolve only exact current live broker action and consume once",async()=>{
 const f=await fixture();let delivered!:()=>void;const ready=new Promise<void>(resolve=>{delivered=resolve;});
 const service=createSessionApprovalService({dir:path.join(f.cwd,"approvals"),sessionId:f.context.sessionId,connected:()=>true,deliver(){delivered();}});
 const waiter=service.request({runId:"run-one",turnId:"turn-one",policyDigest:f.context.policyDigest,toolName:"write_file",risk:"write",input:'{"path":"a.txt"}',fingerprint:"private-action-key"});await ready;
 f.context.approvals={pending:service.pending,answer:async input=>service.answer({...input,actorId:f.context.actorId})};
 const question=service.pending()[0]!;
 expect(await executeTasksIntegration(f.context,"approvals.allow-once",{...question,fingerprint:"b".repeat(64)})).toMatchObject({ok:false,error:{code:"not-found"}});
 expect(await executeTasksIntegration(f.context,"approvals.deny",question)).toMatchObject({ok:true,data:{status:"applied"}});
 expect(await waiter).toMatchObject({approved:false});
 expect(await executeTasksIntegration(f.context,"approvals.allow-once",question)).toMatchObject({ok:false,error:{code:"not-found"}});
});
test("safe actual read domains return genuine empty configuration and bound local status",async()=>{
 const f=await fixture();
 expect(await executeTasksIntegration(f.context,"intake",{})).toMatchObject({ok:true,data:{configured:false}});
 expect(await executeTasksIntegration(f.context,"autoreview",{})).toMatchObject({ok:true,data:[]});
 expect(await executeTasksIntegration(f.context,"schedules",{})).toMatchObject({ok:true,data:[]});
 f.context.integrations={channels:{status:async()=>({ok:false,code:"serve-down",reason:"fixture unavailable"}),localFiles:()=>({tokenFile:false,configFile:false})}};
 expect(await executeTasksIntegration(f.context,"channels",{})).toMatchObject({ok:true,data:{state:"serve-down",configured:false}});
});
test("standing defaults and global credentials are specific local boundaries; all schemas are closed",async()=>{
 const f=await fixture();
 for(const command of ["connect.add-key","connect.device-login","remote-policy.mode-trust","schedule"]){
 expect(await executeTasksIntegration(f.context,command,{})).toMatchObject({ok:false,error:{code:"local-required"}});
 }
 expect(tasksIntegrationsCommands().every(item=>item.entry.inputSchema.type==="object"&&item.entry.inputSchema.additionalProperties===false)).toBe(true);
 expect(await executeTasksIntegration(f.context,"channels",{token:"never"})).toMatchObject({ok:false,error:{code:"invalid-arguments"}});
});
test("bus calls actual shared client over temporary project storage; missing lease defaults refuse honestly",async()=>{
 const f=await fixture();
 const proc=Bun.spawn(["git","init","-q"],{cwd:f.cwd,env:{PATH:process.env.PATH??""},stdout:"ignore",stderr:"pipe"});expect(await proc.exited).toBe(0);
 const {joinBus}=await import("../../bus/client");
 const joined=await joinBus({cwd:f.cwd,sessionId:"9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f",surface:"readline",env:{},status:()=>({status:"idle",activity:"fixture"}),onEvent(){},onPeers(){},resolveBranch:async()=>null});
 if("disabled"in joined)throw new Error("fixture bus disabled");
 try{
 f.context.integrations={bus:joined};f.context.execution={runId:"run-bus",turnId:"turn-bus"};f.context.signal=new AbortController().signal;
 expect(await executeTasksIntegration(f.context,"bus.name",{name:"fixture-name"})).toMatchObject({ok:true});expect(joined.name).toBe("fixture-name");
 expect(await executeTasksIntegration(f.context,"bus.name",{name:"bad extra"})).toMatchObject({ok:false,error:{code:"invalid-arguments"}});expect(joined.name).toBe("fixture-name");
 expect(await executeTasksIntegration(f.context,"bus",{})).toMatchObject({ok:true,data:[]});
 expect(await executeTasksIntegration(f.context,"bus.resume",{})).toMatchObject({ok:false,error:{code:"not-found"}});
 expect(await executeTasksIntegration(f.context,"bus.override",{})).toMatchObject({ok:false,error:{code:"not-found"}});
 }finally{joined.leave();}
});
test("MCP tool trust revocation narrows the actual session grant map, never edits global server trust",async()=>{
 const f=await fixture();f.context.execution={runId:"run-mcp",turnId:"turn-mcp"};f.context.signal=new AbortController().signal;const trusted=new Map([["fixture__read","a".repeat(64)],["fixture__write","b".repeat(64)]]);
 f.context.integrations={mcp:{status:()=>({servers:[]}),trusted,disconnectSession:async()=>({ok:true})}};
 expect(await executeTasksIntegration(f.context,"mcp.trust-list",{})).toMatchObject({ok:true});
 expect(await executeTasksIntegration(f.context,"mcp.trust-revoke-fqn",{fqn:"fixture__read"})).toMatchObject({ok:true});expect(trusted.has("fixture__read")).toBe(false);expect(trusted.has("fixture__write")).toBe(true);
 expect(await executeTasksIntegration(f.context,"mcp.trust-revoke-all",{})).toMatchObject({ok:true});expect(trusted.size).toBe(0);
});
test("owned control cannot borrow ordinary inspection or execution authority",async()=>{
 const f=await fixture();try{
 const started=await f.jobs.start("fixture");if(!started.ok)throw new Error("fixture");
 delete f.context.authorizeOwnedControl;
 expect(await executeTasksIntegration(f.context,"tasks.kill",{taskId:started.jobId})).toMatchObject({ok:false,error:{code:"policy-denied"}});expect(f.jobs.get(started.jobId)?.status).toBe("running");
 const entry=tasksIntegrationsCommands().find(row=>row.entry.commandName==="tasks.kill")!.entry;
 expect(entry).toMatchObject({mutationClass:"session",busyPolicy:"reject",confirmation:"none",states:["idle","busy","paused"]});
 expect(tasksIntegrationsCommands().find(row=>row.entry.commandName==="bus")!.entry.availability).toBe("setup-required");
 }finally{await f.cleanup();}
});
test("ordinary controller inspection authority cannot start provider or bus execution",async()=>{
 const f=await fixture();let called=false;f.context.integrations={providers:{list:()=>[],test:async()=>{called=true;return{};},select:async()=>({})}};
 expect(await executeTasksIntegration(f.context,"connect.test",{id:"local-provider"})).toMatchObject({ok:false,error:{code:"policy-denied"}});expect(called).toBe(false);
});
test("autoreview arbiter inspection reads the session checkout's actual run files with no controller, and renders the terminal's own outcome",async()=>{
 const f=await fixture();const {mkdir,writeFile}=await import("node:fs/promises");const {createAutoReviewController}=await import("../../tui/autoreview-surface");
 const dir=path.join(f.cwd,".metaproject/data/review-autonomous/o-r-pr7");await mkdir(dir,{recursive:true});
 await writeFile(path.join(dir,"progress.json"),JSON.stringify({state:"running",ref:"https://github.com/o/r/pull/7",phase:"review ingest",rounds:1,tokens:10,startedAt:"2026-10-11T11:00:00.000Z",updatedAt:"2026-10-11T11:30:00.000Z"}));
 await writeFile(path.join(dir,"lock.json"),JSON.stringify({pid:process.pid,startedAt:"2026-10-11T11:00:00.000Z"}));
 await writeFile(path.join(dir,"arbiter.log"),[{at:"2026-10-11T11:31:02.000Z",kind:"scope",verdict:"deny",rule:"R-02",reason:"model",cached:false,ms:4},{at:"2026-10-11T11:32:02.000Z",kind:"budget",verdict:"escalate",rule:"none",reason:"timeout",cached:false,ms:4}].map(row=>`${JSON.stringify(row)}\n`).join(""));
 const said:string[]=[];createAutoReviewController({cwd:f.cwd,notice:text=>said.push(text),start:()=>{throw new Error("no-start");},stop:()=>{throw new Error("no-stop");}}).handleCommand("/autoreview arbiter 7");
 const result=await executeTasksIntegration(f.context,"autoreview.arbiter",{selector:"7"});
 expect(result).toEqual({ok:true,data:{outcome:"log",label:"o/r#7",asked:2,escalated:1,text:said.join("")}});
 expect(JSON.stringify(result)).not.toContain(String(process.pid));
 expect(await executeTasksIntegration(f.context,"autoreview.arbiter",{selector:"99"})).toMatchObject({ok:true,data:{outcome:"no-match",candidates:["o/r#7"]}});
 expect(await executeTasksIntegration(f.context,"autoreview.ls",{})).toMatchObject({ok:true,data:[{label:"o/r#7",live:true,arbiter:{asked:2,escalated:1}}]});
 const entries=Object.fromEntries(tasksIntegrationsCommands().map(row=>[row.entry.commandName,row.entry]));
 expect(entries["autoreview.arbiter"]).toMatchObject({availability:"available",mutationClass:"read",confirmation:"none"});
 // The owned execution adapter does not exist yet: an implementation gap, never "local setup", and never the lock-file PID killer.
 for(const name of ["autoreview.start","autoreview.stop"])expect(entries[name]).toMatchObject({availability:"implementation-gap",reason:"owned-review-execution-adapter-not-implemented"});
 f.context.execution={runId:"run-review",turnId:"turn-review"};f.context.signal=new AbortController().signal;
 expect(await executeTasksIntegration(f.context,"autoreview.stop",{selector:"7"})).toMatchObject({ok:false,error:{code:"implementation-gap"}});
 expect(await executeTasksIntegration(f.context,"autoreview.start",{ref:"https://github.com/o/r/pull/7",budgetMinutes:5,budgetTokens:5})).toMatchObject({ok:false,error:{code:"implementation-gap"}});
 expect(readFileSync(path.join(dir,"lock.json"),"utf8")).toContain(String(process.pid));
});
test("provider commands distinguish an unattached driver, missing selection transaction and an owner's typed not-configured refusal",async()=>{
 const f=await fixture();const {TasksIntegrationError}=await import("./tasks-integrations");
 const none=Object.fromEntries(tasksIntegrationsCommands().map(row=>[row.entry.commandName,row.entry]));
 for(const name of ["connect","connect.test","connect.select"])expect(none[name]).toMatchObject({availability:"implementation-gap"});
 expect(await executeTasksIntegration(f.context,"connect",{})).toMatchObject({ok:false,error:{code:"implementation-gap"}});
 let tested=0;const providers={list:()=>[{candidateId:"local:fixture",state:"configured"},{candidateId:"cloud:fixture",state:"not-configured"}],test:async(id:string)=>{tested++;if(id==="cloud:fixture")throw new TasksIntegrationError("setup-required","No local credential is configured for this provider.");if(id==="vendor:fixture")throw new TasksIntegrationError("implementation-gap","No shared models probe exists for this provider.");return{source:"live",modelCount:1};}};
 f.context.integrations={providers};
 const bound=Object.fromEntries(tasksIntegrationsCommands({port:{providers}}).map(row=>[row.entry.commandName,row.entry]));
 expect(bound.connect).toMatchObject({availability:"available"});expect(bound["connect.test"]).toMatchObject({availability:"available"});expect(bound["connect.select"]).toMatchObject({availability:"available",reason:"exact-session-config-transaction"});
 expect(await executeTasksIntegration(f.context,"connect",{})).toMatchObject({ok:true,data:[{state:"configured"},{state:"not-configured"}]});
 f.context.execution={runId:"run-provider",turnId:"turn-provider"};f.context.signal=new AbortController().signal;
 expect(await executeTasksIntegration(f.context,"connect.test",{id:"local:fixture"})).toEqual({ok:true,data:{source:"live",modelCount:1}});
 expect(await executeTasksIntegration(f.context,"connect.test",{id:"cloud:fixture"})).toEqual({ok:false,error:{code:"setup-required",message:"No local credential is configured for this provider."}});
 expect(await executeTasksIntegration(f.context,"connect.test",{id:"vendor:fixture"})).toMatchObject({ok:false,error:{code:"implementation-gap"}});
 // Selection is the host's config transaction, never executed or authorized on this path.
 expect(await executeTasksIntegration(f.context,"connect.select",{id:"local:fixture"})).toMatchObject({ok:false,error:{code:"domain-refused"}});expect(tested).toBe(3);
});
test("schedule inspection shares actual ledger projection and does not claim an OS timer installation check",async()=>{
 const f=await fixture();const {mkdir,writeFile}=await import("node:fs/promises");await mkdir(path.join(f.cwd,".metaproject"));
 await writeFile(path.join(f.cwd,".metaproject/triggers.json"),JSON.stringify({schemaVersion:1,triggers:[{name:"nightly",on:{kind:"schedule",cron:"0 2 * * *"},action:{kind:"reconcile"}}]}));
 expect(await executeTasksIntegration(f.context,"schedules",{})).toMatchObject({ok:true,data:[{entry:{name:"nightly"},installation:"not-inspected"}]});
});
