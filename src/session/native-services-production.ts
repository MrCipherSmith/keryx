import { realpathSync } from "node:fs";
import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";
import type { SearchProviderController } from "../harness/search";
import type { Control } from "../remote-control/protocol";
import type { PermissionMode } from "../commands/permission-mode";
import { loadSettingsSnapshot } from "../tui/settings-state";
import { loadPermissionsView } from "../commands/permissions-command";
import { loadPosture } from "../commands/remote-policy-command";
import { fetchOpenAiCompatModelsDetailed, type OpenAiCompatProvider } from "../commands/providers";
import { ChannelsClient } from "../remote/channels-client";
import type { SessionRestriction } from "./commands/plan";
import type { SettingsInspectionPort } from "./commands/settings-inspection";
import { TasksIntegrationError, type TasksIntegrationsPort } from "./commands/tasks-integrations";
import type { ServerState } from "../mcp-servers/manager";
import { catalogForServer, mergeCatalogs, resolveFqn, type ServerCatalog } from "../mcp-servers/catalog";
import { connectHttpMcpServer, type McpToolDescriptor } from "../mcp-client/client";
import { createMcpInteractiveTools } from "../mcp-servers/tools";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { redactSensitiveText } from "../security/service";
import { joinBus, type BusClient, type BusPeer } from "../bus/client";
import { sendMessage } from "../bus/send";
import { createPauseLease } from "../bus/pause";
import type { PauseLease } from "../bus/schema";
import path from "node:path";
import { keryxSelfCommand } from "../harness/tool/builtin/metaproject-tools";
import { parseAutonomousTarget } from "../review/autonomous-profile";
import { autonomousRunDir } from "../review/autonomous-run";
import type { JobOwner } from "../harness/tool/builtin/background-job-registry";
import type { AutoReviewCommand } from "../tui/autoreview-surface";

export interface NativeServiceIdentity { nativeSessionId:string;projectId:string;checkoutId:string }
export interface NativeProviderServices {
  /** Already resolved by the local owner, including its local consent and credential source. Never remote configuration. */
  bindings:readonly {candidateId:string;provider:OpenAiCompatProvider}[];
  /** Locally allowed candidates the driver cannot probe: missing local configuration, or no shared driver implementation. */
  unavailable?:readonly {candidateId:string;label:string;state:"not-configured"|"implementation-gap"}[];
  fetch:typeof fetch;
  /** Local consent/egress check, run before the single bounded request of each probe. */
  beforeRequest(candidateId:string,signal:AbortSignal):Promise<void>;
  /** The existing host serialized exact configuration transaction; never a direct runtime switch. Absent, selection is an implementation gap. */
  selectConfirmed?(candidateId:string,signal:AbortSignal):Promise<unknown>;
}
export interface NativeSessionServicesOptions {
  cwd:string;configDir:string;jobs:JobRegistry;
  identity():NativeServiceIdentity;
  sessionState():{config:Control["SessionConfig"];restriction:SessionRestriction;permissionMode:PermissionMode;status:Control["SessionRecord"]["state"]};
  routingAvailability():Pick<Control["RoutingAvailability"],"candidates">;
  searchController?:SearchProviderController;
  providers?:NativeProviderServices;
  mcp?:{nativeSessionId:string;servers:Map<string,ServerState>;trusted:Map<string,string>;catalog():ServerCatalog};
  bus?:{nativeSessionId:string;client:BusClient;allowedCheckoutPaths:readonly string[];allowedPeerSessionIds:readonly string[];
    /** Exact current-run owned child instances only, independently of broader communication membership. */
    allowedControlInstanceIds?:()=>readonly string[]};
  /** Local constructor input only: the keryx CLI argv prefix the supervised review runs (default: this keryx). Never remote data. */
  reviewCommand?:readonly string[];
}
type ReviewOwner=NonNullable<TasksIntegrationsPort["autoreview"]>;
/** `keryx review run --autonomous` as a supervised task in this session's own job registry: owned execution, its budgets, and a stop
 * that ends only a review this session started. Never the legacy lock-file PID stop. */
