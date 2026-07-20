// `keryx harness run` CLI command (flow 020, T6 / AC4).
//
// `harnessCommand` parses `run --provider <fake|anthropic|ollama> --model <m>
// [--base-url <url>] "<prompt>"`, selects the provider, assembles the W7
// `runOffline` loop with real (or injected) clock/id deps + a read-only policy
// profile, and prints ONE JSON blob `{events, text, completion, evidence}` as
// its LAST `console.log`.
//
// Fail-closed posture: the `anthropic` provider without `ANTHROPIC_API_KEY`
// (read from `deps.env ?? process.env`) prints a clear message and RETURNS
// before any network or `runOffline` call. Any thrown error from a live run is
// caught into a structured (non-throwing) result. This command NEVER persists
// managed flow state.
//
// Determinism: `fetch`/`clock`/`idSeq`/`env` are injectable via `deps` so a test
// invocation stays fully offline; a real CLI invocation supplies none and falls
// back to `globalThis.fetch` / wall-clock / a uuid sequence / `process.env`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { HarnessConfig } from "../harness/config";
import { makeProvider } from "../harness/provider/make-provider";
import type { NormalizedEvent, ProviderPort } from "../harness/provider/types";
import type { PolicyProfile } from "../harness/policy/types";
import { type RunDeps, type RunResult, runOffline } from "../harness/run/run";
import { ToolRegistry } from "../harness/tool/registry";
import type { ToolExecutorPort, ToolInvocation, ToolResult } from "../harness/tool/types";
import type { HarnessRunInput } from "../harness/types";
// R2 library modules the exec/extension/wave subcommands COMPOSE (reuse-only).
import { runContainedProcess } from "../harness/process/executor";
import type {
  ContainedCommand,
  ProcessAdapter,
  RunContainedProcessInput,
} from "../harness/process/executor";
import { RealProcessAdapter } from "../harness/process/real-process-adapter";
import { defaultSandboxProfile } from "../harness/process/sandbox/profile";
import type { SandboxProfile } from "../harness/process/sandbox/profile";
import { resolveSandboxAdapter } from "../harness/process/sandbox/detect";
import { setupNetworkRun } from "../harness/process/sandbox/network-run";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { BudgetReservation, ParentRemainingBudget } from "../harness/child/isolation";
import type { ToolRisk } from "../harness/tool/types";
import { registerExtension } from "../harness/extension/registry";
import type { CapabilityGrant, ExtensionManifest } from "../harness/extension/registry";
import { dispatchExtension, evaluateExtensionGrant } from "../harness/extension/execute";
import type { DispatchArtifactRef, DispatchExtensionInput } from "../harness/extension/execute";
import { planExtensionWave } from "../harness/extension/bound-wave";
import type { ExtensionWaveTask, PlanExtensionWaveInput } from "../harness/extension/bound-wave";
import { checkApproval } from "../harness/mutation/approval";
import type { ApprovalCheckInput } from "../harness/mutation/approval";
import type { ParsedChildResult } from "../harness/child/contract";
import type { Provenance } from "../harness/session/types";

/** realpath a path, falling back to the input if it cannot be resolved. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Build the default OS-contained real-subprocess adapter for `keryx harness
 * exec`: the v1 workspace-write + network-off sandbox around a real spawn.
 * Writable roots (cwd + session tmp) are canonicalized so a symlinked temp path
 * (macOS /var, /tmp) is matched by the launcher. Fails closed when the launcher
 * is missing unless KERYX_SANDBOX_ALLOW_UNSANDBOXED=1; opts out entirely on
 * KERYX_DANGEROUSLY_DISABLE_SANDBOX=1.
 */
function buildDefaultShellAdapter(
  cwd: string,
  env: Record<string, string | undefined>,
  profileOverride?: SandboxProfile,
): ProcessAdapter {
  const real = new RealProcessAdapter({ allowRealSubprocess: true });
  let profile =
    profileOverride ?? defaultSandboxProfile(canonicalPath(cwd), canonicalPath(tmpdir()), homedir());
  if (profileOverride === undefined && env.KERYX_DANGEROUSLY_DISABLE_SANDBOX === "1") {
    profile = { ...profile, mode: "danger-full-access", required: false };
  }
  const { adapter } = resolveSandboxAdapter(profile, real, {
    platform: process.platform,
    env,
    failIfUnavailable: env.KERYX_SANDBOX_ALLOW_UNSANDBOXED !== "1",
  });
  return adapter;
}

