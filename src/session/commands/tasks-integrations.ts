import { runMcpTrustCommand } from "../../mcp-servers/approval-render";
import { demoteTask, type JobRegistry } from "../../harness/tool/builtin/background-job-registry";
import { buildIntakeStatus } from "../../intake/status";
import { loadTriggerLedgerView, scheduledEntries } from "../../tui/trigger-ledger";
import { readAutoReviewArbiter, readAutoReviewRuns, parseAutoReviewArgs, type AutoReviewCommand } from "../../tui/autoreview-surface";
import { loadChannelsSnapshot, type ChannelsApi } from "../../tui/channels-surface";
import { parseBusCommand, type ParsedBusCommand } from "../../tui/bus-command";
import type { BusClient } from "../../bus/client";
import type { SessionApprovalAnswer, AppliedApprovalAnswer } from "../question-service";
import type { NativeCommandContribution, SessionCommandContext } from "./handlers";
import { validateArguments, type Control } from "../../remote-control/protocol";
import { redactSensitiveText } from "../../security/service";
import { sessionConfigResultSchemas } from "./session-settings";

export interface TasksApprovalPort {
 pending(): {approvalId:string;runId:string;turnId:string;fingerprint:string;policyDigest:string}[];
 /** Actor is derived by the host from its authenticated operation, never from command arguments. */
 answer(input:Omit<SessionApprovalAnswer,"actorId">):Promise<AppliedApprovalAnswer>;
}
/** Local application composition only; none of these callbacks are decoded from remote input. */
export interface TasksIntegrationsPort {
 channels?:Pick<ChannelsApi,"status"|"localFiles">;
 bus?:Pick<BusClient,"peers"|"send"|"reply"|"rename"|"pause"|"resume"|"override"|"leaseView">;
 mcp?:{status():unknown;trusted:Map<string,string>;disconnectSession(name:string,signal:AbortSignal):Promise<unknown>};
 remotePolicy?:()=>unknown;
 /** `select` is the native owner's serialized configuration transaction; absent, selection is an implementation gap. */
 providers?:{list():unknown;test(id:string,signal:AbortSignal):Promise<unknown>;select?(id:string,signal:AbortSignal):Promise<unknown>};
 remote?:{status():unknown;start(name:string|undefined,signal:AbortSignal):Promise<unknown>;stop(signal:AbortSignal):Promise<unknown>};
 /** A locally supervised review for this exact native session; never the legacy lock-file PID killer. Arbiter reads need no owner. */
 autoreview?:{start(command:Extract<AutoReviewCommand,{kind:"start"}>,signal:AbortSignal):Promise<unknown>;stop(selector:string|undefined,signal:AbortSignal):Promise<unknown>};
}
export type OwnedControlCommand="tasks.kill"|"demote"|"approvals.allow-once"|"approvals.deny";
const ownedControls:readonly string[]=["tasks.kill","demote","approvals.allow-once","approvals.deny"];
export interface TasksIntegrationContext {
 cwd:string;jobs:JobRegistry;sessionId:string;policyDigest:string;actorId:string;
 approvals?:TasksApprovalPort;integrations?:TasksIntegrationsPort;
 /** Fresh host controller, local policy and cancellation check immediately before each effect. */
 authorize?:((action:string)=>Promise<void>)|undefined;
 execution?:{runId:string;turnId:string};
 signal?:AbortSignal;
 authorizeOwnedControl?:(command:OwnedControlCommand,args:Readonly<Record<string,string|number|undefined>>)=>Promise<void>;
}
export type TasksIntegrationResult={ok:true;data:unknown}|{ok:false;error:{code:"invalid-arguments"|"not-found"|"domain-refused"|"policy-denied"|"local-required"|"setup-required"|"implementation-gap"|"cancelled"|"quota-exceeded"|"read-failed";message:string}};
/** A typed refusal a local domain owner raises. Its code and owner-written, credential-free message reach the caller unchanged. */
export class TasksIntegrationError extends Error{constructor(readonly code:"not-found"|"setup-required"|"implementation-gap"|"policy-denied",message:string){super(message);this.name="TasksIntegrationError";}}
type Schema=Control["ArgumentSchema"];
const text=(maxLength=200):Schema=>({type:"string",maxLength});
const object=(properties:Record<string,Schema>={},required:string[]=[]):Schema=>({type:"object",properties,required,additionalProperties:false});
const integer=(maximum=Number.MAX_SAFE_INTEGER):Schema=>({type:"integer",minimum:0,maximum});
const taskArgs=object({taskId:text()},["taskId"]);
const approvalArgs=object({approvalId:text(),runId:text(),turnId:text(),fingerprint:text(64),policyDigest:text(64)},["approvalId","runId","turnId","fingerprint","policyDigest"]);
interface Variant {name:string;schema:Schema;source:string;effect?:boolean;local?:string;alias?:string}
const variants:Variant[]=[
 {name:"tasks",schema:object(),source:"src/tui/tasks-command.ts:runTasksCommand"},
 {name:"tasks.output",schema:object({taskId:text(),cursor:integer()},["taskId"]),source:"src/tui/tasks-command.ts:runTasksCommand"},
 {name:"tasks.kill",schema:taskArgs,source:"src/tui/tasks-command.ts:runTasksCommand",effect:true},
 {name:"demote",schema:taskArgs,source:"src/harness/tool/builtin/background-job-registry.ts:demoteTask",effect:true},
 {name:"approvals",schema:object(),source:"src/session/question-service.ts:pending"},
 ...["allow-once","deny"].map(action=>({name:`approvals.${action}`,schema:approvalArgs,source:"src/session/question-service.ts:answer",effect:true})),
 {name:"channels",schema:object(),source:"src/tui/channels-surface.ts:loadChannelsSnapshot"},
 {name:"intake",schema:object(),source:"src/intake/status.ts:buildIntakeStatus"},
 {name:"intake.list",schema:object(),source:"src/intake/status.ts:buildIntakeStatus"},
 ...["pause","resume","poll"].map(action=>({name:`intake.${action}`,schema:object(),source:"src/intake/status.ts:setIntakePaused;src/intake/poll.ts:runIntakePoll",local:"persistent-intake-automation-requires-standing-local-authorization"})),
 {name:"schedules",schema:object(),source:"src/tui/trigger-ledger.ts:loadTriggerLedgerView/scheduledEntries"},
 ...["pause","resume","run","delete"].map(action=>({name:`schedules.${action}`,schema:object({name:text()}),source:"src/trigger/schedules.ts;src/tui/schedules-inspector.ts",local:"persistent-schedule-timer-and-grants-require-standing-local-authorization"})),
 {name:"schedule",schema:object(),source:"src/tui/schedule-command.ts:runScheduleSlashCommand",local:"persistent-schedule-add-requires-exact-draft-confirmation-and-standing-local-grants"},
 {name:"autoreview",schema:object(),source:"src/tui/autoreview-surface.ts:readAutoReviewRuns"},
 {name:"autoreview.ls",schema:object(),source:"src/tui/autoreview-surface.ts:parseAutoReviewArgs",alias:"autoreview"},
 {name:"autoreview.start",schema:object({ref:text(1000),budgetMinutes:integer(1440),budgetTokens:integer(10000000)},["ref","budgetMinutes","budgetTokens"]),source:"src/tui/autoreview-surface.ts:parseAutoReviewArgs",effect:true},
 {name:"autoreview.stop",schema:object({selector:text()}),source:"src/tui/autoreview-surface.ts:createAutoReviewController",effect:true},
 {name:"autoreview.arbiter",schema:object({selector:text()}),source:"src/tui/autoreview-surface.ts:readAutoReviewArbiter"},
 {name:"mcp",schema:object(),source:"src/mcp-servers/runtime.ts:servers/catalog"},
 {name:"mcp.connect",schema:object({name:text()}),source:"src/mcp-servers/runtime.ts:connectServer",local:"mcp-connect-persists-personal-overlay-and-may-spawn-untrusted-server"},
 {name:"mcp.disconnect",schema:object({name:text()},["name"]),source:"src/mcp-servers/runtime.ts:disconnectServer",effect:true},
 {name:"mcp.trust-list",schema:object(),source:"src/mcp-servers/approval-render.ts:runMcpTrustCommand"},
 ...["fqn","all"].map(action=>({name:`mcp.trust-revoke-${action}`,schema:object({fqn:text()},action==="fqn"?["fqn"]:[]),source:"src/mcp-servers/approval-render.ts:runMcpTrustCommand",effect:true})),
 {name:"connect",schema:object(),source:"src/commands/providers.ts:classifyProviderConnection"},
 ...["test","select"].map(action=>({name:`connect.${action}`,schema:object({id:text()},["id"]),source:"src/commands/providers.ts;src/tui/tui-shell.ts:selectProviderModelInTui",effect:true})),
 ...["disconnect","add-key","device-login"].map(action=>({name:`connect.${action}`,schema:object(),source:"src/commands/providers.ts:disconnectProvider;src/lib/oauth",local:"global-provider-credentials-and-vendor-login-require-local-security-workflow"})),
 {name:"remote-control",schema:object(),source:"src/tui/remote-control-surface.ts:parseRemoteControlArgs"},
 {name:"remote-control.name",schema:object({name:text()}),source:"src/tui/remote-control-surface.ts:parseRemoteControlArgs",effect:true},
 {name:"remote-control.off",schema:object(),source:"src/tui/remote-control-surface.ts:parseRemoteControlArgs",effect:true},
 {name:"remote-policy",schema:object(),source:"src/commands/remote-policy-command.ts:loadPosture"},
 ...["mode-ask","mode-trust","limit-none","limit-minutes","wait-minutes"].map(action=>({name:`remote-policy.${action}`,schema:object({minutes:integer(10080)}),source:"src/commands/remote-policy-command.ts:remotePolicyText/updateRemotePolicy",local:"saved-machine-telegram-defaults-are-not-current-session-policy"})),
 {name:"bus",schema:object(),source:"src/bus/client.ts:peers"},
 ...["send","ask","reply","name","pause","resume","override"].map(action=>({name:`bus.${action}`,schema:object(action==="send"||action==="ask"?{to:text(),text:text(8000)}:action==="reply"?{id:text(),text:text(8000)}:action==="name"?{name:text()}:action==="pause"?{to:text(),scope:{type:"string",maxLength:20,enum:["turns","git-publish","advisory"]},ttlMinutes:integer(240),reason:text(2000)}:{leaseId:text()},action==="send"||action==="ask"?["to","text"]:action==="reply"?["id","text"]:action==="name"?["name"]:action==="pause"?["reason"]:[]),source:"src/tui/bus-command.ts:parseBusCommand;src/bus/client.ts",effect:true})),
];
const byName=new Map(variants.map(row=>[row.name,row]));
function failure(code:Extract<TasksIntegrationResult,{ok:false}>["error"]["code"],message:string):TasksIntegrationResult{return{ok:false,error:{code,message}};}
async function guard(context:TasksIntegrationContext,action:string){if(context.authorize===undefined||!context.execution?.runId||!context.execution.turnId||context.signal===undefined)throw new AuthorityError();context.signal?.throwIfAborted();await context.authorize(action);context.signal?.throwIfAborted();}
class AuthorityError extends Error{}
function safe(context:TasksIntegrationContext,data:unknown):TasksIntegrationResult{
 const encoded=JSON.stringify(data, (key,value:unknown)=>/^(env|environment|token|secret|password|authorization|cookie|credential|apiKey)$/i.test(key)?"[REDACTED]":value);
 if(encoded===undefined)return failure("read-failed","The domain returned no result.");
 const redacted=redactSensitiveText(encoded.replaceAll(context.cwd,"."));
 return Buffer.byteLength(redacted)>30000?failure("quota-exceeded","The result exceeds the remote command quota."):{ok:true,data:JSON.parse(redacted)};
}
/** Only actual current-session resources are capabilities. No PID or global approval-store fallback exists. */
export async function executeTasksIntegration(context:TasksIntegrationContext,name:string,input:unknown):Promise<TasksIntegrationResult>{
 const variant=byName.get(name);if(!variant||!validateArguments(variant.schema,input).ok)return failure("invalid-arguments","Arguments do not match this command.");
 if(variant.local)return failure("local-required",variant.local);
 const gap=capability(name,context.integrations);if(gap.availability==="implementation-gap"||gap.availability==="policy-denied")return failure(gap.availability,gap.message);
 // Selection is executed only by the host's session config transaction; this path never authorizes or applies one.
 if(name==="connect.select")return failure("domain-refused","Provider selection is applied only by the host's session config transaction.");
 const args=input as Record<string,string|number|undefined>; const port=context.integrations;
 try{
 if(ownedControls.includes(name)){if(context.authorizeOwnedControl===undefined)throw new AuthorityError();await context.authorizeOwnedControl(name as OwnedControlCommand,args);}
 else if(variant.effect)await guard(context,name);
 let data:unknown;
 if(name==="tasks")data=context.jobs.list().map(row=>({taskId:row.jobId,status:row.status,phase:row.phase,description:row.description??""}));
 else if(name==="tasks.output"||name==="tasks.kill"||name==="demote"){
 const taskId=String(args.taskId);if(!context.jobs.get(taskId))return failure("not-found","No current-session task has this exact taskId.");
 if(name==="tasks.output"){const result=context.jobs.readOutputSince(taskId,Number(args.cursor??0));if(!result.ok)return failure("domain-refused","The task output could not be read.");data=result;}
 else{const result=name==="demote"?demoteTask(context.jobs,taskId):await context.jobs.kill(taskId,"operator");if(!result.ok)return failure("domain-refused","The current task refused the requested state change.");data={...result,status:context.jobs.get(taskId)?.status,phase:context.jobs.get(taskId)?.phase};}
 }
 else if(name.startsWith("approvals")){
 const broker=context.approvals;if(!broker)return failure("setup-required","The current session approval broker is unavailable.");
 if(name==="approvals")data=broker.pending();
 else{const current=broker.pending().find(row=>row.approvalId===args.approvalId&&row.runId===args.runId&&row.turnId===args.turnId&&row.fingerprint===args.fingerprint&&row.policyDigest===args.policyDigest&&row.policyDigest===context.policyDigest);if(!current)return failure("not-found","No exact current-session approval is pending.");
 const result=await broker.answer({...current,decision:name==="approvals.allow-once"?"allow-once":"deny"});if(result.status!=="applied")return failure("domain-refused","The current live waiter refused this answer.");data=result;}
 }
 else if(name==="channels"){if(!port?.channels)return failure("setup-required","The locally configured channels reader is unavailable.");data=await loadChannelsSnapshot(port.channels);}
 else if(name==="intake"||name==="intake.list")data=await buildIntakeStatus(context.cwd,{env:{}});
 else if(name==="schedules")data=scheduledEntries(await loadTriggerLedgerView(context.cwd)).map(row=>({...row,installation:"not-inspected"}));
 else if(name==="autoreview"||name==="autoreview.ls")data=readAutoReviewRuns(context.cwd).map(({pid:_pid,...run})=>run);
 else if(name==="autoreview.arbiter")data=readAutoReviewArbiter(context.cwd,args.selector===undefined?undefined:String(args.selector));
 else if(name.startsWith("autoreview.")){
 const reviews=port!.autoreview!;
 if(name==="autoreview.stop")data=await reviews.stop(args.selector===undefined?undefined:String(args.selector),context.signal??AbortSignal.abort());
 else{if(Number(args.budgetMinutes)<1||Number(args.budgetTokens)<1)return failure("invalid-arguments","Finite positive review budgets are required.");const parsed=parseAutoReviewArgs(`/autoreview start ${args.ref} --budget-minutes ${args.budgetMinutes} --budget-tokens ${args.budgetTokens}`);if(parsed.kind!=="start")return failure("invalid-arguments","The review target or budgets are invalid.");data=await reviews.start(parsed,context.signal??AbortSignal.abort());}
 }
 else if(name==="mcp"||name==="mcp.trust-list"||name==="mcp.disconnect"||name.startsWith("mcp.trust-revoke")){
 if(!port?.mcp)return failure("setup-required","The current-session MCP owner is unavailable.");data=name==="mcp"?port.mcp.status():name==="mcp.disconnect"?await port.mcp.disconnectSession(String(args.name),context.signal??AbortSignal.abort()):runMcpTrustCommand(name==="mcp.trust-list"?{kind:"list"}:name==="mcp.trust-revoke-all"?{kind:"revoke-all"}:{kind:"revoke",target:String(args.fqn)},port.mcp.trusted);
 }
 else if(name==="connect"||name==="connect.test"){
 const providers=port!.providers!;data=name==="connect"?providers.list():await providers.test(String(args.id),context.signal??AbortSignal.abort());
 }
 else if(name.startsWith("remote-control")){
 if(!port?.remote)return failure("setup-required","The locally owned remote bridge is unavailable.");data=name==="remote-control"?port.remote.status():name==="remote-control.off"?await port.remote.stop(context.signal??AbortSignal.abort()):await port.remote.start(args.name===undefined?undefined:String(args.name),context.signal??AbortSignal.abort());
 }
 else if(name==="remote-policy"){if(!port?.remotePolicy)return failure("setup-required","A safe local saved-defaults reader is not yet bound; current session policy is not substituted.");data=port.remotePolicy();}
 else if(name==="bus"||name.startsWith("bus.")){
 const bus=port?.bus;if(!bus)return failure("setup-required","A locally configured current-session bus capability is unavailable.");
 if(name==="bus")data=bus.peers();else{const parsed=busInput(name,args);if(parsed.kind==="error"||parsed.kind==="modal")return failure("invalid-arguments","The bus action is invalid.");
 if(parsed.kind==="send"||parsed.kind==="ask")data=await bus.send(parsed.toLabel,parsed.kind==="ask"?"question":"notice",parsed.text);
 else if(parsed.kind==="reply")data=await bus.reply(parsed.id,parsed.text);
 else if(parsed.kind==="name"){await bus.rename(parsed.name);data={renamed:true};}
 else if(parsed.kind==="pause")data=await bus.pause(parsed.toLabel,parsed.scope,parsed.reason,parsed.ttlMs,"operator");
 else{const view=bus.leaseView();await view.refresh();const leaseId=parsed.leaseId??(parsed.kind==="resume"?view.myLeases()[0]?.leaseId:view.heldBy()?.leaseId);if(leaseId===undefined)return failure("not-found","No applicable current-session lease exists.");await guard(context,name);if(parsed.kind==="resume")await bus.resume(leaseId,"operator");else await bus.override(leaseId);data={leaseId,action:parsed.kind};}}
 }
 else return failure("setup-required","The local domain capability is unavailable.");
 context.signal?.throwIfAborted();return safe(context,data);
 }catch(error){return context.signal?.aborted?failure("cancelled","The current command was cancelled."):error instanceof AuthorityError?failure("policy-denied","Fresh current-controller authority is required."):error instanceof TasksIntegrationError?failure(error.code,error.message):variant.effect?failure("policy-denied","The fresh local authority or domain action refused this command."):failure("read-failed","The local domain could not be read.");}
}
function busInput(name:string,args:Record<string,string|number|undefined>):ParsedBusCommand{
 if((args.to!==undefined&&!/^@[^\s]+$/.test(String(args.to)))||(args.name!==undefined&&!/^[^\s]+$/.test(String(args.name)))||(args.id!==undefined&&/\s/.test(String(args.id)))||(args.leaseId!==undefined&&/\s/.test(String(args.leaseId))))return{kind:"error",reason:"Invalid bounded bus identifier"};
 const action=name.slice(4);const tail=action==="send"||action==="ask"?`${args.to} ${args.text}`:action==="reply"?`${args.id} ${args.text}`:action==="name"?String(args.name):action==="pause"?`${args.to??"@all"} --scope ${args.scope??"turns"}${args.ttlMinutes===undefined?"":` --ttl ${args.ttlMinutes}m`} ${args.reason}`:args.leaseId===undefined?"":String(args.leaseId);
 return parseBusCommand(`/bus ${action} ${tail}`);
}
/** connect.select is applied by the host config transaction, so its result is the manual model pick result (session-settings.ts) and its schema says so. */
export function tasksIntegrationsCommands(options:{port?:TasksIntegrationsPort;readiness?:Partial<Record<keyof TasksIntegrationsPort,boolean>>}={}):NativeCommandContribution[]{return variants.map(variant=>({
 entry:{commandName:variant.name,summary:variant.name,handlerId:`native.integrations.${variant.name}`,inputSchema:variant.schema,resultSchema:variant.name==="connect.select"?sessionConfigResultSchemas.model!:{type:"string",maxLength:32768},mutationClass:variant.local?"sensitive-setup":["tasks.kill","demote","approvals.allow-once","approvals.deny"].includes(variant.name)?"session":variant.effect?"workspace":"read",states:ownedControls.includes(variant.name)?["idle","busy","paused"]:variant.effect?["idle"]:["idle","busy","paused"],busyPolicy:variant.effect?"reject":"read-only",confirmation:variant.local?"local-only":ownedControls.includes(variant.name)?"none":variant.effect?"human":"none",availability:variant.local?"policy-denied":capability(variant.name,options.port,options.readiness).availability,reason:variant.local??capability(variant.name,options.port,options.readiness).reason},
 execute:(context,request)=>executeTasksIntegration(adapt(context,options.port),variant.name,request.arguments),
}));}
function adapt(context:SessionCommandContext,port:TasksIntegrationsPort|undefined):TasksIntegrationContext{
 const extended=context as SessionCommandContext & {integrations?:TasksIntegrationsPort;approvals?:TasksApprovalPort;authorizeIntegration?:(action:string)=>Promise<void>;authorizeOwnedControl?:TasksIntegrationContext["authorizeOwnedControl"]};
 return{cwd:context.cwd,jobs:context.runtime.jobs,sessionId:context.record.sessionId,policyDigest:context.record.config.policyDigest,actorId:context.record.controller?.actorId??"",...(extended.approvals?{approvals:extended.approvals}:{}),...(port??extended.integrations?{integrations:port??extended.integrations}:{}),...(context.effect?{signal:context.effect.signal,execution:{runId:context.effect.runId,turnId:context.effect.turnId}}:{}),...(extended.authorizeOwnedControl?{authorizeOwnedControl:extended.authorizeOwnedControl}:{}),authorize:extended.authorizeIntegration??(context.effect?async action=>context.effect!.beforeAction({kind:"tool",toolName:action,signal:context.effect!.signal}):undefined)};
}

