import { AsyncLocalStorage } from "node:async_hooks";
import type { JobOwner } from "../harness/tool/builtin/background-job-registry";
import { createNativeSessionServices, NativeServicesSetupError, type NativeSessionServicesOptions } from "./native-services-production";
import { settingsInspectionCommands } from "./commands/settings-inspection";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { ShadowGitRequest } from "../rewind/shadow";
import type { BackgroundProcessHandle } from "../harness/tool/builtin/background-job-registry";
import { randomUUID } from "node:crypto";
import { buildAgentSystemInstruction, runAgentTurn, toolCallHash, type AgentDeps, type AgentIO, type RunAgentTurnOptions, type RunAgentTurnResult } from "../commands/agent";
import type { NativeClassifierContext, NativeRoutingClassifier } from "./native-classifier";
import { applyRuntimeSwitchToSlate } from "./runtime-switch";
import { runGoalCommand } from "../commands/goal-command";
import { goalCommands } from "./commands/goal";
import { redactSensitiveText } from "../security/service";
import { buildInteractiveAgentTools, interactiveAgentToolNames } from "../commands/interactive-agent-tools";
import { createDefaultSearchProviderController } from "../harness/search";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import { createJobRegistry, type BackgroundSpawner, type KillReason } from "../harness/tool/builtin/background-job-registry";
import type { PolicyProfile } from "../harness/policy/types";
import { createSpawnSubagentTool } from "../harness/tool/builtin/spawn-subagent-tool";
import { ASK_USER_NO_HOST, type AskUserFn } from "../harness/tool/builtin/ask-user-tool";
import type { NormalizedMessage, ProviderPort } from "../harness/provider/types";
import { canonicalDigest, type Control } from "../remote-control/protocol";
import { createSessionRouting } from "./routing";
import type { SessionWorkspacePort } from "./host-types";
import { closeSlateSession, detachSlateSession, type SlateSessionRef } from "./slate-lifecycle";
import type { NativeCommandContribution } from "./commands/handlers";
import { analysisCommands, type NativeAnalysisPort, type NativeAnalysisReadPort } from "./commands/analysis";
import type { SessionProjectReadPort } from "./commands/effects";
import { canonicalProjectTools } from "./commands/project-tools";
import { createAnalysisReadPorts } from "./commands/analysis-read-ports";
import { createOwnedReadCapture } from "./native-owned-read";
import { tasksIntegrationsCommands, type TasksIntegrationsPort } from "./commands/tasks-integrations";
import { isNormalizedWireIdentity, wireCandidateId, wireModelIdentity, type NativeModelBinding } from "./model-identity";