/**
 * Spec injected into `keryx harness extension` (a test injects it; a real CLI
 * invocation reads it from `--spec <path>` via `readFileSync`). Carries the
 * registry inputs, the optional escalation-grant inputs (fed to
 * `evaluateExtensionGrant` ONLY when `requestedCapabilities` is present), and
 * every field `dispatchExtension` needs, plus an optional `rawChildResult`.
 */
export interface ExtensionCliSpec {
  // Injected spec: an index signature keeps the frozen tests' `Record<string,
  // unknown>` spec objects assignable via their `as HarnessCommandDeps` cast.
  [key: string]: unknown;
  extensionId: string;
  manifest?: ExtensionManifest;
  capabilityGrant?: CapabilityGrant;
  requestedCapabilities?: string[];
  policyDecision?: "allow" | "ask" | "deny";
  provenance?: Provenance;
  approval?: ApprovalCheckInput;
  reservedBudget: BudgetReservation;
  parentRunId: string;
  sessionId: string;
  attempt: { attemptId: string; number: number };
  branchId: string;
  contextManifestHash: string;
  policyFingerprint: string;
  canonicalContractVersion: string;
  task: { title: string; description: string };
  acceptanceCriteria: string[];
  dispatchArtifact: DispatchArtifactRef;
  resultArtifact: DispatchArtifactRef;
  rawChildResult?: string | ParsedChildResult;
}

/** One task inside a {@link WaveCliSpec}: registry inputs + `ExtensionWaveTask` fields. */
export interface WaveCliTaskSpec {
  // Injected spec: an index signature keeps the frozen tests' `Record<string,
  // unknown>` task objects assignable via their `as HarnessCommandDeps` cast.
  [key: string]: unknown;
  taskId: string;
  dependsOn: string[];
  extensionId: string;
  manifest?: ExtensionManifest;
  capabilityGrant?: CapabilityGrant;
  budgetRequest: BudgetReservation;
  cancelled?: boolean;
  sessionId: string;
  attempt: { attemptId: string; number: number };
  branchId: string;
  contextManifestHash: string;
  policyFingerprint: string;
  task: { title: string; description: string };
  acceptanceCriteria: string[];
  dispatchArtifact: DispatchArtifactRef;
  resultArtifact: DispatchArtifactRef;
}

/** Spec injected into `keryx harness wave` (or read from `--spec <path>`). */
export interface WaveCliSpec {
  tasks: WaveCliTaskSpec[];
  maxConcurrency: number;
  parentRemaining: ParentRemainingBudget;
  parentRunId: string;
  canonicalContractVersion: string;
}

/** Injected, all-optional dependencies keeping a test run offline + deterministic. */
export interface HarnessCommandDeps {
  fetch?: typeof fetch;
  clock?: () => string;
  idSeq?: () => string;
  env?: Record<string, string | undefined>;
  /** Injected FAKE process adapter — keeps `exec` offline (never a real spawn). */
  processAdapter?: ProcessAdapter;
  /** Injected extension spec — keeps `extension` off the filesystem. */
  extensionSpec?: ExtensionCliSpec;
  /** Injected wave spec — keeps `wave` off the filesystem. */
  waveSpec?: WaveCliSpec;
}

/** Resolve the shared runtime deps (env/clock/idSeq) with the run-path fallback. */
function resolveRuntime(deps?: HarnessCommandDeps): {
  env: Record<string, string | undefined>;
  clock: () => string;
  idSeq: () => string;
} {
  const env = deps?.env ?? process.env;
  const clock = deps?.clock ?? (() => new Date().toISOString());
  let idCounter = 0;
  const idSeq = deps?.idSeq ?? (() => `${randomUUID()}-${idCounter++}`);
  return { env, clock, idSeq };
}

/**
 * A `trusted-local` profile with `defaults.shell: "allow"` — the deterministic
 * "approved argv and environment allowlist" posture the frozen
 * SC_R04_SHELL_CONTAINMENT scenario describes (mirrors the shell-allow fixture
 * in `executor.test.ts`). Only reached behind the `exec` opt-in gate.
 */