interface Capability{availability:"available"|"setup-required"|"implementation-gap"|"policy-denied";reason:string;message:string}
const bound:Capability={availability:"available",reason:"shared-native-domain-owner",message:"available"};
/** A missing opt-in owner is local setup; a missing implementation is an implementation gap, never "setup". */
function capability(name:string,port:TasksIntegrationsPort|undefined,ready:Partial<Record<keyof TasksIntegrationsPort,boolean>>={}):Capability{
 const setup=(present:boolean):Capability=>present?bound:{availability:"setup-required",reason:"missing-local-session-capability",message:"missing-local-session-capability"};
 const gap=(present:boolean,reason:string,message:string):Capability=>present?bound:{availability:"implementation-gap",reason,message};
 if(name==="channels")return setup(port?.channels!==undefined||ready.channels===true);if(name.startsWith("bus"))return setup(port?.bus!==undefined||ready.bus===true);if(name.startsWith("mcp"))return setup(port?.mcp!==undefined||ready.mcp===true);
 // Selection is the host's idle-boundary session config transaction (sessionConfigProposal), available wherever the provider driver lists candidates.
 if(name==="connect.select")return port?.providers!==undefined||ready.providers===true?{availability:"available",reason:"exact-session-config-transaction",message:"available"}:{availability:"implementation-gap",reason:"native-serialized-provider-selection-not-attached",message:"No native provider driver lists candidates for this session; nothing was selected."};
 if(name.startsWith("connect"))return gap(port?.providers!==undefined||ready.providers===true,"native-provider-driver-not-attached","No native provider driver is attached to this session.");
 // specification.md 3.1: "Security-local setup and unimplemented vendor adapters are explicit capability boundaries." Telegram inbound
 // control needs an authenticated delegated principal that current Hub-human command authority cannot provide (owner decision 2026-10-28).
 if(name.startsWith("remote-control"))return{availability:"policy-denied",reason:"telegram-delegated-principal-adapter-unsupported",message:"Telegram remote control needs a delegated-principal adapter that is not supported; nothing was started or read."};if(name==="remote-policy")return setup(port?.remotePolicy!==undefined||ready.remotePolicy===true);
 if(name==="autoreview.start"||name==="autoreview.stop")return gap(port?.autoreview!==undefined||ready.autoreview===true,"owned-review-execution-adapter-not-implemented","No locally supervised review execution owner is implemented for native sessions; legacy lock-file PID control is forbidden.");
 return bound;}
