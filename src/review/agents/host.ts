import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadAgentCatalog, type AgentCatalog } from "../../agents/catalog";
import type { AgentDefinition } from "../../agents/types";
import type { AgentIO } from "../../commands/agent";
import { buildProjectTools } from "../../commands/project-tools";
import { builtinReadOnlyTools, type InteractiveTool } from "../../harness/tool/builtin/interactive-tools";
import { createMetaprojectAdapter } from "../../harness/tool/metaproject-adapter";
import type { ProviderPort } from "../../harness/provider/types";
import { bundledSkillMarkdownPath } from "../../gdskills/catalog";
import { keryxConfigDir, readConfigFile, readTurnFile, writeOwnerOnlyFileAtomic } from "../../lib/config-dir";
import { loadOAuthGrant } from "../../lib/oauth/grants";
import { ensureOpenAiCodexGrant, refreshOpenAiCodexGrant } from "../../lib/oauth/openai-subscription";
import { providerByName } from "../../commands/providers";
import { loadShellConfig } from "../../lib/shell-config";
import type {
  ExternalBridgeAuthorityRequest,
  ExternalBridgeControllerPort,
  ExternalBridgeGrantSnapshot,
  ExternalBridgeGrantStore,
} from "./external-adapter";
import {
  createKeryxExternalGeneralHost,
  type KeryxExternalGeneralHost,
  type KeryxProviderPreflightEvidence,
} from "./keryx-general-host";
import { scopedProviderCredentials } from "./keryx-general-worker-entry";
import { createReviewAgentNativeAdapter } from "./native-adapter";
import { createReviewAgentEntityPolicyResolver } from "./entity-admission";
import {
  createReviewPlan,
  createReviewRuntimePlanRegistration,
  type ReviewPlanInput,
  type ReviewRuntimePlanWaveInput,
} from "./planning";
import { createLargeReviewConfig } from "./config";
import { ReviewAgentController } from "./controller";
import type {
  ReviewAgentAuthority,
  ReviewAgentAdapterRequest,
  ReviewAgentConfig,
  ReviewAgentRole,
  ReviewAgentRunState,
  ReviewAgentSpawnInput,
} from "./types";

const execFileAsync = promisify(execFile);
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ENTITY_ROLES: Readonly<Record<string, ReviewAgentRole>> = {
  "review-coordinator": "coordinator",
  "review-worker": "worker",
  "review-scout": "scout",
  "review-validator": "validator",
};

export interface ReviewAgentHostRuntime {
  readonly provider: ProviderPort;
  readonly providerId: string;
  readonly modelId: string;
  /** Live approval mode. It is intentionally looked up at action time. */
  readonly io?: () => Pick<AgentIO, "requestApproval" | "permissionMode"> | undefined;
  /** Background-safe revocation check; it must not consume parent-turn counters or mutate its slate. */
  readonly authorizeReviewAgentAction?: (request: {
    readonly runId: string;
    readonly dispatchId: string;
    readonly operation: "model" | "tool" | "bridge";
    readonly toolName?: string;
    readonly bridgeOperation?: ExternalBridgeAuthorityRequest["operation"];
    readonly signal?: AbortSignal;
  }) => boolean | void | Promise<boolean | void>;
}

export interface ReviewAgentHostOptions {
  readonly projectRoot: string;
  readonly runsRoot?: string;
  /** Canonical Keryx state directory used by the isolated external worker. */
  readonly configDir?: string;
  readonly ownerId?: string;
  readonly leaseMs?: number;
  readonly now?: () => number;
  readonly id?: () => string;
  /** Test seam. Production always creates a detached, exact-revision source snapshot. */
  readonly snapshotRevision?: (projectRoot: string, revision: string, destination: string) => Promise<string>;
  /** Test seam. Production preflights the dedicated external Keryx worker. */
  readonly externalGeneralHostFactory?: typeof createKeryxExternalGeneralHost;
}

export interface ReviewAgentHost {
  readonly tools: (runtime: ReviewAgentHostRuntime) => readonly InteractiveTool[];
  readonly controller: (runId: string) => Promise<ReviewAgentController>;
  readonly close: () => Promise<{ readonly stopped: boolean; readonly activeRunIds: readonly string[] }>;
}

interface AuthorityLease { readonly runId: string; readonly expiresAt: number }
interface RootAuthority { readonly runId: string; readonly authorityRef: string }
const EXTERNAL_ADAPTER_ID = "keryx-external-general";
const RUNTIME_BINDING_FILE = "runtime-binding.json";
const HOST_CAPABILITY_PROFILE = {
  native: {
    toolParity: false,
    sourceInspection: true,
    bridgeOnly: false,
    authority: "live-parent-approval-path",
    limitation: "entity-declared read tools over the immutable source snapshot; no parent shell, MCP, web, workspace or mutation tools",
  },
  [EXTERNAL_ADAPTER_ID]: {
    toolParity: false,
    sourceInspection: false,
    bridgeOnly: true,
    authority: "scoped-controller-bridge",
    oauthRefresh: false,
    limitation: "coordinates and consolidates through scoped soldiers only; provider state must already be usable without credential refresh",
  },
} as const;