function shellAllowProfile(): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "monitored-trusted-local",
    profileVersion: "1.0.0-shell-contained",
    fingerprint: sha256Hex("monitored-trusted-local:1.0.0-shell-contained"),
    trustMode: "trusted-local",
    defaults: { read: "allow", write: "ask", shell: "allow", network: "ask", delegate: "ask" },
    requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
  };
}

/** The structured result the command prints as its final JSON blob. */
interface StructuredResult {
  events: NormalizedEvent[];
  text: string;
  completion: unknown;
  evidence: string[];
}

interface ParsedArgs {
  provider: string;
  model: string;
  baseUrl?: string;
  prompt: string;
}

/** The usage text, printed on an unknown subcommand or invalid args. */
const USAGE = [
  'Usage: keryx harness run --provider <fake|anthropic|ollama> --model <m> [--base-url <url>] "<prompt>"',
  "       keryx harness exec [--allow-env KEY]... [--max-runtime-ms N] [--allow-real-subprocess] -- <path> [args...]",
  "       keryx harness extension --spec <path>",
  "       keryx harness wave --spec <path>",
].join("\n");

function sha256Hex(input: string): string {
  // Small stable fingerprint for the read-only profile — node built-in only.
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** A read-only-review profile (defaults.read = "allow"), per policy-profile.schema.json. */
function readOnlyProfile(): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "read-only-review",
    profileVersion: "1.0.0",
    fingerprint: sha256Hex("read-only-review:1.0.0"),
    trustMode: "read-only",
    defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
    requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
  };
}

/**
 * A minimal tool executor. Release 0 CLI runs register no tools, so a model that
 * requests one produces an unregistered call the run loop skips; this executor is
 * the fail-closed floor if one is ever reached (it never succeeds silently).
 */
const denyingExecutor: ToolExecutorPort = {
  invoke: async (invocation: ToolInvocation): Promise<ToolResult> => {
    throw new Error(`no tool executor is configured for the harness CLI: ${invocation.call.toolName}`);
  },
};

/** Parse `run --provider <p> --model <m> [--base-url <url>] "<prompt>"`. */
function parseArgs(args: string[]): ParsedArgs {
  let provider = "";
  let model = "";
  let baseUrl: string | undefined;
  const positional: string[] = [];

  // args[0] is the "run" subcommand.
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      provider = args[++i] ?? "";
    } else if (arg === "--model") {
      model = args[++i] ?? "";
    } else if (arg === "--base-url") {
      baseUrl = args[++i];
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const parsed: ParsedArgs = { provider, model, prompt: positional.join(" ") };
  if (baseUrl !== undefined) parsed.baseUrl = baseUrl;
  return parsed;
}

/** Fold the terminal `RunResult` into the printed structured result. */
function toStructured(result: RunResult): StructuredResult {
  const text = result.events
    .filter((event) => event.kind === "text_delta")
    .map((event) => event.text ?? "")
    .join("");
  return {
    events: result.events,
    text,
    completion: result.output.gate,
    evidence: result.output.artifacts,
  };
}