export function createNativeAutoReviewOwner(options:{cwd:string;jobs:JobRegistry;owner:JobOwner;command:readonly string[];active():void}):ReviewOwner{
  const started=new Map<string,{jobId:string;label:string;ref:string;deadline:ReturnType<typeof setTimeout>}>();
  const quote=(arg:string)=>`'${arg.replaceAll("'","'\\''")}'`;
  const running=()=>[...started.entries()].filter(([,run])=>options.jobs.get(run.jobId)?.status==="running");
  return{
    async start(command:Extract<AutoReviewCommand,{kind:"start"}>,signal:AbortSignal){
      signal.throwIfAborted();options.active();
      if(command.budgetMinutes===undefined||command.budgetTokens===undefined)throw new TasksIntegrationError("policy-denied","A supervised native review needs explicit minute and token budgets.");
      const target=parseAutonomousTarget(command.ref);const reviewId=path.basename(autonomousRunDir(options.cwd,target));
      if(running().some(([id])=>id===reviewId))throw new TasksIntegrationError("policy-denied","This review is already running in this session; stop it first.");
      const argv=[...options.command,"review","run","--autonomous","--target","pr","--ref",command.ref,"--budget-minutes",String(command.budgetMinutes),"--budget-tokens",String(command.budgetTokens)];
      const result=await options.jobs.start(argv.map(quote).join(" "),{owner:options.owner,description:`autonomous review ${target.repository}#${target.number}`});
      if(!result.ok)throw new TasksIntegrationError("policy-denied","The supervised review task could not start; nothing is running.");
      signal.throwIfAborted();
      // The review enforces its own budgets; the owner also bounds the process lifetime to the minute budget plus a short grace.
      const deadline=setTimeout(()=>{void options.jobs.kill(result.jobId,"operator");},(command.budgetMinutes*60+30)*1000);deadline.unref();
      started.set(reviewId,{jobId:result.jobId,label:`${target.repository}#${target.number}`,ref:target.ref,deadline});
      return{reviewId,taskId:result.jobId,status:options.jobs.get(result.jobId)?.status??"unknown"};
    },
    async stop(selector:string|undefined,signal:AbortSignal){
      signal.throwIfAborted();options.active();
      const live=running();const bare=selector?.replace(/^#/,"");
      const chosen=selector===undefined?(live.length===1?live[0]:undefined):live.find(([id,run])=>id===selector||run.ref===selector||run.label===selector||run.label.endsWith(`#${bare}`));
      if(chosen===undefined)throw new TasksIntegrationError("not-found","No review started by this session matches; nothing was stopped.");
      const [reviewId,run]=chosen;clearTimeout(run.deadline);
      const killed=await options.jobs.kill(run.jobId,"operator");
      if(!killed.ok)throw new TasksIntegrationError("policy-denied","The supervised review task refused the stop.");
      return{reviewId,taskId:run.jobId,status:options.jobs.get(run.jobId)?.status??"unknown"};
    },
  };
}
export interface NativeLocallyApprovedServices {
  httpMcp?:readonly {name:string;url:string;headers?:Readonly<Record<string,string>>}[];
  bus?:Omit<NonNullable<NativeSessionServicesOptions["bus"]>,"nativeSessionId"|"client">;
  /** Local SessionCreate grant/profile authority, consent, endpoint allowlist and budgets; never a decoded Hub callback. */
  beforeConnect(request:{kind:"mcp-http";name:string;url:string}|{kind:"bus";projectId:string;checkoutId:string},signal:AbortSignal):Promise<void>;
}
async function stopMcpConnection(row:ServerState):Promise<boolean>{
  if(!row.connection)return row.status!=="connecting";
  if(row.connection.isClosed?.()===true)return true;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([row.connection.close().then(()=>true,()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);}finally{if(timer!==undefined)clearTimeout(timer);}
}
export class NativeServicesSetupError extends Error {
  constructor(readonly cleanupStopped:boolean,readonly retryClose:()=>Promise<{stopped:boolean}>){super("native-services-setup-refused");}
}
/** Explicit opt-in setup: no global MCP discovery, standing trust import, credential entry or stdio launch. */
export async function configureNativeSessionServices(options:NativeSessionServicesOptions&{locallyApproved:NativeLocallyApprovedServices},signal:AbortSignal) {
  signal.throwIfAborted();const setup=options.locallyApproved,owner={...options.identity()};
  if(typeof setup.beforeConnect!=="function"||(options.mcp&&setup.httpMcp)||(options.bus&&setup.bus))throw new Error("native-services-setup-conflict");
  const servers=new Map<string,ServerState>(),descriptors=new Map<string,McpToolDescriptor[]>();let bus:BusClient|undefined;
  const sameOwner=()=>{signal.throwIfAborted();const current=options.identity();if(JSON.stringify(current)!==JSON.stringify(owner))throw new Error("native-service-owner-mismatch");};
  try{
    for(const entry of setup.httpMcp??[]){
      sameOwner();if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(entry.name)||servers.has(entry.name))throw new Error("invalid-local-mcp-name");const target=new URL(entry.url);if(!["http:","https:"].includes(target.protocol)||target.username||target.password||target.hash)throw new Error("invalid-local-mcp-endpoint");
      await setup.beforeConnect({kind:"mcp-http",name:entry.name,url:target.href},signal);sameOwner();
      const connection=await connectHttpMcpServer(target.href,{...(entry.headers===undefined?{}:{headers:{...entry.headers}}),handshakeTimeoutMs:5000,signal});
      servers.set(entry.name,{name:entry.name,status:"connecting",toolCount:0,connection});
      const cancel=()=>{void connection.close().catch(()=>{});};signal.addEventListener("abort",cancel,{once:true});
      try{sameOwner();const tools=await connection.listTools({timeoutMs:5000});sameOwner();descriptors.set(entry.name,tools);servers.set(entry.name,{name:entry.name,status:"connected",toolCount:tools.length,connection});}finally{signal.removeEventListener("abort",cancel);}
    }
    if(setup.bus){sameOwner();await setup.beforeConnect({kind:"bus",projectId:owner.projectId,checkoutId:owner.checkoutId},signal);sameOwner();const joined=await joinBus({cwd:options.cwd,sessionId:owner.nativeSessionId,surface:"headless",env:{},status:()=>{const state=options.sessionState().status;return{status:state==="busy"?"working":state==="idle"?"idle":"blocked",activity:`native session: ${state}`};},onEvent:()=>{},onPeers:()=>{}});if("disabled" in joined)throw new Error("native-bus-unavailable");bus=joined;sameOwner();}
    return createNativeSessionServices({...options,...(setup.httpMcp===undefined?{}:{mcp:{nativeSessionId:owner.nativeSessionId,servers,trusted:new Map<string,string>(),catalog:()=>mergeCatalogs([...descriptors].filter(([name])=>servers.has(name)).map(([name,tools])=>catalogForServer(name,tools)))}}),...(bus===undefined?{}:{bus:{...setup.bus!,nativeSessionId:owner.nativeSessionId,client:bus}})});
  }catch{
    const close=async()=>{let stopped=true;try{bus?.leave();}catch{stopped=false;}const results=await Promise.all([...servers.values()].map(stopMcpConnection));return{stopped:stopped&&results.every(Boolean)};};
    const result=await close();throw new NativeServicesSetupError(result.stopped,close);
  }
}
/** Local service composition. The session owner supplies its existing jobs and state; no registry or approval broker is created here. */
export function createNativeSessionServices(options:NativeSessionServicesOptions) {
  const root=realpathSync(options.cwd),owner={...options.identity()};let closed=false;
  if(!owner.nativeSessionId||!owner.projectId||!owner.checkoutId)throw new Error("native-service-identity-required");
  const active=()=>{const current=options.identity();if(closed||realpathSync(options.cwd)!==root||current.nativeSessionId!==owner.nativeSessionId||current.projectId!==owner.projectId||current.checkoutId!==owner.checkoutId)throw new Error("native-service-owner-mismatch");};
  const settings:SettingsInspectionPort={snapshot:async()=>{active();const state=options.sessionState();return loadSettingsSnapshot(root,{permissionMode:state.permissionMode,plan:state.restriction.enabled,routing:state.config.routing.enabled,reasoningOverride:state.config.reasoningEffort},options.configDir);},permissions:()=>{active();return loadPermissionsView({dir:options.configDir});},...(options.searchController===undefined?{}:{search:options.searchController})};
  const channels=new ChannelsClient({dir:options.configDir});
  const integrations:TasksIntegrationsPort={channels:{status:async()=>{active();return channels.status();},localFiles:()=>{active();return channels.localFiles();}},remotePolicy:()=>{active();return loadPosture({dir:options.configDir})??{state:"not-configured"};},
    autoreview:createNativeAutoReviewOwner({cwd:root,jobs:options.jobs,owner:{kind:"session",identity:owner.nativeSessionId},command:options.reviewCommand??keryxSelfCommand(),active})};
  let interactiveTools:InteractiveTool[]=[];
  const stopConnection=stopMcpConnection;
  if(options.mcp){
    const source=options.mcp;if(source.nativeSessionId!==owner.nativeSessionId)throw new Error("foreign-mcp-owner");
    const servers=()=>{active();return [...source.servers.values()];};
    integrations.mcp={trusted:source.trusted,status:()=>servers().map(row=>({name:row.name,status:row.status,toolCount:row.toolCount})),disconnectSession:async(name,signal)=>{active();signal.throwIfAborted();const row=source.servers.get(name);if(!row)throw new Error("mcp-not-owned");const stopped=await stopConnection(row);if(stopped&&source.servers.get(name)===row)source.servers.delete(name);return{stopped,name};}};
    interactiveTools=createMcpInteractiveTools({servers,catalog:()=>{active();const catalog=source.catalog();return{...catalog,entries:catalog.entries.filter(entry=>source.servers.get(entry.server)?.status==="connected")};},redact:redactSensitiveText});
    interactiveTools=interactiveTools.map(tool=>tool.definition.name!=="use_tool"?tool:{...tool,invoke:async(input,context)=>{
      active();const signal=context?.signal;if(signal===undefined||signal.aborted)return{output:"A live admitted native tool scope is required.",isError:true};
      const entry=resolveFqn(source.catalog(),typeof input.tool_name==="string"?input.tool_name:"");const row=entry===undefined?undefined:source.servers.get(entry.server);
      const cancelled=async()=>{if(row){const stopped=await stopConnection(row);if(stopped&&source.servers.get(row.name)===row)source.servers.delete(row.name);}};
      let stop:Promise<void>|undefined;const onAbort=()=>{stop=cancelled();};signal.addEventListener("abort",onAbort,{once:true});
      try{const result=await tool.invoke(input,context);if(signal.aborted){await stop;return{output:"The owned MCP call was cancelled; any external effects require reconciliation.",isError:true};}active();return result;}finally{signal.removeEventListener("abort",onAbort);}
    }});
  }
  if(options.bus){
    const source=options.bus,client=source.client;if(source.nativeSessionId!==owner.nativeSessionId)throw new Error("foreign-bus-owner");
    const checkouts=new Set(source.allowedCheckoutPaths.map(checkout=>realpathSync(checkout))),sessions=new Set(source.allowedPeerSessionIds);
    if(!checkouts.has(root))throw new Error("bus-checkout-not-registered");
    const peerAllowed=(peer:BusPeer)=>{try{return sessions.has(peer.record.sessionId)&&checkouts.has(realpathSync(peer.record.checkout));}catch{return false;}};
    const peers=()=>{active();return client.peers().filter(peerAllowed);};
    const recipient=(label:string)=>{const matches=peers().filter(peer=>peer.record.name===label.slice(1)&&peer.state==="live");if(!label.startsWith("@")||label==="@all"||matches.length!==1)throw new Error("bus-peer-not-registered");return matches[0]!;};
    const sender=()=>({instanceId:client.instanceId,name:client.name,origin:"operator" as const});
    const ownedLeases=new Set<string>();
    const controlIds=()=>new Set(source.allowedControlInstanceIds?.()??[]);
    const leaseAllowed=(lease:PauseLease|undefined):lease is PauseLease=>{if(!lease||!ownedLeases.has(lease.leaseId)||lease.holder.instanceId!==client.instanceId)return false;const ids=controlIds();return lease.targets.length>0&&lease.targets.every(id=>id!=="*"&&ids.has(id));};
    const view=client.leaseView();
    const scopedView:ReturnType<BusClient["leaseView"]>={refresh:async()=>{active();await view.refresh();},myLeases:()=>{active();return view.myLeases().filter(leaseAllowed);},heldBy:()=>{active();const lease=view.heldBy();return leaseAllowed(lease)?lease:undefined;},appliesToMeLease:scope=>{active();const lease=view.appliesToMeLease(scope);return leaseAllowed(lease)?lease:undefined;},appliesToMe:scope=>scopedView.appliesToMeLease(scope)!==undefined,held:()=>scopedView.heldBy()!==undefined,banner:()=>scopedView.held()?view.banner():undefined,override:async id=>{active();if(!leaseAllowed(view.heldBy())||view.heldBy()?.leaseId!==id)throw new Error("bus-lease-not-owned");await client.override(id);}};
    integrations.bus={peers,send:async(label,kind,body,replyTo)=>{const peer=recipient(label);return sendMessage(client.root,{toLabel:label,toInstanceId:peer.record.instanceId,kind,body,origin:"operator",from:sender(),...(replyTo===undefined?{}:{replyTo}),env:{}});},reply:async(ref,body)=>{active();const message=client.resolveRef(ref);if(!message||!peers().some(peer=>peer.record.instanceId===message.fromInstanceId))throw new Error("bus-message-not-owned");return sendMessage(client.root,{toLabel:`@${message.fromName}`,toInstanceId:message.fromInstanceId,kind:"reply",body,replyTo:message.id,origin:"operator",from:sender(),env:{}});},rename:async name=>{active();await client.rename(name);},pause:async(label,scope,reason,ttlMs,origin)=>{const peer=recipient(label);const ids=controlIds();if(!ids.has(peer.record.instanceId))throw new Error("bus-control-not-owned");const lease=await createPauseLease(client.root,{holder:{...sender(),origin},toLabel:label,scope,reason,...(ttlMs===undefined?{}:{ttlMs}),allowedTargetInstanceIds:[peer.record.instanceId]});ownedLeases.add(lease.leaseId);await view.refresh();return lease;},resume:async(id,origin)=>{active();await view.refresh();const lease=view.myLeases().find(lease=>lease.leaseId===id);if(!leaseAllowed(lease))throw new Error("bus-lease-not-owned");await client.resume(id,origin);ownedLeases.delete(id);},override:scopedView.override,leaseView:()=>{active();return scopedView;}};
  }
  {
    // Every native session owns a provider driver; with no locally allowed candidates it truthfully lists none and probes nothing.
    const source:NativeProviderServices=options.providers??{bindings:[],unavailable:[],fetch:globalThis.fetch,beforeRequest:async()=>{throw new TasksIntegrationError("not-found","No locally allowed provider candidate has this id.");}};const bindings=new Map(source.bindings.map(binding=>[binding.candidateId,binding])),unavailable=new Map((source.unavailable??[]).map(row=>[row.candidateId,row]));
    if(bindings.size!==source.bindings.length||unavailable.size!==(source.unavailable??[]).length||[...unavailable.keys()].some(id=>bindings.has(id)))throw new Error("duplicate-provider-binding");
    const binding=(id:string)=>{active();const found=bindings.get(id);if(found)return found;const gap=unavailable.get(id);
      if(gap?.state==="not-configured")throw new TasksIntegrationError("setup-required","This locally allowed provider has no local credential or configuration; nothing was sent.");
      if(gap?.state==="implementation-gap")throw new TasksIntegrationError("implementation-gap","No shared native models probe exists for this provider yet; nothing was sent.");
      throw new TasksIntegrationError("not-found","No locally allowed provider candidate has this id.");};
    const selected=(id:string)=>options.sessionState().config.baselineCandidateId===id;
    integrations.providers={list:()=>{active();return [...source.bindings.map(row=>({candidateId:row.candidateId,label:row.provider.label,state:"configured",selected:selected(row.candidateId)})),...(source.unavailable??[]).map(row=>({candidateId:row.candidateId,label:row.label,state:row.state,selected:selected(row.candidateId)}))];},test:async(id,signal)=>{
      signal.throwIfAborted();const row=binding(id);await source.beforeRequest(id,signal);signal.throwIfAborted();active();
      const expected=`${row.provider.baseUrl.replace(/\/+$/,"")}${row.provider.modelsPath??"/v1/models"}`;let requests=0;
      // One bounded request to the exact checked endpoint: no redirect, no second attempt, no error body forwarded.
      const transport=(async(...args:Parameters<typeof fetch>)=>{active();signal.throwIfAborted();const [url,init]=args;if(String(url)!==expected||++requests>1)throw new Error("provider-endpoint-mismatch");const response=await source.fetch(url,{...init,redirect:"error",signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});if(!response.ok){await response.body?.cancel();return new Response(null,{status:response.status});}return response;}) as typeof fetch;
      const result=await fetchOpenAiCompatModelsDetailed(transport,row.provider,row.provider.apiKey,{timeoutMs:10000});signal.throwIfAborted();active();
      return {source:result.source,modelCount:result.models.length,...(result.failure===undefined?{}:{failure:{kind:result.failure.kind}})};
    },...(source.selectConfirmed===undefined?{}:{select:async(id:string,signal:AbortSignal)=>{binding(id);signal.throwIfAborted();return source.selectConfirmed!(id,signal);}})};
  }
  const readyDrivers={settings:true,channels:true,remotePolicy:true,autoreview:true,providers:integrations.providers!==undefined,mcp:integrations.mcp!==undefined,bus:integrations.bus!==undefined};
  return {integrations,settings,interactiveTools,readyDrivers,async close():Promise<{stopped:boolean}>{closed=true;let busStopped=true;try{options.bus?.client.leave();}catch{busStopped=false;}const results=await Promise.all([...options.mcp?.servers.values()??[]].map(stopConnection));return{stopped:busStopped&&results.every(Boolean)};}};
}