/**
 * A session-owned Review agents host. Every surface bound to this object shares one
 * controller cache, authority lease table and durable run ledger.
 */
export function createReviewAgentHost(options: ReviewAgentHostOptions): ReviewAgentHost {
  const projectRoot = path.resolve(options.projectRoot);
  const runsRoot = path.resolve(options.runsRoot ?? path.join(projectRoot, ".metaproject", "reviews", "agents"));
  assertContained(projectRoot, runsRoot, "Review agents runs root");
  const ownerId = options.ownerId ?? `review-agents-host-${randomUUID()}`;
  const configDir = path.resolve(options.configDir ?? keryxConfigDir());
  const externalGeneralHostFactory = options.externalGeneralHostFactory ?? createKeryxExternalGeneralHost;
  const now = options.now ?? Date.now;
  const nextId: () => string = options.id ?? (() => randomUUID());
  const controllers = new Map<string, ReviewAgentController>();
  const externalHosts = new Map<string, KeryxExternalGeneralHost>();
  const leases = new Map<string, AuthorityLease>();
  const dispatchAuthorities = new Map<string, string>();
  const rootAuthority = new AsyncLocalStorage<RootAuthority>();
  const loadedCatalog = catalogOrThrow(projectRoot);
  const catalog = loadedCatalog.agents.map((agent) => agent.definition);
  const policies = createReviewAgentEntityPolicyResolver(loadedCatalog);

  const authority: ReviewAgentAuthority = {
    authorize(request) {
      const root = rootAuthority.getStore();
      const authorityRef = root?.runId === request.runId ? root.authorityRef : request.authorityRef;
      if (authorityRef === undefined) return false;
      const lease = leases.get(authorityRef);
      if (lease === undefined || lease.runId !== request.runId || lease.expiresAt <= now()) return false;
      if (request.operation === "spawn" && request.dispatchId !== undefined) dispatchAuthorities.set(request.dispatchId, authorityRef);
      return { allowed: true, authorityRef };
    },
  };

  const runDir = (runId: string): string => {
    if (!RUN_ID.test(runId)) throw new Error("run_id must contain only letters, digits, '.', '_' or '-' and be at most 128 characters");
    const resolved = path.join(runsRoot, runId);
    assertContained(runsRoot, resolved, "Review agents run directory");
    return resolved;
  };

  const verifyRunsRoot = async (): Promise<string> => {
    const info = await lstat(runsRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Review agents runs root must be a real directory, not a symlink");
    const canonicalProject = await realpath(projectRoot);
    const canonicalRoot = await realpath(runsRoot);
    assertContained(canonicalProject, canonicalRoot, "Review agents canonical runs root");
    return canonicalRoot;
  };

  const verifiedRunDir = async (runId: string): Promise<string> => {
    const canonicalRoot = await verifyRunsRoot();
    const candidate = runDir(runId);
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Review agents run ${runId} must be a real directory, not a symlink`);
    const canonicalRun = await realpath(candidate);
    assertContained(canonicalRoot, canonicalRun, `Review agents canonical run ${runId}`);
    const children = await readdir(canonicalRun, { withFileTypes: true });
    if (children.some((entry) => entry.isSymbolicLink())) throw new Error(`Review agents run ${runId} contains an unsafe symlink child`);
    return canonicalRun;
  };

  const externalAuthority = async (runId: string, request: ExternalBridgeAuthorityRequest, runtime: ReviewAgentHostRuntime): Promise<boolean> => {
    if (request.runId !== runId) return false;
    const authorityRef = dispatchAuthorities.get(request.parentDispatchId);
    if (authorityRef === undefined) return false;
    const lease = leases.get(authorityRef);
    if (lease === undefined || lease.runId !== runId || lease.expiresAt <= now()) return false;
    const authorizeAction = runtime.authorizeReviewAgentAction;
    if (authorizeAction === undefined) return false;
    try {
      return await authorizeAction({ runId, dispatchId: request.parentDispatchId, operation: "bridge", bridgeOperation: request.operation }) !== false;
    } catch { return false; }
  };

  const createExternalHost = async (
    runId: string,
    directory: string,
    runtime: ReviewAgentHostRuntime,
    controller: () => ReviewAgentController | undefined,
    config: ReviewAgentConfig,
  ): Promise<KeryxExternalGeneralHost> => externalGeneralHostFactory({
    runId,
    runDir: directory,
    configDir,
    provider: runtime.providerId,
    model: runtime.modelId,
    compileInstructions: (request) => externalInstructions(projectRoot, catalog, request),
    preflightProvider: (input) => preflightExternalProvider(input, config.roleCeilings.coordinator.elapsedMs),
    controller: () => {
      const current = controller();
      return current === undefined ? undefined : externalControllerPort(current);
    },
    authorize: (request) => externalAuthority(runId, request, runtime),
    grantTtlMs: config.roleCeilings.coordinator.elapsedMs,
    grantStore: externalGrantStore(directory),
  });

  const boundController = async (runId: string): Promise<ReviewAgentController> => {
    const cached = controllers.get(runId);
    if (cached !== undefined) return cached;
    throw new Error(`Review agents run ${runId} is not bound to this live host session`);
  };

  const withAuthority = async <T>(runId: string, deadlineMs: number, work: () => Promise<T>): Promise<T> => {
    const authorityRef = nextId();
    leases.set(authorityRef, { runId, expiresAt: now() + deadlineMs });
    try { return await rootAuthority.run({ runId, authorityRef }, work); }
    finally {
      // Keep the lease while descendants admitted by this root action may run.
      const lease = leases.get(authorityRef);
      if (lease !== undefined && lease.expiresAt <= now()) leases.delete(authorityRef);
    }
  };

  const tools = (runtime: ReviewAgentHostRuntime): readonly InteractiveTool[] => {
    const controllerFor = async (runId: string): Promise<ReviewAgentController> => {
      const cached = controllers.get(runId);
      if (cached !== undefined) return cached;
      const directory = await verifiedRunDir(runId);
      const pinned = readRuntimeBinding(directory);
      if (pinned.providerId !== runtime.providerId || pinned.modelId !== runtime.modelId) {
        throw new Error(`Review agents run ${runId} is pinned to ${pinned.providerId}/${pinned.modelId}; select that runtime before reopening it`);
      }
      const sourceRoot = path.join(directory, "source");
      const config = hostConfig(catalog);
      let controller: ReviewAgentController | undefined;
      const external = await createExternalHost(runId, directory, runtime, () => controller, config);
      try {
        controller = await ReviewAgentController.open({
          storageDir: directory, adapters: [nativeAdapter(sourceRoot, () => runtime, catalog, projectRoot), external.adapter],
          authority, entityPolicies: policies, ownerId, id: nextId,
          ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
        });
        controllers.set(runId, controller);
        externalHosts.set(runId, external);
        return controller;
      } catch (error) {
        await external.close().catch(() => undefined);
        throw error;
      }
    };

    const start: InteractiveTool = {
      definition: {
        name: "review_agents_start", risk: "write",
        description: "Start one durable Review agents run against an exact git revision with native soldiers and a contained external Keryx general.",
        inputSchema: { type: "object", additionalProperties: false, required: ["run_id", "revision"], properties: { run_id: { type: "string" }, revision: { type: "string" } } },
      },
      invoke: async (input) => {
        try {
          const runId = requiredString(input.run_id, "run_id");
          const revision = requiredString(input.revision, "revision");
          const destination = runDir(runId);
          await mkdir(runsRoot, { recursive: true });
          await verifyRunsRoot();
          const temporary = await mkdtemp(path.join(runsRoot, `.${runId}.`));
          let resolvedRevision: string;
          try {
            resolvedRevision = await (options.snapshotRevision ?? snapshotGitRevision)(projectRoot, revision, temporary);
            await rename(temporary, destination);
            await verifiedRunDir(runId);
          } catch (error) {
            await rm(temporary, { recursive: true, force: true });
            throw error;
          }
          const config = hostConfig(catalog);
          let controller: ReviewAgentController | undefined;
          let external: KeryxExternalGeneralHost | undefined;
          try {
            const runtimePinned = writeRuntimeBinding(destination, runtime);
            external = await createExternalHost(runId, destination, runtime, () => controller, config);
            controller = await ReviewAgentController.create({
              storageDir: destination, runId, revision: resolvedRevision, config,
              adapters: [nativeAdapter(path.join(destination, "source"), () => runtime, catalog, projectRoot), external.adapter],
              authority, entityPolicies: policies, ownerId, id: nextId,
              ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
            });
            controllers.set(runId, controller);
            externalHosts.set(runId, external);
            return { output: JSON.stringify({ runId, revision: resolvedRevision, storageDir: destination, config, capabilities: controller.capabilities(), capabilityProfile: HOST_CAPABILITY_PROFILE, runtimePinned }, null, 2), isError: false };
          } catch (error) {
            await external?.close().catch(() => undefined);
            await rm(destination, { recursive: true, force: true });
            throw error;
          }
        } catch (error) {
          return { output: error instanceof Error ? error.message : String(error), isError: true };
        }
      },
    };

    const spawn: InteractiveTool = {
      definition: {
        name: "review_agents_spawn", risk: "delegate",
        description: "Admit one root-level Review agents coordinator or soldier into the shared controller.",
        inputSchema: { type: "object", additionalProperties: false, required: ["run_id", "task_id", "attempt", "entity", "role", "adapter_id", "scope_ids"], properties: {
          run_id: { type: "string" }, task_id: { type: "string" }, task: { type: "string" }, attempt: { type: "integer", minimum: 1 },
          idempotency_key: { type: "string" },
          entity: { type: "string" }, role: { enum: ["coordinator", "worker", "scout", "validator"] }, adapter_id: { type: "string" }, skill_ref: { type: "string" },
          scope_ids: { type: "array", items: { type: "string" } }, wave_id: { type: "string" }, max_runtime_ms: { type: "integer", minimum: 1 },
        } },
      },
      invoke: async (input) => {
        try {
          const runId = requiredString(input.run_id, "run_id");
          const controller = await controllerFor(runId);
          const state = await controller.status() as ReviewAgentRunState;
          if (state.activePlan === null) throw new Error("Review agents requires a registered host-approved plan before spawn");
          const spawnInput = parseSpawn(input);
          if (spawnInput.adapterId === EXTERNAL_ADAPTER_ID && spawnInput.role !== "coordinator") {
            throw new Error(`${EXTERNAL_ADAPTER_ID} is restricted to coordinator entities`);
          }
          return { output: JSON.stringify(await withAuthority(runId, remainingDeadline(state, now()), () => controller.spawn(spawnInput)), null, 2), isError: false };
        } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
      },
    };

    const plan: InteractiveTool = {
      definition: {
        name: "review_agents_plan", risk: "write",
        description: "Validate and register the immutable responsibility, coverage and wave plan for this exact Review agents revision.",
        inputSchema: reviewPlanToolSchema(),
      },
      invoke: async (input) => {
        try {
          const envelope = exactRecord(input, ["run_id", "plan", "waves"], [], "review_agents_plan");
          const runId = requiredString(envelope.run_id, "run_id");
          const controller = await controllerFor(runId);
          const state = await controller.status() as ReviewAgentRunState;
          const planInput = parseReviewPlanInput(envelope.plan);
          const waves = parseReviewPlanWaves(envelope.waves);
          if (planInput.revision !== state.revision) throw new Error("Review agents plan revision must equal the run snapshot revision");
          const registration = createReviewRuntimePlanRegistration(createReviewPlan(planInput), waves);
          await withAuthority(runId, 30_000, () => controller.registerPlan(registration));
          return { output: JSON.stringify({ planHash: registration.planHash, planVersion: registration.planVersion, revision: registration.revision, waves: registration.waves }, null, 2), isError: false };
        } catch (error) {
          return { output: error instanceof Error ? error.message : String(error), isError: true };
        }
      },
    };

    const status = readTool("review_agents_status", "Read Review agents run or assignment status.", ["run_id"], { run_id: { type: "string" }, dispatch_id: { type: "string" } }, async (input) => {
      const controller = await controllerFor(requiredString(input.run_id, "run_id"));
      return redactStatus(await controller.status(optionalString(input.dispatch_id)));
    });
    const wait = readTool("review_agents_wait", "Wait for one Review agents assignment to reach a terminal state.", ["run_id", "dispatch_id"], { run_id: { type: "string" }, dispatch_id: { type: "string" } }, async (input, signal) => {
      const controller = await controllerFor(requiredString(input.run_id, "run_id"));
      return controller.wait(requiredString(input.dispatch_id, "dispatch_id"), signal === undefined ? {} : { signal });
    });
    const result = readTool("review_agents_result", "Read the full durable result of one Review agents assignment.", ["run_id", "dispatch_id"], { run_id: { type: "string" }, dispatch_id: { type: "string" } }, async (input) => {
      const runId = requiredString(input.run_id, "run_id"); const controller = await controllerFor(runId);
      return withAuthority(runId, 30_000, () => controller.result(requiredString(input.dispatch_id, "dispatch_id")));
    });
    const cancel: InteractiveTool = {
      definition: { name: "review_agents_cancel", risk: "destructive", description: "Cancel one Review agents subtree, or the entire run when dispatch_id is omitted.", inputSchema: { type: "object", additionalProperties: false, required: ["run_id", "reason"], properties: { run_id: { type: "string" }, dispatch_id: { type: "string" }, reason: { type: "string" } } } },
      invoke: async (input) => {
        try { const runId = requiredString(input.run_id, "run_id"); const controller = await controllerFor(runId); await withAuthority(runId, 30_000, () => controller.cancel(optionalString(input.dispatch_id), requiredString(input.reason, "reason"))); return { output: "cancelled", isError: false }; }
        catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
      },
    };
    return [start, plan, spawn, status, wait, result, cancel];
  };

  const close = async (): Promise<{ readonly stopped: boolean; readonly activeRunIds: readonly string[] }> => {
    const activeRunIds: string[] = [];
    let stopped = true;
    for (const [runId, controller] of controllers) {
      try {
        const state = await controller.status() as ReviewAgentRunState;
        if (state.status !== "active") continue;
        activeRunIds.push(runId);
        await withAuthority(runId, 30_000, () => controller.cancel(undefined, "host session closed"));
      } catch { stopped = false; }
    }
    await Promise.all([...controllers.values()].map(async (controller) => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          controller.close().then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (!settled) stopped = false;
      } catch { stopped = false; }
    }));
    await Promise.all([...externalHosts.values()].map(async (external) => {
      try { await external.close(); }
      catch { stopped = false; }
    }));
    leases.clear();
    dispatchAuthorities.clear();
    if (stopped) {
      controllers.clear();
      externalHosts.clear();
    }
    return { stopped, activeRunIds };
  };

  return { tools, controller: boundController, close };
}

function nativeAdapter(sourceRoot: string, runtime: () => ReviewAgentHostRuntime, catalog: readonly AgentDefinition[], projectRoot: string) {
  return createReviewAgentNativeAdapter({
    cwd: sourceRoot,
    providerFor: async () => { const bound = runtime(); return { provider: bound.provider, providerId: bound.providerId, modelId: bound.modelId }; },
    toolsFor: async (request) => reviewTools(sourceRoot, catalog.find((entry) => entry.name === request.entity)),
    beforeAction: async (request, action) => {
      const authorizeAction = runtime().authorizeReviewAgentAction;
      if (authorizeAction === undefined || await authorizeAction({
        runId: request.runId, dispatchId: request.dispatchId, operation: action.kind,
        ...(action.toolName === undefined ? {} : { toolName: action.toolName }),
        ...(action.signal === undefined ? {} : { signal: action.signal }),
      }) === false) throw new Error("Review agents host action authority is unavailable");
    },
    requestApproval: async (_request, tool, input, meta) => runtime().io?.()?.requestApproval?.(tool, input, meta) ?? false,
    permissionMode: () => runtime().io?.()?.permissionMode?.() ?? "ask",
    entityInstructions: (request) => { const entity = catalog.find((entry) => entry.name === request.entity); if (entity === undefined) throw new Error(`Unknown Review agents entity ${request.entity}`); return entity.body; },
    skillInstructions: (skillRef) => reviewSkillInstructions(projectRoot, skillRef),
  });
}

function reviewTools(sourceRoot: string, entity: AgentDefinition | undefined): readonly InteractiveTool[] {
  if (entity === undefined) return [];
  const candidates = [...builtinReadOnlyTools(sourceRoot), ...buildProjectTools(sourceRoot, createMetaprojectAdapter(sourceRoot)).offered];
  const allowed = new Set(entity.tools.filter((name) => name !== "spawn_subagent"));
  return candidates.filter((tool) => tool.definition.risk === "read" && allowed.has(tool.definition.name));
}

async function externalInstructions(
  projectRoot: string,
  catalog: readonly AgentDefinition[],
  request: ReviewAgentAdapterRequest,
): Promise<string> {
  if (request.role !== "coordinator") throw new Error(`${EXTERNAL_ADAPTER_ID} can execute only coordinator assignments`);
  const entity = catalog.find((entry) => entry.name === request.entity);
  if (entity === undefined) throw new Error(`Unknown Review agents entity ${request.entity}`);
  const skill = request.skillRef === undefined ? undefined : await reviewSkillInstructions(projectRoot, request.skillRef);
  return [
    entity.body.trim(),
    skill === undefined ? undefined : `Trusted review skill (${request.skillRef}):\n${skill.trim()}`,
    "This external coordinator has no source, shell, MCP, web, workspace, or provider-credential tools. Delegate bounded source inspection to soldiers through the scoped Review agents bridge and consolidate only their durable results.",
  ].filter((value): value is string => value !== undefined && value.length > 0).join("\n\n");
}

async function preflightExternalProvider(
  input: { readonly provider: string; readonly model: string; readonly configDir: string },
  requiredLifetimeMs: number,
): Promise<KeryxProviderPreflightEvidence> {
  if (!input.provider.trim() || !input.model.trim()) throw new Error("External Keryx provider and model must be selected");
  if (input.provider === "openai-codex") {
    let prepared = await ensureOpenAiCodexGrant({ configDir: input.configDir, fetch: globalThis.fetch });
    if (prepared.expires !== undefined && prepared.expires <= Date.now() + requiredLifetimeMs && prepared.refresh !== undefined) {
      await refreshOpenAiCodexGrant({ configDir: input.configDir, fetch: globalThis.fetch, forceRefresh: true });
      prepared = await ensureOpenAiCodexGrant({ configDir: input.configDir, fetch: globalThis.fetch });
    }
    if (prepared.expires === undefined || prepared.expires <= Date.now() + requiredLifetimeMs) {
      throw new Error("External Keryx openai-codex grant cannot cover the coordinator lifetime; re-authenticate before starting the run");
    }
  } else if (input.provider !== "ollama") {
    const descriptor = providerByName(input.provider, input.configDir);
    const credentials = scopedProviderCredentials(input.provider, input.configDir);
    const keyless = descriptor?.requiresApiKey === false;
    const embeddedCustomCredential = typeof descriptor?.apiKey === "string" && descriptor.apiKey.length > 0;
    if (!keyless && !embeddedCustomCredential && Object.keys(credentials).length !== 1) {
      throw new Error(`External Keryx provider ${input.provider} has no selected durable credential in the canonical Keryx state directory`);
    }
    const credentialKey = Object.keys(credentials)[0];
    const savedApiKey = credentialKey === undefined ? undefined : loadShellConfig(input.configDir).apiKeys?.[credentialKey];
    const oauth = savedApiKey === undefined ? loadOAuthGrant(input.provider, input.configDir) : undefined;
    if (oauth?.expires !== undefined && oauth.expires <= Date.now() + requiredLifetimeMs) {
      throw new Error(`External Keryx provider ${input.provider} OAuth grant cannot cover the coordinator lifetime and cannot refresh inside the child`);
    }
  }
  return {
    provider: input.provider,
    model: input.model,
    authenticatedAt: new Date().toISOString(),
    hostPreparedCredential: true,
  };
}

function externalControllerPort(controller: ReviewAgentController): ExternalBridgeControllerPort {
  const assignment = async (dispatchId: string) => {
    const value = await controller.status(dispatchId);
    return value !== undefined && "dispatchId" in value ? value : undefined;
  };
  return {
    spawn: (parentDispatchId, input) => controller.scoped(parentDispatchId).spawn(input),
    async isDescendant(parentDispatchId, dispatchId) {
      let current = await assignment(dispatchId);
      while (current?.parentDispatchId !== undefined) {
        if (current.parentDispatchId === parentDispatchId) return true;
        current = await assignment(current.parentDispatchId);
      }
      return false;
    },
    async isTerminal(dispatchId) {
      const current = await assignment(dispatchId);
      return current !== undefined && ["completed", "blocked", "failed", "cancelled", "unresolved"].includes(current.status);
    },
    status: (dispatchId) => controller.status(dispatchId),
    wait: (dispatchId) => controller.wait(dispatchId),
    result: (dispatchId) => controller.result(dispatchId),
    cancel: (dispatchId, reason) => controller.cancel(dispatchId, reason),
  };
}

function externalGrantStore(directory: string): ExternalBridgeGrantStore {
  const file = path.join(directory, "external-bridge-grants.json");
  return {
    load() {
      const read = readTurnFile(file);
      if (!read.ok) {
        if (read.reason === "absent") return [];
        throw new Error(`Cannot read Review agents external grant store: ${read.reason}`);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(read.text); }
      catch { throw new Error("Review agents external grant store contains invalid JSON"); }
      if (!recordWithExactKeys(parsed, ["schemaVersion", "grants"]) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.grants)) {
        throw new Error("Review agents external grant store has an invalid envelope");
      }
      return parsed.grants.map(parseExternalGrantSnapshot);
    },
    save(records) {
      writeOwnerOnlyFileAtomic(file, `${JSON.stringify({ schemaVersion: 1, grants: records }, null, 2)}\n`);
    },
  };
}

function writeRuntimeBinding(directory: string, runtime: ReviewAgentHostRuntime): { readonly providerId: string; readonly modelId: string } {
  const binding = {
    schemaVersion: 1,
    providerId: requiredString(runtime.providerId, "providerId"),
    modelId: requiredString(runtime.modelId, "modelId"),
  } as const;
  writeOwnerOnlyFileAtomic(path.join(directory, RUNTIME_BINDING_FILE), `${JSON.stringify(binding, null, 2)}\n`);
  return { providerId: binding.providerId, modelId: binding.modelId };
}

function readRuntimeBinding(directory: string): { readonly providerId: string; readonly modelId: string } {
  const file = path.join(directory, RUNTIME_BINDING_FILE);
  const read = readConfigFile(file);
  if (!read.ok) throw new Error(`Review agents runtime binding is unavailable: ${read.reason}`);
  let parsed: unknown;
  try { parsed = JSON.parse(read.text); }
  catch { throw new Error("Review agents runtime binding contains invalid JSON"); }
  if (!recordWithExactKeys(parsed, ["schemaVersion", "providerId", "modelId"]) || parsed.schemaVersion !== 1) {
    throw new Error("Review agents runtime binding has an invalid envelope");
  }
  return { providerId: requiredString(parsed.providerId, "runtime binding providerId"), modelId: requiredString(parsed.modelId, "runtime binding modelId") };
}

function parseExternalGrantSnapshot(value: unknown): ExternalBridgeGrantSnapshot {
  if (!recordWithExactKeys(value, ["digest", "runId", "parentDispatchId", "expiresAt", "allowedOperations", "dispatchIds", "revoked"])) {
    throw new Error("Review agents external grant record has invalid fields");
  }
  const operations = ["spawn", "status", "wait", "result", "cancel"];
  if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest) ||
      typeof value.runId !== "string" || value.runId.length === 0 ||
      typeof value.parentDispatchId !== "string" || value.parentDispatchId.length === 0 ||
      !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) < 1 ||
      !Array.isArray(value.allowedOperations) || value.allowedOperations.some((entry) => typeof entry !== "string" || !operations.includes(entry)) ||
      !Array.isArray(value.dispatchIds) || value.dispatchIds.some((entry) => typeof entry !== "string" || entry.length === 0) ||
      typeof value.revoked !== "boolean") {
    throw new Error("Review agents external grant record is invalid");
  }
  return value as unknown as ExternalBridgeGrantSnapshot;
}

function recordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function catalogOrThrow(projectRoot: string): AgentCatalog {
  const loaded = loadAgentCatalog(projectRoot);
  if (loaded.errors.length > 0) throw new Error(`Cannot bind Review agents agent catalog: ${loaded.errors.map((error) => error.message).join("; ")}`);
  const definitions = loaded.agents.map((agent) => agent.definition);
  for (const entity of Object.keys(ENTITY_ROLES)) if (!definitions.some((definition) => definition.name === entity)) throw new Error(`Review agents entity ${entity} is not installed`);
  return loaded;
}

function hostConfig(catalog: readonly AgentDefinition[]): ReviewAgentConfig {
  const entities = catalog.filter((entry) => ENTITY_ROLES[entry.name] !== undefined);
  return createLargeReviewConfig({ allowedAdapters: ["native", EXTERNAL_ADAPTER_ID], allowedEntities: entities.map((entry) => entry.name), allowedSkills: [...new Set(entities.flatMap((entry) => entry.skills))].sort() });
}

async function snapshotGitRevision(projectRoot: string, revision: string, destination: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${revision}^{commit}`], { cwd: projectRoot, encoding: "utf8" });
  const resolved = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(resolved)) throw new Error("revision did not resolve to a commit");
  await mkdir(path.join(destination, "source"), { recursive: true });
  const archive = path.join(destination, "source.tar");
  await execFileAsync("git", ["archive", "--format=tar", `--output=${archive}`, resolved, "--", ".", ":(exclude).metaproject"], { cwd: projectRoot });
  try { await execFileAsync("tar", ["-xf", archive, "-C", path.join(destination, "source")]); }
  finally { await unlink(archive).catch(() => undefined); }
  return resolved;
}