export async function harnessCommand(args: string[], deps?: HarnessCommandDeps): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "exec") {
    await harnessExec(args, deps);
    return;
  }
  if (subcommand === "extension") {
    harnessExtension(args, deps);
    return;
  }
  if (subcommand === "wave") {
    harnessWave(args, deps);
    return;
  }
  if (subcommand !== "run") {
    console.log(USAGE);
    return;
  }

  const { provider, model, baseUrl, prompt } = parseArgs(args);

  // UX guard (flow 021, T5 / AC4): an invalid/empty --provider or an empty
  // prompt prints the usage line and returns BEFORE building input or running
  // runOffline — never a blocked/failed structured run result.
  const validProviders = new Set(["fake", "anthropic", "ollama"]);
  if (!validProviders.has(provider) || prompt.length === 0) {
    console.log(USAGE);
    return;
  }

  const env = deps?.env ?? process.env;
  const clock = deps?.clock ?? (() => new Date().toISOString());
  let idCounter = 0;
  const idSeq = deps?.idSeq ?? (() => `${randomUUID()}-${idCounter++}`);
  const fetchImpl = deps?.fetch ?? globalThis.fetch;

  // Fail-closed BEFORE any construction/network: the anthropic provider aborts
  // the whole command (prints + returns) when no credential is present — this
  // command-level abort is distinct from the shell's fake fallback, so it stays
  // here rather than in the shared factory.
  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      console.log(
        "ANTHROPIC_API_KEY is not set: the anthropic provider is required to have a credential and fails closed (no network was contacted).",
      );
      return;
    }
  }

  // Construction delegated to the shared factory (review-polish item B). "fake"
  // and any unrecognized name yield the offline W6 replay provider (no
  // transcripts wired in the CLI, so a missing-fixture match surfaces as a
  // caught structured result).
  const providerPort: ProviderPort = makeProvider(provider, model, {
    fetch: fetchImpl,
    env,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  const input: HarnessRunInput = {
    schemaVersion: 1,
    request: prompt,
    projectRoot: process.cwd(),
    role: "build",
    policy: "read-only-review",
    budget: { maxSeconds: 60, maxToolCalls: 5, maxRetries: 1 },
    provider,
    model,
    // A local-only startup precondition (never schema-validated); its presence
    // lets startup proceed so the selected provider actually streams.
    credentialRef: provider === "anthropic" ? "anthropic-key" : `${provider}-local`,
  };
  const config: HarnessConfig = {
    schemaVersion: 1,
    enabled: true,
    defaultRole: "build",
    defaultProvider: provider,
    defaultModel: model,
    policyProfile: "read-only-review",
    limits: { maxRunSeconds: 300, maxConcurrentChildren: 1, maxToolOutputBytes: 65_536, maxRetries: 1 },
  };
  const runDeps: RunDeps = {
    provider: providerPort,
    toolRegistry: new ToolRegistry(),
    toolExecutor: denyingExecutor,
    policyProfile: readOnlyProfile(),
    clock,
    idSeq,
    interactive: false,
  };

  let structured: StructuredResult;
  try {
    const result = await runOffline(input, config, runDeps);
    structured = toStructured(result);
  } catch (error) {
    // Never let a live/replay failure escape as an uncaught exception: fold it
    // into a structured, non-throwing result.
    structured = {
      events: [],
      text: "",
      completion: { status: "failed", passed: false, reason: error instanceof Error ? error.message : String(error) },
      evidence: [],
    };
  }

  console.log(JSON.stringify(structured));
}

// ---------------------------------------------------------------------------
// exec — a contained real subprocess, fail-closed and opt-in.
// ---------------------------------------------------------------------------

/** The fixed parent runtime ceiling (ms) a `--max-runtime-ms` request is bounded by. */
const EXEC_PARENT_REMAINING_MS = 60_000;
/** The default per-command runtime reservation (ms) when `--max-runtime-ms` is omitted. */
const EXEC_DEFAULT_RUNTIME_MS = 30_000;
/** A sensible default output byte cap the contained run is measured against. */
const EXEC_OUTPUT_LIMIT_BYTES = 1_000_000;

interface ParsedExecArgs {
  allowEnvKeys: string[];
  maxRuntimeMs?: number;
  allowRealSubprocess: boolean;
  /** `--allowed-domains a,b,c` ⇒ restricted network via the loopback proxy. */
  allowedDomains?: string[];
  commandPath: string;
  commandArgs: string[];
}

/** Parse `exec [--allow-env KEY]... [--max-runtime-ms N] [--allow-real-subprocess] -- <path> [args...]`. */
function parseExecArgs(args: string[]): ParsedExecArgs {
  const allowEnvKeys: string[] = [];
  let maxRuntimeMs: number | undefined;
  let allowRealSubprocess = false;
  let allowedDomains: string[] | undefined;
  let commandPath = "";
  let commandArgs: string[] = [];

  // args[0] is the "exec" subcommand; scan flags until the `--` terminator.
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      commandPath = args[i + 1] ?? "";
      commandArgs = args.slice(i + 2);
      break;
    }
    if (arg === "--allow-env") {
      const key = args[++i];
      if (key !== undefined) allowEnvKeys.push(key);
    } else if (arg === "--max-runtime-ms") {
      const raw = args[++i];
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) maxRuntimeMs = parsed;
    } else if (arg === "--allow-real-subprocess") {
      allowRealSubprocess = true;
    } else if (arg === "--allowed-domains") {
      const raw = args[++i];
      if (raw !== undefined) {
        allowedDomains = raw.split(",").map((d) => d.trim()).filter((d) => d.length > 0);
      }
    }
  }

  const parsed: ParsedExecArgs = { allowEnvKeys, allowRealSubprocess, commandPath, commandArgs };
  if (maxRuntimeMs !== undefined) parsed.maxRuntimeMs = maxRuntimeMs;
  if (allowedDomains !== undefined) parsed.allowedDomains = allowedDomains;
  return parsed;
}

