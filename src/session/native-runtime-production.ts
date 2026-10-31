import { createNativeRoutingClassifier } from "./native-classifier";
import { wireModelIdentity, type NativeModelBinding } from "./model-identity";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { buildShellHookRuntime } from "../commands/agent-hooks";
import { makeProvider } from "../harness/provider/make-provider";
import { resolveProviderModelParamsByName } from "../commands/providers";
import { envWithSavedApiKeys, loadShellConfig } from "../lib/shell-config";
import { resolveProjectRoot } from "./paths";
import { detectSandboxLauncher, sandboxProfileFromPolicy, wrapWithSandbox, type SandboxProfile } from "../harness/process/sandbox";
import { resolveShellEnv } from "../harness/process/shell-spawn";
import { superviseSpawnedProcess, type BackgroundSpawner } from "../harness/tool/builtin/background-job-registry";
import type { PolicyProfile } from "../harness/policy/types";
import type { Control, ProtocolResult } from "../remote-control/protocol";
import { createNativeSessionRuntime, NativeRuntimeError, type NativeRuntimeOptions, type NativeSessionRuntime } from "./native-runtime";
import { configureNativeSessionServices, createNativeSessionServices, NativeServicesSetupError, type NativeLocallyApprovedServices, type NativeSessionServicesOptions } from "./native-services-production";
import { loadMcpServers } from "../mcp-servers/config";
import { loadTrustStore, requiresApproval } from "../mcp-servers/trust";
import { createNativeProviderServices } from "./native-provider-bindings";

export interface ProductionNativeRuntimeOptions {
  cwd: string;
  configDir?: string;
  sessionId: string;
  profile: PolicyProfile;
  providerId: string;
  modelId: string;
  allowedTools: readonly string[];
  maxToolCalls: number;
  maxRounds: number;
  availability?: Control["RoutingAvailability"];
  modelBindings?: readonly NativeModelBinding[];
  /** Explicit local constructor injection for deterministic tests; never deserialized from Hub or config. */
  providerFactory?: typeof makeProvider;
  approve?: NativeRuntimeOptions["approve"];
  askUser?: NativeRuntimeOptions["askUser"];
  /** Explicit local-owner approval of a session bus binding (allowed checkout paths and peer sessions); never decoded from Hub or remote config. Absent: no bus. */
  locallyApprovedBus?: NonNullable<NativeLocallyApprovedServices["bus"]>;
}
/** The locally approved HTTP MCP servers for this checkout: the operator's existing configuration and trust store, nothing new.
 * Only enabled streamable-HTTP entries without credentials or OAuth that need no further approval; stdio launch and network-denying profiles bind nothing. */
export function locallyApprovedHttpMcp(cwd: string, configDir: string | undefined, profile: PolicyProfile): { name: string; url: string }[] {
  if (profile.defaults.network === "deny") return [];
  const approvals = loadTrustStore(configDir);
  return loadMcpServers({ cwd, ...(configDir === undefined ? {} : { configDir }) }).servers.filter((server) => server.enabled !== false && server.command === undefined && typeof server.url === "string"
    && (server.type === undefined || server.type === "http") && (server.oauth === undefined || server.oauth === false) && Object.keys(server.headers ?? {}).length === 0
    && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(server.name) && !requiresApproval(server, approvals)).flatMap((server) => {
    let url: URL;
    try { url = new URL(server.url!); } catch { return []; }
    return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "" && url.hash === "" ? [{ name: server.name, url: url.href }] : [];
  });
}
/**
 * The contained profile of the owned shadow-Git process. Its private repository lives in the native session data dir, which the
 * session profile neither lets a process write nor, by default (`~/.local/share/keryx`), read. So: writes go only to that
 * repository and to the owned checkout it restores into (none for a read-only profile, never the session tmp), the one secret
 * read-deny entry that contains the repository is dropped and every other one kept, and there is no network.
 * Seatbelt matches resolved paths, so every root is the canonical one.
 */