async function reviewSkillInstructions(projectRoot: string, skillRef: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(skillRef)) throw new Error(`Invalid Review agents skill reference ${skillRef}`);
  const candidates = [
    path.join(projectRoot, ".metaproject", "project-skills", "review", skillRef, "SKILL.md"),
    path.join(projectRoot, ".metaproject", "skills", "gdskills", "review", skillRef, "SKILL.md"),
    bundledSkillMarkdownPath("review", skillRef),
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    try { return await readFile(candidate, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error(`Review agents skill ${skillRef} is not installed`);
}

function reviewPlanToolSchema(): Record<string, unknown> {
  const strings = { type: "array", items: { type: "string", minLength: 1 } };
  const coverage = { type: "array", items: { type: "object", additionalProperties: false, required: ["areaId", "scopeId", "aspect"], properties: { areaId: { type: "string" }, scopeId: { type: "string" }, aspect: { type: "string" } } } };
  return {
    type: "object", additionalProperties: false, required: ["run_id", "plan", "waves"], properties: {
      run_id: { type: "string" },
      plan: { type: "object", additionalProperties: false, required: ["revision", "planVersion", "areas", "boundaries", "assignments"], properties: {
        revision: { type: "string" }, planVersion: { type: "integer", minimum: 1 },
        areas: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "requiredAspects"], properties: { id: { type: "string" }, title: { type: "string" }, requiredAspects: strings, ownerAssignmentId: { type: "string" } } } },
        boundaries: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "areaIds"], properties: { id: { type: "string" }, areaIds: strings, ownerAssignmentId: { type: "string" } } } },
        assignments: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "agentInstanceId", "kind", "entity", "areaIds", "scopeIds", "coverage"], properties: {
          id: { type: "string" }, agentInstanceId: { type: "string" }, kind: { enum: ["scout", "coordinator", "worker", "validator"] }, entity: { type: "string" }, parentAssignmentId: { type: "string" }, areaIds: strings, scopeIds: strings, coverage,
        } } },
      } },
      waves: { type: "array", items: { type: "object", additionalProperties: false, required: ["wave_id", "review_round", "assignment_ids"], properties: { wave_id: { type: "string" }, review_round: { type: "integer", minimum: 1 }, assignment_ids: strings } } },
    },
  };
}