/**
 * `keryx harness exec` — run one command through the reused, fail-closed
 * `runContainedProcess` decision core. Offline+deterministic when a
 * `processAdapter` is injected; fail-closed refusal when neither an injected
 * adapter nor the `--allow-real-subprocess` (or `KERYX_ALLOW_REAL_SUBPROCESS=1`)
 * opt-in is present — no adapter is constructed and nothing is spawned. Prints
 * ONE JSON blob as its last `console.log`; NEVER persists flow state (D-02) and
 * never logs env values.
 */
async function harnessExec(args: string[], deps?: HarnessCommandDeps): Promise<void> {
  const { env, clock, idSeq } = resolveRuntime(deps);
  const { allowEnvKeys, maxRuntimeMs, allowRealSubprocess, allowedDomains, commandPath, commandArgs } =
    parseExecArgs(args);

  // Fail-closed opt-in gate: with no injected adapter and no explicit real-
  // subprocess authority, refuse BEFORE constructing any adapter or spawning.
  const allowReal = allowRealSubprocess || env.KERYX_ALLOW_REAL_SUBPROCESS === "1";
  if (deps?.processAdapter === undefined && !allowReal) {
    console.log(
      "keryx harness exec refuses to spawn a real subprocess without --allow-real-subprocess " +
        "(or KERYX_ALLOW_REAL_SUBPROCESS=1); no process was started.",
    );
    return;
  }

  const cwd = process.cwd();
  // Only the explicitly allowlisted env KEYS are forwarded, and only when they
  // resolve to a value; env VALUES are never logged (secret-safety).
  const commandEnv: Record<string, string> = {};
  for (const key of allowEnvKeys) {
    const value = env[key];
    if (value !== undefined) commandEnv[key] = value;
  }

  // Restricted-network opt-in: `--allowed-domains a,b` or
  // KERYX_SANDBOX_ALLOWED_DOMAINS. Starts the loopback allowlist proxy (worker),
  // points the contained command at it via HTTP(S)_PROXY, and constrains the OS
  // sandbox to allow only that loopback socket. Only for real (non-injected) runs.
  const envDomains = env.KERYX_SANDBOX_ALLOWED_DOMAINS
    ? env.KERYX_SANDBOX_ALLOWED_DOMAINS.split(",").map((d) => d.trim()).filter((d) => d.length > 0)
    : undefined;
  const restrictedDomains = allowedDomains ?? envDomains;
  let effectiveAllowEnvKeys = allowEnvKeys;
  let profileOverride: SandboxProfile | undefined;
  let closeNetwork: () => Promise<void> = async () => {};
  if (restrictedDomains !== undefined && deps?.processAdapter === undefined) {
    const baseProfile = defaultSandboxProfile(canonicalPath(cwd), canonicalPath(tmpdir()), homedir());
    const net = await setupNetworkRun({
      ...baseProfile,
      network: "restricted",
      allowedDomains: restrictedDomains,
    });
    profileOverride = net.profile;
    closeNetwork = net.close;
    for (const [key, value] of Object.entries(net.envAdditions)) {
      commandEnv[key] = value;
    }
    effectiveAllowEnvKeys = [...allowEnvKeys, ...Object.keys(net.envAdditions)];
  }

  const command: ContainedCommand = {
    path: commandPath,
    argv: [commandPath, ...commandArgs],
    env: commandEnv,
    cwd,
  };

  // The guard's traversal check is rooted at the command path's filesystem root
  // so an approved absolute system binary (e.g. /bin/echo) is in-root; the shell-
  // metachar / credential / env-allowlist gates remain the real containment.
  const worktreeRoot = path.parse(path.resolve(cwd, commandPath)).root || cwd;

  const budget: BudgetReservation = {
    reservationId: idSeq(),
    maxRuntimeMs: maxRuntimeMs ?? EXEC_DEFAULT_RUNTIME_MS,
  };
  const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: EXEC_PARENT_REMAINING_MS };

  // Default (non-injected) real spawns are OS-contained: workspace-write
  // (writable = cwd + session tmp) + network OFF, fail-closed when the launcher
  // is missing. Set KERYX_DANGEROUSLY_DISABLE_SANDBOX=1 to opt out, or
  // KERYX_SANDBOX_ALLOW_UNSANDBOXED=1 to run unsandboxed when no launcher exists.
  const adapter: ProcessAdapter =
    deps?.processAdapter ?? buildDefaultShellAdapter(cwd, env, profileOverride);

  const runInput: RunContainedProcessInput = {
    command,
    allowlist: {
      worktreeRoot,
      envAllowlist: effectiveAllowEnvKeys,
      profile: shellAllowProfile(),
      interactive: true,
      scanAvailable: true,
      risk: "shell" satisfies ToolRisk,
    },
    budget,
    parentRemaining,
    outputLimitBytes: EXEC_OUTPUT_LIMIT_BYTES,
    adapter,
  };

  let output: Record<string, unknown>;
  try {
    const outcome = runContainedProcess(runInput, { clock, idSeq });
    if (outcome.kind === "completed") {
      output = {
        outcome: {
          kind: "completed",
          ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
        },
        receipt: outcome.receipt,
        evidenceRefs: outcome.evidenceRefs,
      };
    } else if (outcome.kind === "blocked") {
      output = { outcome: { kind: "blocked", reason: outcome.reason } };
    } else {
      output = { outcome: { kind: outcome.kind }, receipt: outcome.receipt };
    }
  } finally {
    // Always tear down the proxy worker, even if the run threw.
    await closeNetwork();
  }
  console.log(JSON.stringify(output));
}