export function ownedGitSandboxProfile(base: SandboxProfile, input: { cwd: string; gitDir: string }): SandboxProfile {
  const canonical = (target: string): string => { try { return realpathSync(target); } catch { return resolve(target); } };
  const gitDir = canonical(input.gitDir);
  const contains = (parent: string): boolean => gitDir === parent || gitDir.startsWith(`${parent}${sep}`);
  return { mode: base.mode === "danger-full-access" ? base.mode : "workspace-write", network: "off", allowedDomains: [], required: base.required,
    writableRoots: [...(base.mode === "read-only" ? [] : [canonical(input.cwd)]), gitDir], readDenyList: base.readDenyList.filter((entry) => !contains(canonical(entry))) };
}
/** Session-owned MCP/bus owners are bound only from local approval; with none, the plain services report setup-required. */
async function productionSessionServices(options: ProductionNativeRuntimeOptions, context: NativeSessionServicesOptions) {
  const httpMcp = locallyApprovedHttpMcp(options.cwd, options.configDir, options.profile);
  const bus = options.locallyApprovedBus;
  if (httpMcp.length === 0 && bus === undefined) return createNativeSessionServices(context);
  const approved = new Set(httpMcp.map((entry) => `${entry.name}\n${entry.url}`));
  const owner = context.identity();
  const locallyApproved: NativeLocallyApprovedServices = { ...(httpMcp.length === 0 ? {} : { httpMcp }), ...(bus === undefined ? {} : { bus }),
    beforeConnect: async (request, signal) => {
      signal.throwIfAborted();
      const allowed = request.kind === "mcp-http" ? approved.has(`${request.name}\n${request.url}`) : bus !== undefined && request.projectId === owner.projectId && request.checkoutId === owner.checkoutId;
      if (!allowed) throw new NativeRuntimeError("native-service-not-locally-approved");
    } };
  try { return await configureNativeSessionServices({ ...context, locallyApproved }, AbortSignal.timeout(15_000)); }
  catch (cause) {
    // An unreachable approved server degrades to the unbound services only when every partial connection was proven closed.
    if (cause instanceof NativeServicesSetupError && cause.cleanupStopped) return createNativeSessionServices(context);
    throw cause;
  }
}
/** Production local composition. Credentials and executable configuration never arrive from Hub. */
export async function assembleNativeSessionRuntime(options: ProductionNativeRuntimeOptions): Promise<ProtocolResult<NativeSessionRuntime>> {
  const fail = (code: string): ProtocolResult<never> => ({ ok: false, error: { code, message: code } });
  if (options.providerId === "fake" || options.modelId.length === 0) return fail("provider-not-connected");
  if (!Number.isSafeInteger(options.maxToolCalls) || options.maxToolCalls < 1 || !Number.isSafeInteger(options.maxRounds) || options.maxRounds < 1) return fail("invalid-budget");
  const launcher = detectSandboxLauncher();
  if (options.profile.requiredControls.isolation === "required-fail-closed" && !launcher.available) return fail("containment-unavailable");
  const saved = loadShellConfig(options.configDir);
  const env = envWithSavedApiKeys(process.env, options.configDir);
  const resolveProvider = (providerId: string, modelId: string) => {
    if (providerId !== options.providerId || modelId !== options.modelId) {
      const wire = wireModelIdentity(providerId, modelId);
      const allowed = options.availability?.candidates.some((item) => item.providerId === wire.providerId && item.modelId === wire.modelId && item.available);
      if (!allowed) throw new NativeRuntimeError("candidate-unavailable");
    }
    const provider = (options.providerFactory ?? makeProvider)(providerId, modelId, { fetch: globalThis.fetch, env,
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
      ...(providerId === saved.provider && saved.baseUrl !== undefined ? { baseUrl: saved.baseUrl } : {}),
    });
    // The factory's offline fallback (no credential, unregistered name) reports "fake-provider"; it is never a connected coding provider.
    if (["fake", "fake-provider"].includes(provider.describe().descriptor.providerId)) throw new NativeRuntimeError("provider-not-connected");
    return provider;
  };
  try {
    const provider = resolveProvider(options.providerId, options.modelId);
    const hook = buildShellHookRuntime({ projectRoot: resolveProjectRoot(options.cwd), sessionId: options.sessionId,
      runId: randomUUID(), interactive: true, profileId: options.profile.profileId,
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
    });
    const spawner: BackgroundSpawner = async (command, cwd) => {
      const localEnv = await resolveShellEnv(options.configDir);
      let args = ["/bin/sh", "-c", command];
      const currentLauncher = detectSandboxLauncher();
      const sandbox = sandboxProfileFromPolicy({ policy: options.profile, cwd, tmpDir: tmpdir(), home: homedir() });
      if (sandbox.required || currentLauncher.available) {
        if (!currentLauncher.available) throw new NativeRuntimeError("containment-unavailable");
        const wrapped = wrapWithSandbox({ path: "/bin/sh", argv: ["sh", "-c", command], cwd, env: localEnv }, sandbox,
          { platform: process.platform, ...(currentLauncher.path === undefined ? {} : { bwrapPath: currentLauncher.path }) });
        if (!wrapped.ok) throw new NativeRuntimeError("containment-refused");
        args = [wrapped.command.path, ...wrapped.command.argv.slice(1)];
      }
      const processHandle = Bun.spawn(args, { cwd, env: localEnv, stdout: "pipe", stderr: "pipe", detached: true });
      return superviseSpawnedProcess(processHandle, { kill(signal) {
        try { process.kill(-processHandle.pid, signal); }
        catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause; }
      } });
    };
    const gitEnvSource = await resolveShellEnv(options.configDir);
    const spawnOwnedGit: NonNullable<NativeRuntimeOptions["spawnOwnedGit"]> = (request) => {
      const privateEnv = { PATH: gitEnvSource.PATH ?? process.env.PATH ?? "", HOME: homedir(), TMPDIR: tmpdir(), LANG: "C.UTF-8",
        GIT_DIR: request.repo.gitDir, GIT_WORK_TREE: request.repo.workTree, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
      const argv = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...request.args];
      let command = ["git", ...argv]; const currentLauncher = detectSandboxLauncher();
      const sandbox = ownedGitSandboxProfile(sandboxProfileFromPolicy({ policy: options.profile, cwd: options.cwd, tmpDir: tmpdir(), home: homedir() }), { cwd: options.cwd, gitDir: request.repo.gitDir });
      if (sandbox.required || currentLauncher.available) {
        if (!currentLauncher.available) throw new NativeRuntimeError("containment-unavailable");
        const wrapped = wrapWithSandbox({ path: "git", argv: ["git", ...argv], cwd: options.cwd, env: privateEnv }, sandbox,
          { platform: process.platform, ...(currentLauncher.path === undefined ? {} : { bwrapPath: currentLauncher.path }) });
        if (!wrapped.ok) throw new NativeRuntimeError("containment-refused"); command = [wrapped.command.path, ...wrapped.command.argv.slice(1)];
      }
      request.signal.throwIfAborted();
      const child = Bun.spawn(command, { cwd: options.cwd, env: privateEnv, stdin: request.stdin === undefined ? "ignore" : new Blob([request.stdin]), stdout: "pipe", stderr: "pipe", detached: true });
      return superviseSpawnedProcess(child, { kill(signal) { try { process.kill(-child.pid, signal); } catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause; } } });
    };
    const classifier = createNativeRoutingClassifier({ cwd: options.cwd, ...(options.configDir === undefined ? {} : { configDir: options.configDir }), env,
      availability: (config) => runtime.routing(config).availability(), bindings: () => runtime.modelBindings(), providerFactory: resolveProvider });
    const runtime: NativeSessionRuntime = createNativeSessionRuntime({ cwd: options.cwd, ...(options.configDir === undefined ? {} : { configDir: options.configDir }), provider, providerId: options.providerId, modelId: options.modelId,
      nativeClassifier: classifier, spawnOwnedGit, ...(options.modelBindings === undefined ? {} : { modelBindings: options.modelBindings }),
      // Configured provider list/test over the same local credentials and endpoints as the coding provider; selection stays the native owner's.
      servicesFactory: (context) => productionSessionServices(options, { ...context, providers: createNativeProviderServices({ ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
        env, fetch: globalThis.fetch, candidates: context.routingAvailability().candidates, bindings: runtime.modelBindings(),
        ...(saved.provider !== undefined && saved.baseUrl !== undefined ? { savedBaseUrl: { providerId: saved.provider, baseUrl: saved.baseUrl } } : {}) }) }),
      policy: structuredClone(options.profile), allowedTools: options.allowedTools, spawner, resolveProvider,
      allowSubagents: options.allowedTools.includes("spawn_subagent") && options.profile.defaults.delegate !== "deny",
      ...(options.approve === undefined ? {} : { approve: options.approve }), ...(options.askUser === undefined ? {} : { askUser: options.askUser }),
      ...(options.availability === undefined ? {} : { availability: options.availability }),
      deps: { maxRounds: options.maxRounds, maxToolCalls: options.maxToolCalls,
        ...(() => { const params = resolveProviderModelParamsByName(options.providerId, saved, options.configDir); return params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }; })(),
        ...(hook === undefined ? {} : { hooks: hook }),
      },
    }); return { ok: true, value: runtime };
  } catch (cause) { return fail(cause instanceof NativeRuntimeError ? cause.code : "local-runtime-setup-failed"); }
}