function parseReviewPlanInput(value: unknown): ReviewPlanInput {
  const plan = exactRecord(value, ["revision", "planVersion", "areas", "boundaries", "assignments"], [], "plan");
  if (!Array.isArray(plan.areas) || !Array.isArray(plan.boundaries) || !Array.isArray(plan.assignments)) throw new Error("plan areas, boundaries and assignments must be arrays");
  return {
    revision: requiredString(plan.revision, "plan.revision"),
    planVersion: positiveInteger(plan.planVersion, "plan.planVersion"),
    areas: plan.areas.map((entry, index) => {
      const area = exactRecord(entry, ["id", "title", "requiredAspects"], ["ownerAssignmentId"], `plan.areas[${index}]`);
      return { id: requiredString(area.id, "area.id"), title: requiredString(area.title, "area.title"), requiredAspects: stringArray(area.requiredAspects, "area.requiredAspects"), ...(area.ownerAssignmentId === undefined ? {} : { ownerAssignmentId: requiredString(area.ownerAssignmentId, "area.ownerAssignmentId") }) };
    }),
    boundaries: plan.boundaries.map((entry, index) => {
      const boundary = exactRecord(entry, ["id", "areaIds"], ["ownerAssignmentId"], `plan.boundaries[${index}]`);
      return { id: requiredString(boundary.id, "boundary.id"), areaIds: stringArray(boundary.areaIds, "boundary.areaIds"), ...(boundary.ownerAssignmentId === undefined ? {} : { ownerAssignmentId: requiredString(boundary.ownerAssignmentId, "boundary.ownerAssignmentId") }) };
    }),
    assignments: plan.assignments.map((entry, index) => {
      const assignment = exactRecord(entry, ["id", "agentInstanceId", "kind", "entity", "areaIds", "scopeIds", "coverage"], ["parentAssignmentId"], `plan.assignments[${index}]`);
      if (!Array.isArray(assignment.coverage)) throw new Error("assignment.coverage must be an array");
      const kind = requiredString(assignment.kind, "assignment.kind") as ReviewPlanInput["assignments"][number]["kind"];
      if (!["scout", "coordinator", "worker", "validator"].includes(kind)) throw new Error("assignment.kind is invalid");
      return {
        id: requiredString(assignment.id, "assignment.id"), agentInstanceId: requiredString(assignment.agentInstanceId, "assignment.agentInstanceId"), kind, entity: requiredString(assignment.entity, "assignment.entity"),
        ...(assignment.parentAssignmentId === undefined ? {} : { parentAssignmentId: requiredString(assignment.parentAssignmentId, "assignment.parentAssignmentId") }),
        areaIds: stringArray(assignment.areaIds, "assignment.areaIds"), scopeIds: stringArray(assignment.scopeIds, "assignment.scopeIds"),
        coverage: assignment.coverage.map((entry, coverageIndex) => { const claim = exactRecord(entry, ["areaId", "scopeId", "aspect"], [], `assignment.coverage[${coverageIndex}]`); return { areaId: requiredString(claim.areaId, "coverage.areaId"), scopeId: requiredString(claim.scopeId, "coverage.scopeId"), aspect: requiredString(claim.aspect, "coverage.aspect") }; }),
      };
    }),
  };
}