// ---------------------------------------------------------------------------
// extension — a single registered+granted extension dispatch, spec-driven.
// ---------------------------------------------------------------------------

/** Read a spec from `--spec <path>` (real CLI path only; tests inject the spec). */
function readSpecArg<T>(args: string[]): T {
  let specPath: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--spec") {
      specPath = args[i + 1];
      break;
    }
  }
  if (specPath === undefined) {
    throw new Error("keryx harness: a --spec <path> argument is required when no spec is injected.");
  }
  return JSON.parse(readFileSync(specPath, "utf8")) as T;
}

/** The default STATUS-first child reply parsed when the spec supplies none. */
const DEFAULT_CHILD_RESULT = "STATUS: DONE\nExtension completed within its granted capabilities.";

/**
 * `keryx harness extension` — register, (optionally) evaluate an escalation
 * grant, then dispatch a single extension, all via the reused R2 library.
 * Fail-closed: an unregistered spec prints `{registration}` with NO dispatch; a
 * denied escalation prints `{registration, grantEvaluation}` with NO dispatch.
 * Prints ONE JSON blob; NEVER persists flow state (D-02).
 */
function harnessExtension(args: string[], deps?: HarnessCommandDeps): void {
  const { clock, idSeq } = resolveRuntime(deps);
  const spec = deps?.extensionSpec ?? readSpecArg<ExtensionCliSpec>(args);

  const registration = registerExtension({
    extensionId: spec.extensionId,
    ...(spec.manifest !== undefined ? { manifest: spec.manifest } : {}),
    ...(spec.capabilityGrant !== undefined ? { capabilityGrant: spec.capabilityGrant } : {}),
  });
  if (!registration.ok) {
    console.log(JSON.stringify({ registration }));
    return;
  }

  // Only when the spec REQUESTS capabilities do we run the escalation gate; a
  // denial is fail-closed BEFORE any dispatch is built.
  if (spec.requestedCapabilities !== undefined) {
    const grantEvaluation = evaluateExtensionGrant(
      {
        grantedCapabilities: spec.capabilityGrant?.capabilities ?? [],
        requestedCapabilities: spec.requestedCapabilities,
        ...(spec.policyDecision !== undefined ? { policyDecision: spec.policyDecision } : {}),
        ...(spec.provenance !== undefined ? { provenance: spec.provenance } : {}),
        ...(spec.approval !== undefined ? { approval: spec.approval } : {}),
      },
      { checkApproval },
    );
    if (!grantEvaluation.ok) {
      console.log(JSON.stringify({ registration, grantEvaluation }));
      return;
    }
  }

  // capabilityGrant is present here (registration.ok proved it non-empty).
  const capabilityGrant = spec.capabilityGrant as CapabilityGrant;
  const dispatchInput: DispatchExtensionInput = {
    registration,
    capabilityGrant,
    reservedBudget: spec.reservedBudget,
    parentRunId: spec.parentRunId,
    sessionId: spec.sessionId,
    attempt: spec.attempt,
    branchId: spec.branchId,
    contextManifestHash: spec.contextManifestHash,
    policyFingerprint: spec.policyFingerprint,
    canonicalContractVersion: spec.canonicalContractVersion,
    task: spec.task,
    acceptanceCriteria: spec.acceptanceCriteria,
    dispatchArtifact: spec.dispatchArtifact,
    resultArtifact: spec.resultArtifact,
  };
  const dispatch = dispatchExtension(dispatchInput, { idSeq, clock });
  if (!dispatch.ok) {
    console.log(JSON.stringify({ registration, dispatch }));
    return;
  }

  const parsed = dispatch.parseResult(spec.rawChildResult ?? DEFAULT_CHILD_RESULT);
  console.log(
    JSON.stringify({
      registration,
      dispatch: dispatch.dispatch,
      result: parsed.canonical,
      evidenceRefs: [spec.resultArtifact.hash],
    }),
  );
}