export type NativeSessionServices = ReturnType<typeof createNativeSessionServices>;
export type NativeServicesFactoryContext = Pick<NativeSessionServicesOptions, "cwd" | "configDir" | "jobs" | "identity" | "sessionState" | "routingAvailability" | "searchController">;
export interface NativeRuntimeTurnResult { outcome: "succeeded" | "failed" | "cancelled" | "unknown"; reason: string; result: RunAgentTurnResult }
/** Bound on one kill wait: just above the registry's SIGTERM-to-SIGKILL grace, so a stuck kill can never hang `stop()`. */
/** The SIGTERM to SIGKILL grace for an owned native process group (specification: TERM, then KILL after five seconds). */
export const NATIVE_KILL_GRACE_MS = 5_000;
const STOP_KILL_BOUND_MS = NATIVE_KILL_GRACE_MS + 500;
/** How long a process group that was just killed may keep exiting before its absence is reported unproven. */
const STOP_ABSENCE_PROOF_MS = 1000;
const processGroupAlive = (pid: number): boolean => { try { process.kill(-pid, 0); return true; } catch (cause) { return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH"); } };

export interface NativeRuntimeOptions {
  cwd: string;
  configDir?: string;
  servicesFactory?: (context: NativeServicesFactoryContext) => NativeSessionServices | Promise<NativeSessionServices>;
  provider: ProviderPort;
  providerId: string;
  modelId: string;
  approve?: AgentIO["requestApproval"];
  askUser?: AskUserFn;
  /** Local-only resolver. Remote model IDs never become executable paths or credentials. */
  resolveProvider?: (providerId: string, modelId: string) => ProviderPort;
  availability?: Control["RoutingAvailability"];
  nativeClassifier?: NativeRoutingClassifier;
  classify?: Parameters<typeof createSessionRouting>[0]["classify"];
  deps?: Pick<AgentDeps, "hardDeny" | "hooks" | "maxRounds" | "maxToolCalls" | "maxOutputTokens">;
  allowSubagents?: boolean;
  policy?: PolicyProfile;
  allowedTools?: readonly string[];
  spawner?: BackgroundSpawner;
  spawnOwnedGit?: (request: ShadowGitRequest) => BackgroundProcessHandle | Promise<BackgroundProcessHandle>;
  /** Local application composition only; never decoded from remote command data. */
  commandContributions?: readonly NativeCommandContribution[];
  analysis?: Omit<NativeAnalysisPort, "readDiff">;
  integrations?: TasksIntegrationsPort;
  modelBindings?: readonly Pick<NativeModelBinding, "actualProviderId" | "actualModelId">[];
}
/**
 * One owned process spawn, in order: `intent` before the process may exist, then `started` with its
 * pid, or `failed` when the spawn provably created none. A listener that throws on `intent` refuses the spawn.
 */
export interface NativeOwnedProcessEvent { phase: "intent" | "started" | "failed"; intentId: string; pid?: number }
export function createNativeSessionRuntime(options: NativeRuntimeOptions) {
  const jobOwners = new AsyncLocalStorage<JobOwner>();
  const uncertainStops = new Map<string, { pid: number; owner: JobOwner | undefined }>();
  let nativeSessionIdentity: string | undefined;
  const ownedReads = createOwnedReadCapture();
  const processListeners = new Set<(event: NativeOwnedProcessEvent) => void>();
  const spawnIntent = new AsyncLocalStorage<{ id: string; started: boolean }>();
  // After `intent`, a listener failure must not break the registry's own tracking of a live process: the durable intent stays and fences recovery.
  const emitAfterIntent = (event: NativeOwnedProcessEvent) => { for (const listener of processListeners) { try { listener(event); } catch { /* The retained intent keeps this spawn uncertain. */ } } };
  // Owned process groups get TERM, then KILL after five seconds (specification: cancellation).
  const jobs = createJobRegistry({ cwd: options.cwd, owner: () => jobOwners.getStore(), killGraceMs: NATIVE_KILL_GRACE_MS, onEvent: (event) => {
    ownedReads.onEvent(event);
    const intent = event.type === "start" ? spawnIntent.getStore() : undefined;
    if (event.type === "start" && intent !== undefined && !intent.started) { intent.started = true; emitAfterIntent({ phase: "started", intentId: intent.id, pid: event.pid }); }
  }, ...(options.spawner === undefined ? {} : { spawn: options.spawner }) });
  const registryStart = jobs.start.bind(jobs);
  jobs.start = async (...args: Parameters<typeof registryStart>) => {
    if (processListeners.size === 0) return registryStart(...args);
    const intent = { id: randomUUID(), started: false };
    for (const listener of processListeners) listener({ phase: "intent", intentId: intent.id });
    return spawnIntent.run(intent, async () => { try { return await registryStart(...args); } finally { if (!intent.started) emitAfterIntent({ phase: "failed", intentId: intent.id }); } });
  };
  const readPorts = createAnalysisReadPorts({ cwd: options.cwd, runOwned: (argv, signal) => {
    const quoted = argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
    return ownedReads.run(jobs, `GH_PAGER=cat GH_PROMPT_DISABLED=1 ${quoted}`, signal);
  } });
  let services: NativeSessionServices | undefined;
  let retryServicesClose: (() => Promise<{ stopped: boolean }>) | undefined;
  /** Wrapped tools contributed by the attached services; a closed service's tools are no longer offered. */
  let serviceTools: InteractiveTool[] = [];
  const detachServiceTools = () => { for (const tool of serviceTools) { const index = tools.indexOf(tool); if (index >= 0) tools.splice(index, 1); } serviceTools = []; };
  const searchController = createDefaultSearchProviderController(options.configDir);
  const integrationPort = () => services === undefined ? options.integrations : { ...services.integrations, ...options.integrations };
  const approvedEffects = new Set<string>();
  let effectApprover = options.approve;
  let workspace: SessionWorkspacePort | undefined;
  let workspaceConflict = false;
  const approve: NonNullable<AgentIO["requestApproval"]> = async (name, input, meta) => {
    const answer = await effectApprover?.(name, input, meta) ?? false;
    if (answer === true || (typeof answer === "object" && answer.approved && (answer.fingerprint === undefined || answer.fingerprint === meta?.fingerprint))) {
      approvedEffects.add(toolCallHash(name, input));
    }
    return answer;
  };
  let sessionDir: string | undefined;
  let slateSession: SlateSessionRef | undefined;
  let projectContext: SessionProjectReadPort | undefined;
  let inspectionMode: "hub-remote" | "local-native" = "hub-remote";
  let onContextCompaction: AgentDeps["onContextCompaction"];
  let selected = { providerId: options.providerId, modelId: options.modelId };
  const bindings = new Map<string, NativeModelBinding>();
  const actualBindings = new Map<string, NativeModelBinding>();
  const bindingKey = (providerId: string, modelId: string) => JSON.stringify([providerId, modelId]);
  const bindModel = (actualProviderId: string, actualModelId: string) => {
    const binding = { ...wireModelIdentity(actualProviderId, actualModelId), actualProviderId, actualModelId };
    const key = bindingKey(binding.providerId, binding.modelId); const prior = bindings.get(key);
    if (prior !== undefined && (prior.actualProviderId !== actualProviderId || prior.actualModelId !== actualModelId)) throw new NativeRuntimeError("model-identity-conflict");
    bindings.set(key, binding); actualBindings.set(bindingKey(actualProviderId, actualModelId), binding); return binding;
  };
  bindModel(options.providerId, options.modelId);
  for (const binding of options.modelBindings ?? []) bindModel(binding.actualProviderId, binding.actualModelId);
  for (const candidate of options.availability?.candidates ?? []) if (!bindings.has(bindingKey(candidate.providerId, candidate.modelId))
    && !isNormalizedWireIdentity(candidate.providerId) && !isNormalizedWireIdentity(candidate.modelId)) bindModel(candidate.providerId, candidate.modelId);
  if (options.analysis !== undefined) bindModel("openrouter-systemone", options.analysis.model);
  const readAnalysisDiff = async (signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    const started = await jobs.start("git --no-pager diff --no-ext-diff --no-textconv --no-color -U3 --");
    if (!started.ok) throw new NativeRuntimeError("analysis-diff-unavailable");
    const abort = () => { void jobs.kill(started.jobId).catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) { await jobs.kill(started.jobId); signal.throwIfAborted(); }
      const exited = await jobs.waitForExit(started.jobId, 10_000);
      if (exited !== "exited") { await jobs.kill(started.jobId); throw new NativeRuntimeError("analysis-diff-timeout"); }
      signal.throwIfAborted();
      const task = jobs.get(started.jobId); const output = jobs.readOutputSince(started.jobId, 0);
      if (task?.status !== "completed" || task.exitCode !== 0 || !output.ok) throw new NativeRuntimeError("analysis-diff-unavailable");
      if (output.missed > 0 || Buffer.byteLength(output.output) > 512 * 1024) throw new NativeRuntimeError("analysis-diff-quota-exceeded");
      return output.output;
    } finally { signal.removeEventListener("abort", abort); }
  };
  const providerFor = (providerId: string, modelId: string) => {
    const binding = bindings.get(bindingKey(providerId, modelId)) ?? actualBindings.get(bindingKey(providerId, modelId));
    if (binding === undefined) throw new NativeRuntimeError("candidate-unavailable");
    if (binding.actualProviderId === options.providerId && binding.actualModelId === options.modelId) return options.provider;
    if (options.resolveProvider !== undefined) return options.resolveProvider(binding.actualProviderId, binding.actualModelId);
    throw new NativeRuntimeError("candidate-unavailable");
  };
  let sessionAskUser: AskUserFn | undefined;
  let liveAction: AgentIO["beforeAction"];
  let restrictionForVersion: (version: number) => boolean = () => false;
  const children = new Map<Promise<unknown>, JobOwner | undefined>();
  const spawn = createSpawnSubagentTool({ cwd: options.cwd, nativeOnly: true,
    childTools: (cwd) => {
      if (cwd !== options.cwd) throw new NativeRuntimeError("native-child-checkout-mismatch");
      return tools.filter((tool) => tool.definition.risk === "read" && (inspectionMode !== "hub-remote" || !tool.definition.name.startsWith("flow_")));
    },
    beforeAction: async (action) => { if (liveAction === undefined) throw new NativeRuntimeError("native-child-authority-required"); await liveAction(action); },
    onNativeTurn: (turn) => { children.set(turn, jobOwners.getStore()); void turn.then(() => children.delete(turn), () => children.delete(turn)); },
    configuredMaxToolCalls: options.deps?.maxToolCalls ?? 100,
    getParentModel: () => selected,
    makeProvider: providerFor, getDetectedProviders: () => [{ name: selected.providerId, models: [selected.modelId] }], getSlateSession: () => slateSession,
    ...(options.deps?.hooks === undefined ? {} : { hooks: options.deps.hooks.runtime }),
  });
  const wrapTool = (tool: InteractiveTool): InteractiveTool => ({ ...tool,
    workingDirectory: tool.workingDirectory ?? options.cwd,
    invoke: async (input: Record<string, unknown>, context?: Parameters<typeof tool.invoke>[1]) => {
      if (workspaceConflict) throw new NativeRuntimeError("workspace-conflict");
      if (["shell_job_kill", "shell_task_kill"].includes(tool.definition.name)) { const id = input.task_id ?? input.job_id; if (typeof id === "string" && jobs.get(id)?.visibility === "private") return { output: "private-native-operation", isError: true }; }
      if (options.policy !== undefined) {
        const risk = tool.definition.risk;
        if (risk === undefined) return { output: "local-policy-denied", isError: true };
        const defaults = options.policy.defaults;
        const outcome = risk === "read" ? defaults.read : risk === "write" || risk === "destructive" || risk === "credential" ? defaults.write : risk === "shell" ? defaults.shell : risk === "network" ? defaults.network : risk === "delegate" ? defaults.delegate : "deny";
        if (outcome === "deny") return { output: "local-policy-denied", isError: true };
        if (outcome === "ask") {
          const serialized = JSON.stringify(input); const fingerprint = toolCallHash(tool.definition.name, serialized);
          if (!approvedEffects.delete(fingerprint)) {
            const answer = await approve(tool.definition.name, serialized, { fingerprint, destructive: risk === "destructive", ...(context?.signal === undefined ? {} : { signal: context.signal }) });
            if (answer !== true && !(typeof answer === "object" && answer.approved && (answer.fingerprint === undefined || answer.fingerprint === fingerprint))) return { output: "local-policy-approval-denied", isError: true };
            approvedEffects.delete(fingerprint);
          }
        }
      }
      if (workspace?.beforeEffect === undefined && workspace?.afterEffect === undefined) return tool.invoke(input, context);
      if (workspace.beforeEffect === undefined || workspace.afterEffect === undefined) {
        workspaceConflict = true; throw new NativeRuntimeError("incomplete-workspace-provenance-port");
      }
      const begun = await workspace.beforeEffect(tool.definition.name, input);
      if (!begun.ok) { workspaceConflict = true; throw new NativeRuntimeError("workspace-conflict"); }
      let result: Awaited<ReturnType<typeof tool.invoke>>;
      try {
        result = await tool.invoke(input, context);
      } catch (cause) {
        workspaceConflict = true;
        // A throwing tool may already have touched files. The owner must observe the failed
        // effect; it must never become the next owned baseline through an arbitrary checkpoint.
        await workspace.afterEffect(begun.value.effectId, { isError: true });
        throw cause;
      }
      const completed = await workspace.afterEffect(begun.value.effectId, { isError: result.isError });
      if (!completed.ok) { workspaceConflict = true; throw new NativeRuntimeError("workspace-conflict"); }
      return result;
    },
  });
  const tools = [...buildInteractiveAgentTools({ cwd: options.cwd, metaprojectPort: createMetaprojectAdapter(options.cwd),
    searchController, spawnTool: spawn, jobRegistry: jobs,
    getSessionDir: () => sessionDir, askUser: (request) => (sessionAskUser ?? options.askUser ?? (async () => ASK_USER_NO_HOST))(request),
    ...(options.allowSubagents === true ? {} : { denyTools: ["spawn_subagent"] }),
  }), ...canonicalProjectTools(() => projectContext)].filter((tool) => options.allowedTools === undefined || options.allowedTools.includes(tool.definition.name)).map(wrapTool);
  return {
    jobs,
    withJobOwner<T>(owner: JobOwner, task: () => T): T { return jobOwners.run(owner, task); },
    /** Local composition only: durable process identity for crash recovery. Returns the unsubscribe. */
    observeOwnedProcesses(listener: (event: NativeOwnedProcessEvent) => void): () => void { processListeners.add(listener); return () => { processListeners.delete(listener); }; },
    approve,
    invalidateApprovals() { approvedEffects.clear(); },
    async attachServices(context: Pick<NativeServicesFactoryContext, "configDir" | "identity" | "sessionState">) {
      const id = context.identity().nativeSessionId; if (nativeSessionIdentity !== undefined && nativeSessionIdentity !== id) throw new NativeRuntimeError("native-service-identity-conflict"); nativeSessionIdentity = id;
      if (services !== undefined) { const old = await services.close(); if (!old.stopped) throw new NativeRuntimeError("session-services-stop-unconfirmed"); detachServiceTools(); services = undefined; }
      try {
        services = await jobOwners.run({ kind: "session", identity: id }, () => (options.servicesFactory ?? createNativeSessionServices)({ ...context, cwd: options.cwd, jobs, searchController, routingAvailability: () => this.routing(context.sessionState().config).availability() }));
        const extra = services.interactiveTools.filter(tool => options.allowedTools === undefined || options.allowedTools.includes(tool.definition.name));
        for (const tool of extra) { if (tools.some(existing => existing.definition.name === tool.definition.name)) throw new NativeRuntimeError("duplicate-service-tool"); const wrapped = wrapTool(tool); tools.push(wrapped); serviceTools.push(wrapped); }
        retryServicesClose = undefined;
      } catch (cause) { if (cause instanceof NativeServicesSetupError) retryServicesClose = cause.retryClose; throw cause; }
    },
    /** Finalizes the session services (MCP, bus). Only a confirmed close detaches them, so an unproven one can be retried and stays owned. */
    async closeServices(): Promise<{ stopped: boolean }> {
      if (retryServicesClose !== undefined) { const result = await retryServicesClose(); if (result.stopped) retryServicesClose = undefined; return result; }
      if (services === undefined) return { stopped: true };
      const result = await services.close(); if (result.stopped) { detachServiceTools(); services = undefined; }
      return result;
    },
    bindRestrictions(readOnly: (version: number) => boolean) { restrictionForVersion = readOnly; },
    bindAskUser(ask: AskUserFn) { sessionAskUser = ask; },
    bindSessionDir(dir: string) { sessionDir = dir; slateSession = { dir, cwd: options.cwd, opened: false }; },
    bindProjectContext(port: SessionProjectReadPort | undefined, mode: "hub-remote" | "local-native" = "hub-remote") { projectContext = port; inspectionMode = mode; },
    bindContextCompaction(handler: NonNullable<AgentDeps["onContextCompaction"]>) { onContextCompaction = handler; },
    detachSession() { detachSlateSession(slateSession); sessionDir = undefined; },
    async preserveSession() { await closeSlateSession(slateSession, randomUUID); },
    bindWorkspace(port: SessionWorkspacePort) { workspace = port; },
    async commitManualModel(config: Control["SessionConfig"], history: NormalizedMessage[], onHistoryChange: () => void) {
      const candidate = this.routing(config).availability().candidates.find((item) => item.candidateId === config.baselineCandidateId && item.available);
      if (candidate === undefined) throw new NativeRuntimeError("candidate-unavailable");
      const binding = bindings.get(bindingKey(candidate.providerId, candidate.modelId)); if (binding === undefined) throw new NativeRuntimeError("candidate-unavailable");
      await applyRuntimeSwitchToSlate({ slateSession, runtime: { provider: binding.actualProviderId, model: binding.actualModelId }, history, onHistoryChange });
      selected = { providerId: binding.actualProviderId, modelId: binding.actualModelId };
    },
    commandContributions() { return [...goalCommands(), ...settingsInspectionCommands(services === undefined ? {} : { port: services.settings }), ...analysisCommands({ availableCommands: options.analysis?.enabledCommands ?? [], readInspection: true }), ...tasksIntegrationsCommands(integrationPort() === undefined ? {} : { port: integrationPort()! }), ...(options.commandContributions ?? [])]; },
    /** Flow-free read port over the SAME owned jobs capture, independent of the optional Jev service. The host adds inspection authority. */
    analysisReadPort(): NativeAnalysisReadPort { return { ciSpawn: readPorts.ciSpawn }; },
    ownedGitSpawner() { return options.spawnOwnedGit; },
    integrationPort,
    modelBindings() { return structuredClone([...bindings.values()]); },
    commandPolicy(policyDigest: string) { return {
      policy: { profileId: options.policy?.profileId ?? "local-native", fingerprint: policyDigest,
        allowedTools: tools.map((tool) => tool.definition.name), maxRounds: options.deps?.maxRounds ?? 20, maxToolCalls: options.deps?.maxToolCalls ?? 100 },
      ...(options.analysis === undefined ? {} : { analysis: { ...options.analysis, ...readPorts, readDiff: readAnalysisDiff } }),
    }; },
    analysisCandidate(): Control["RoutingCandidate"] | undefined { return options.analysis === undefined ? undefined : {
      candidateId: canonicalDigest({ service: "openrouter-systemone", model: options.analysis.model }), ...wireModelIdentity("openrouter-systemone", options.analysis.model),
      reasoningEfforts: ["none"], available: false, reason: "local-policy", privacyClass: "approved-egress", costClass: "metered",
    }; },
    routingPolicy() { return { configured: options.nativeClassifier !== undefined, serviceBudgetMs: 2500, maximumBudgetMs: 3000, maximumProviderCalls: 1, maximumOutputTokens: 16, maximumTaskCharacters: 2000, jevEnabled: false, jevReason: "disabled-by-current-profile" }; },
    routing(config: Control["SessionConfig"], context?: NativeClassifierContext) {
      const availability: Control["RoutingAvailability"] = structuredClone(options.availability ?? {
        version: 1, policyDigest: config.policyDigest, capabilityDigest: config.capabilityDigest,
        profileIds: [config.routing.profileId], candidates: [{ candidateId: wireCandidateId(options.providerId, options.modelId), ...wireModelIdentity(options.providerId, options.modelId),
          reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], available: true, reason: "none", privacyClass: "approved-egress", costClass: "metered" }],
      });
      availability.candidates = availability.candidates.map((candidate) => { const binding = bindings.get(bindingKey(candidate.providerId, candidate.modelId)) ?? actualBindings.get(bindingKey(candidate.providerId, candidate.modelId));
        return binding === undefined ? { ...candidate, available: false, reason: "local-policy" } : { ...candidate, providerId: binding.providerId, modelId: binding.modelId }; });
      const serviceCandidate = this.analysisCandidate();
      if (serviceCandidate !== undefined) { const index = availability.candidates.findIndex((candidate) => candidate.candidateId === serviceCandidate.candidateId); if (index < 0) availability.candidates.push(serviceCandidate); else availability.candidates[index] = serviceCandidate; }
      return createSessionRouting({ config, availability, ...(options.nativeClassifier !== undefined ? { classify: (text: string, value: Control["SessionConfig"]) => context === undefined ? Promise.resolve(undefined) : options.nativeClassifier!(text, value, context).catch((cause: unknown) => { context.onRefusal?.(cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : "native-classifier-refused"); throw cause; }) } : options.classify === undefined ? {} : { classify: options.classify }) });
    },
    async run(io: AgentIO, history: NormalizedMessage[], text: string, snapshot: Control["ConfigSnapshot"], turnOptions: RunAgentTurnOptions & { nativeGoal?: { text: string; workspaceId?: string; autoRounds?: number; canonicalFlowId?: string } }): Promise<NativeRuntimeTurnResult> {
      let modelActions = 0; let toolActions = 0;
      liveAction = async (action) => {
        action.signal?.throwIfAborted();
        if (action.kind === "model" ? ++modelActions > (options.deps?.maxRounds ?? 20) : ++toolActions > (options.deps?.maxToolCalls ?? 100)) throw new NativeRuntimeError("local-run-budget-exceeded");
        await io.beforeAction?.(action);
      };
      effectApprover = options.approve ?? io.requestApproval;
      approvedEffects.clear();
      const candidate = this.routing(snapshot.config).availability().candidates.find((item) => item.candidateId === snapshot.effectiveCandidateId);
      if (candidate === undefined || !candidate.available) throw new NativeRuntimeError("candidate-unavailable");
      const binding = bindings.get(bindingKey(candidate.providerId, candidate.modelId)); if (binding === undefined) throw new NativeRuntimeError("candidate-unavailable");
      selected = { providerId: binding.actualProviderId, modelId: binding.actualModelId };
      const selectedProvider = providerFor(candidate.providerId, candidate.modelId);
      let providerOutcome: "incomplete" | "complete" | "error" = "incomplete"; let providerFailed = false;
      const observedProvider: ProviderPort = {
        ...selectedProvider, describe: () => selectedProvider.describe(),
        stream: (request, streamOptions) => (async function* () {
          providerOutcome = "incomplete"; let failed = false;
          try {
            if (workspaceConflict) throw new NativeRuntimeError("workspace-conflict");
            for await (const event of selectedProvider.stream(request, streamOptions)) {
              if (event.kind === "provider_error") { failed = true; providerOutcome = "error"; providerFailed = true; }
              else if (event.kind === "model_end" && !failed) providerOutcome = "complete";
              yield event;
            }
          } catch (cause) { providerOutcome = "error"; providerFailed = true; throw cause; }
        })(),
      };
      const liveTools = tools.filter((tool) => inspectionMode !== "hub-remote" || !tool.definition.name.startsWith("flow_"));
      const deps: AgentDeps = { ...options.deps, cwd: options.cwd, provider: observedProvider, ...selected,
        ...(onContextCompaction === undefined ? {} : { onContextCompaction }),
        tools: liveTools, reasoningEffort: snapshot.config.reasoningEffort === "none" ? "off" : snapshot.config.reasoningEffort, idSeq: randomUUID, jobRegistry: jobs,
        sweepBackgroundJobs: async () => { const owner = jobOwners.getStore(); if (owner !== undefined) await Promise.all(jobs.list().filter(job => job.status === "running" && job.owner?.kind === owner.kind && job.owner.identity === owner.identity).map(job => jobs.kill(job.jobId))); },
        systemInstruction: buildAgentSystemInstruction(`Project root: ${options.cwd}${inspectionMode === "hub-remote" ? "\nCanonical project context and Flows are read only through hub_context, hub_flows and hub_flow. Local legacy Flow tools are unavailable in this session." : ""}`, { ...selected, toolNames: interactiveAgentToolNames(liveTools) }),
      };
      let result: RunAgentTurnResult = {};
      const readOnly = restrictionForVersion(snapshot.config.configVersion) || (io.readOnly?.() ?? false);
      const scopedIo = { ...io, readOnly: () => readOnly, beforeAction: liveAction, requestApproval: approve };
      const nativeOptions = { ...turnOptions, origin: turnOptions.origin ?? "operator", ...(slateSession === undefined ? {} : { slateSession }),
        ...(onContextCompaction === undefined ? {} : { pruneArchive: true }) };
      if (turnOptions.nativeGoal === undefined) result = await runAgentTurn(scopedIo, deps, history, text, nativeOptions);
      else {
        const goal = turnOptions.nativeGoal;
        const canonicalFlow = goal.canonicalFlowId === undefined ? undefined : { id: goal.canonicalFlowId, readContext: async () => {
          await liveAction!({ kind: "tool", toolName: "goal:canonical-flow-read", ...(turnOptions.signal === undefined ? {} : { signal: turnOptions.signal }) });
          if (projectContext === undefined) throw new NativeRuntimeError("canonical-project-context-required");
          const encoded = JSON.stringify(await projectContext.readFlow(goal.canonicalFlowId!));
          if (Buffer.byteLength(encoded) > 32768) throw new NativeRuntimeError("canonical-goal-context-too-large");
          return redactSensitiveText(encoded);
        } };
        await runGoalCommand({ raw: goal.text, parsed: { text: goal.text, ...(goal.workspaceId === undefined ? {} : { workspaceId: goal.workspaceId }),
          ...(goal.autoRounds === undefined ? {} : { auto: { rounds: goal.autoRounds } }) }, cwd: options.cwd, io: scopedIo, deps, history, slateSession,
          mintAttemptId: randomUUID, turnOptions: nativeOptions, strictBookkeeping: true, onTurnResult: (value) => { result = value; }, ...(canonicalFlow === undefined ? {} : { canonicalFlow }) });
      }
      // The native engine's historical {} return also covers provider errors. Observe the real
      // provider boundary so an idle session can never be mistaken for a successful execution.
      const observed: string = providerOutcome;
      const outcome = workspaceConflict || children.size > 0 ? "unknown" : turnOptions.signal?.aborted ? "cancelled" : providerFailed || observed === "error" || result.rateLimited !== undefined || result.caughtToolErrors?.length ? "failed"
        : result.finishReason !== undefined ? "failed" : observed === "complete" ? "succeeded" : "unknown";
      const reason = workspaceConflict ? "workspace-conflict" : turnOptions.signal?.aborted ? "aborted" : providerFailed || observed === "error" ? "provider-error" : result.finishReason ?? (result.caughtToolErrors?.length ? "tool-exception" : observed === "complete" ? "model-finished" : "provider-incomplete");
      return { outcome, reason, result };
    },
    async stop(scope: JobOwner = { kind: "session", identity: nativeSessionIdentity ?? "unbound-native-session" }): Promise<{ status: "stopped" | "unknown"; remainingTaskIds: string[] }> {
      // The registry is per runtime, so a session stop owns every job in it, owned or not; run and inspection stops only their own.
      const wholeSession = scope.kind === "session";
      const matches = (owner: JobOwner | undefined) => wholeSession || owner !== undefined && owner.kind === scope.kind && owner.identity === scope.identity;
      const killWithin = async (jobId: string, reason: KillReason): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([jobs.kill(jobId, reason), new Promise<void>(resolve => { timer = setTimeout(resolve, STOP_KILL_BOUND_MS); })]); }
        catch { /* A failed or unfinished kill proves nothing: the process-group probe below decides, and a survivor is reported unknown with its task id. */ }
        finally { if (timer !== undefined) clearTimeout(timer); }
      };
      const running = jobs.list().filter(job => job.status === "running"); const owned = running.filter(job => matches(job.owner));
      // A job whose kill was already requested and is still alive is not awaited again: the registry would hand back its exit promise, which a live process never settles.
      await Promise.all(owned.filter(job => !uncertainStops.has(job.jobId)).map(job => killWithin(job.jobId, wholeSession ? "session-exit" : "operator")));
      for (const job of owned) uncertainStops.set(job.jobId, { pid: job.pid, owner: job.owner });
      const remainingTaskIds = wholeSession ? [] : running.filter(job => job.owner === undefined).map(job => job.jobId);
      const tracked = [...uncertainStops].filter(([, candidate]) => matches(candidate.owner)); let alive = tracked.filter(([, candidate]) => processGroupAlive(candidate.pid));
      for (const deadline = Date.now() + STOP_ABSENCE_PROOF_MS; alive.length > 0 && Date.now() < deadline;) { await new Promise<void>(resolve => setTimeout(resolve, 25)); alive = alive.filter(([, candidate]) => processGroupAlive(candidate.pid)); }
      for (const [id] of tracked) if (!alive.some(([survivor]) => survivor === id)) uncertainStops.delete(id);
      remainingTaskIds.push(...alive.map(([id]) => id));
      const ownedChildren = [...children].filter(([,owner]) => matches(owner) || owner === undefined).map(([promise]) => promise);
      if (ownedChildren.length > 0) { let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled(ownedChildren), new Promise<void>(resolve => { timeout = setTimeout(resolve, 1000); })]); if (timeout !== undefined) clearTimeout(timeout);
      }
      const childRemainder = [...children].filter(([,owner]) => matches(owner) || owner === undefined).map((_,index) => `native-child-${index}`);
      return { status: remainingTaskIds.length === 0 && childRemainder.length === 0 ? "stopped" : "unknown", remainingTaskIds: [...remainingTaskIds,...childRemainder] };
    },
  };
}
export class NativeRuntimeError extends Error { constructor(readonly code: string) { super(code); this.name = "NativeRuntimeError"; } }
export type NativeSessionRuntime = ReturnType<typeof createNativeSessionRuntime>;