function parseReviewPlanWaves(value: unknown): ReviewRuntimePlanWaveInput[] {
  if (!Array.isArray(value)) throw new Error("waves must be an array");
  return value.map((entry, index) => {
    const wave = exactRecord(entry, ["wave_id", "review_round", "assignment_ids"], [], `waves[${index}]`);
    return { waveId: requiredString(wave.wave_id, "wave.wave_id"), reviewRound: positiveInteger(wave.review_round, "wave.review_round"), assignmentIds: stringArray(wave.assignment_ids, "wave.assignment_ids") };
  });
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>; const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || required.some((key) => !(key in record))) throw new Error(`${label} has missing or unsupported fields`);
  return record;
}

function positiveInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`); return value as number; }
function stringArray(value: unknown, label: string): string[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value.map((entry) => requiredString(entry, label)); }

function parseSpawn(input: Record<string, unknown>): ReviewAgentSpawnInput {
  const role = requiredString(input.role, "role") as ReviewAgentRole;
  if (!Object.values(ENTITY_ROLES).includes(role)) throw new Error("role is invalid");
  if (!Number.isSafeInteger(input.attempt) || (input.attempt as number) < 1) throw new Error("attempt must be a positive integer");
  if (!Array.isArray(input.scope_ids) || input.scope_ids.some((value) => typeof value !== "string" || value.trim() === "")) throw new Error("scope_ids must contain non-empty strings");
  return {
    taskId: requiredString(input.task_id, "task_id"), attempt: input.attempt as number, entity: requiredString(input.entity, "entity"), role,
    adapterId: requiredString(input.adapter_id, "adapter_id"), scopeIds: input.scope_ids as string[],
    ...(optionalString(input.idempotency_key) === undefined ? {} : { idempotencyKey: optionalString(input.idempotency_key)! }),
    ...(optionalString(input.task) === undefined ? {} : { task: optionalString(input.task)! }),
    ...(optionalString(input.skill_ref) === undefined ? {} : { skillRef: optionalString(input.skill_ref)! }),
    ...(optionalString(input.wave_id) === undefined ? {} : { waveId: optionalString(input.wave_id)! }),
    ...(Number.isSafeInteger(input.max_runtime_ms) && (input.max_runtime_ms as number) > 0 ? { maxRuntimeMs: input.max_runtime_ms as number } : {}),
  };
}

function readTool(name: string, description: string, required: readonly string[], properties: Record<string, unknown>, work: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>): InteractiveTool {
  return { definition: { name, description, risk: "read", inputSchema: { type: "object", additionalProperties: false, required, properties } }, invoke: async (input, context) => { try { return { output: JSON.stringify(await work(input, context?.signal), null, 2), isError: false }; } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; } } };
}

function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() !== "" ? value : undefined; }
function assertContained(root: string, candidate: string, label: string): void { const relative = path.relative(root, candidate); if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must be inside ${root}`); }
function remainingDeadline(state: ReviewAgentRunState, now: number): number { return Math.max(1, state.config.runCeilings.elapsedDeadlineMs - Math.max(0, now - Date.parse(state.createdAt))); }
function redactStatus(value: Awaited<ReturnType<ReviewAgentController["status"]>>): unknown {
  if (value === undefined || !("schemaVersion" in value)) return value;
  const { results, ...status } = value;
  return { ...status, resultIds: Object.keys(results), capabilityProfile: HOST_CAPABILITY_PROFILE };
}