// ---------------------------------------------------------------------------
// wave — a bounded parallel wave of registered extensions, spec-driven.
// ---------------------------------------------------------------------------

/**
 * `keryx harness wave` — register each task, assemble `ExtensionWaveTask[]`, and
 * plan bounded parallel waves via the reused `planExtensionWave`. Prints
 * `{ok:true, waves}` or `{ok:false, reason}` (propagated verbatim from the
 * planner). NEVER persists flow state (D-02).
 */
function harnessWave(args: string[], deps?: HarnessCommandDeps): void {
  const { clock, idSeq } = resolveRuntime(deps);
  const spec = deps?.waveSpec ?? readSpecArg<WaveCliSpec>(args);

  const tasks: ExtensionWaveTask[] = spec.tasks.map((task) => {
    const registration = registerExtension({
      extensionId: task.extensionId,
      ...(task.manifest !== undefined ? { manifest: task.manifest } : {}),
      ...(task.capabilityGrant !== undefined ? { capabilityGrant: task.capabilityGrant } : {}),
    });
    // A placeholder grant only ever survives for an UNREGISTERED task, which
    // `planExtensionWave` denies (fail-closed) before it is ever dispatched.
    const capabilityGrant: CapabilityGrant =
      task.capabilityGrant ?? { grantId: "", capabilities: [] };
    return {
      taskId: task.taskId,
      dependsOn: task.dependsOn,
      registration,
      capabilityGrant,
      budgetRequest: task.budgetRequest,
      ...(task.cancelled !== undefined ? { cancelled: task.cancelled } : {}),
      sessionId: task.sessionId,
      attempt: task.attempt,
      branchId: task.branchId,
      contextManifestHash: task.contextManifestHash,
      policyFingerprint: task.policyFingerprint,
      task: task.task,
      acceptanceCriteria: task.acceptanceCriteria,
      dispatchArtifact: task.dispatchArtifact,
      resultArtifact: task.resultArtifact,
    };
  });

  const planInput: PlanExtensionWaveInput = {
    tasks,
    config: { maxConcurrency: spec.maxConcurrency, parentRemaining: spec.parentRemaining },
    parentRunId: spec.parentRunId,
    canonicalContractVersion: spec.canonicalContractVersion,
  };
  const plan = planExtensionWave(planInput, { idSeq, clock });
  if (plan.ok) {
    console.log(JSON.stringify({ ok: true, waves: plan.waves }));
  } else {
    console.log(JSON.stringify({ ok: false, reason: plan.reason }));
  }
}
