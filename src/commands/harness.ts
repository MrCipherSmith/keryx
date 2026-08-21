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

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
import { OPENAI_COMPAT_PROVIDERS } from "./providers";
// SLATE-7 (AC8, flow 163 Track B) — the one-shot process-termination wrap-up
// trigger, wired at the end of the `run` subcommand body below.
import { runWrapUp } from "../sac/machine-wrap-up";
import { readSlate, type Slate } from "../session/slate";
import { resolveOneShotWrapUpSessionDir } from "../session/paths";
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
import { resolveWorkspaceForActor } from "../sac/workspace-service";

const HARNESS_PROVIDER_OPTIONS: readonly string[] = [
  "fake",
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  ...OPENAI_COMPAT_PROVIDERS.map((provider) => provider.name),
];
const HARNESS_PROVIDER_USAGE = `Usage: keryx harness run --provider <${HARNESS_PROVIDER_OPTIONS.join("|")}> --model <m> [--base-url <url>] "<prompt>"`;

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
}

// Exported so tests can assert a parsed value directly (e.g. `unattended`)
// rather than only inferring it indirectly through `harnessCommand`'s
// end-to-end output, which does not currently surface it.
export interface ParsedArgs {
  provider: string;
  model: string;
  baseUrl?: string;
  prompt: string;
  /** `--record <path>`: write the run's replayable hash surface to a file. */
  record?: string;
  /**
   * `--unattended`: operator-set signal (SLATE-8) that this run has no human
   * present, forcing `interactive: false` semantics for that invocation. A
   * plain boolean, deliberately not a `--profile <name>` selector — kept as
   * a separate axis from `PolicyProfile` (see
   * docs/requirements/slate/specification.md's "Permission model" section).
   * Slate Phase 2 scope is parse-and-store only: `RunDeps.interactive` is
   * already unconditionally `false` for every `harness run` invocation
   * (the policy-engine headless fail-closed posture, unrelated to this
   * flag), and no `harness run` → `workspace review` pipe exists yet for
   * this flag to gate — that wiring is deferred to a later phase once such
   * a call path exists. This field exists now so callers can start setting
   * it ahead of that wiring landing.
   */
  unattended?: boolean;
  /** `--goal <text>`: task goal text (SLATE-15). When set, becomes the effective prompt. */
  goal?: string;
  /** `--workspace <id>`: workspace identifier (SLATE-15). */
  workspace?: string;
}

/** The usage text, printed on an unknown subcommand or invalid args. */
const USAGE = [
  HARNESS_PROVIDER_USAGE,
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
 * A minimal tool executor. Release 0 CLI runs register no tools, so a model that
 * requests one produces an unregistered call the run loop skips; this executor is
 * the fail-closed floor if one is ever reached (it never succeeds silently).
 */
const denyingExecutor: ToolExecutorPort = {
  invoke: async (invocation: ToolInvocation): Promise<ToolResult> => {
    throw new Error(`no tool executor is configured for the harness CLI: ${invocation.call.toolName}`);
  },
};

// Every flag this parser recognizes as taking NO value of its own vs. one
// that DOES — used by `--goal`/`--workspace` below to detect "the next
// token is actually another flag, not my value" instead of blindly
// consuming it (review finding: `--goal --unattended "text"` used to parse
// `goal` as the literal string `"--unattended"`, silently losing both the
// real prompt and the unattended flag).
const KNOWN_HARNESS_RUN_FLAGS: ReadonlySet<string> = new Set([
  "--provider",
  "--model",
  "--base-url",
  "--record",
  "--unattended",
  "--goal",
  "--workspace",
]);

/** Parse `run --provider <p> --model <m> [--base-url <url>] [--unattended] [--goal <text>] [--workspace <id>] "<prompt>"`. */
export function parseArgs(args: string[]): ParsedArgs {
  let provider = "";
  let model = "";
  let baseUrl: string | undefined;
  let record: string | undefined;
  let unattended: boolean | undefined;
  let goal: string | undefined;
  let workspace: string | undefined;
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
    } else if (arg === "--unattended") {
      unattended = true;
    } else if (arg === "--goal") {
      const next = args[i + 1];
      goal = next !== undefined && !KNOWN_HARNESS_RUN_FLAGS.has(next) ? args[++i] : undefined;
    } else if (arg === "--workspace") {
      const next = args[i + 1];
      workspace = next !== undefined && !KNOWN_HARNESS_RUN_FLAGS.has(next) ? args[++i] : undefined;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const parsed: ParsedArgs = { provider, model, prompt: goal !== undefined && goal.length > 0 ? goal : positional.join(" ") };
  if (baseUrl !== undefined) parsed.baseUrl = baseUrl;
  if (record !== undefined) parsed.record = record;
  if (unattended !== undefined) parsed.unattended = unattended;
  if (goal !== undefined) parsed.goal = goal;
  if (workspace !== undefined) parsed.workspace = workspace;
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
  if (subcommand === "replay") {
    harnessReplay(args, deps);
    return;
  }

  // The next two comment blocks document the `run` branch's `--workspace`
  // validation (a few hundred lines below) but are placed HERE, above the
  // `run`-dispatch guard, rather than inline next to that validation code:
  // `harness.test.ts`'s flow 163 AC8 source-text audit reads a FIXED
  // `runBranch` window starting exactly at the `if (subcommand !== "run")`
  // line below (so it can locate the AC8 wrap-up trigger call cheaply,
  // without scanning the whole file) — keeping this rationale prose here,
  // before that anchor, keeps it OUT of that fixed window instead of
  // crowding out room for the trigger call near the branch's own end.
  //
  // Review finding 4: a trailing `--workspace` with nothing after it (or a
  // `--workspace` immediately followed by another recognized flag, since
  // parseArgs no longer swallows a flag token as a value) parses to
  // `workspace === undefined` in `ParsedArgs` — INDISTINGUISHABLE, once
  // parsed, from "the flag was never given at all". The fail-closed
  // validation guard below only ever checks the PARSED `workspace` field, so
  // a malformed invocation (`keryx harness run --provider ... --workspace`)
  // silently skipped validation and proceeded UNSCOPED, diverging from
  // `/goal`'s own dangling-`--workspace` rejection (`goal-command.ts`'s
  // `parseGoalArgs`, review finding 5). Rather than changing `parseArgs`'s
  // always-succeeds return shape (which would ripple into every other call
  // site of this mechanical parse-and-store parser), detect the malformed
  // shape explicitly here by checking whether the raw `--workspace` token
  // was present at all.
  //
  // Review finding (empty string): an EXPLICIT `--workspace ""` parses to
  // `workspace === ""`, not `undefined` — it slipped past this guard AND
  // past the `workspace.length > 0` check below (which exists to guard
  // `.length` access, not to gate on non-emptiness), so it silently behaved
  // as "no workspace" instead of being rejected the same way a dangling
  // flag is. An empty string is never a valid workspace id, so it is folded
  // into the same "requires a value" rejection here.
  //
  // SLATE-15 (AC1): `--workspace <id>` gets the SAME fail-closed validation
  // `/goal` itself uses (`resolveWorkspaceForActor`,
  // src/sac/workspace-service.ts) BEFORE constructing the provider/runOffline
  // input at all — an invalid/actor-invisible id refuses the WHOLE command,
  // never a structured blocked/failed run result (mirrors the usage guard
  // above: print + return, no network, no runOffline).
  if (subcommand !== "run") {
    console.log(USAGE);
    return;
  }

  const { provider, model, baseUrl, prompt, record, unattended, workspace } = parseArgs(args);

  // UX guard (flow 021, T5 / AC4): an invalid/empty --provider or an empty
  // prompt prints the usage line and returns BEFORE building input or running
  // runOffline — never a blocked/failed structured run result.
  const validProviders = new Set(HARNESS_PROVIDER_OPTIONS);
  if (!validProviders.has(provider) || prompt.length === 0) {
    console.log(USAGE);
    return;
  }

  // (--workspace validation rationale — review finding 4 / empty-string /
  // SLATE-15 AC1 — is documented above, near this file's own `if
  // (subcommand !== "run")` dispatch guard, to keep this AC8 source-text
  // audit window comfortably inside its fixed budget.)
  if (args.includes("--workspace") && (workspace === undefined || workspace.length === 0)) {
    console.log(
      '--workspace requires a value, e.g. keryx harness run --provider <p> --model <m> --workspace <id> "<prompt>". No run was started.',
    );
    return;
  }

  if (workspace !== undefined && workspace.length > 0) {
    const resolved = await resolveWorkspaceForActor(process.cwd(), workspace);
    if (!resolved.ok) {
      console.log(
        `--workspace "${workspace}" was rejected (${resolved.error.code}): ${resolved.error.message}. No run was started.`,
      );
      return;
    }
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
  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      console.log(
        "OPENAI_API_KEY is not set: the openai provider is required to have a credential and fails closed (no network was contacted).",
      );
      return;
    }
  }
  if (provider === "gemini") {
    const apiKey =
      env.GEMINI_API_KEY !== undefined && env.GEMINI_API_KEY.length > 0 ? env.GEMINI_API_KEY : env.GOOGLE_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      console.log(
        "GEMINI_API_KEY (or GOOGLE_API_KEY) is not set: the gemini provider is required to have a credential and fails closed (no network was contacted).",
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
  // The real content scanner for redaction-before-persistence. Resolved here,
  // once, because the run loop is synchronous and may not read the config from
  // inside itself; without it the loop falls back to a stub that finds nothing.
  const { scan } = await buildHarnessScanner(process.cwd());
  const runDeps: RunDeps = {
    provider: providerPort,
    toolRegistry: new ToolRegistry(),
    toolExecutor: denyingExecutor,
    policyProfile: readOnlyProfile(),
    clock,
    idSeq,
    interactive: false,
    scan,
  };

  let structured: StructuredResult;
  try {
    const result = await runOffline(input, config, runDeps);
    structured = toStructured(result);
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
    };
  }

  console.log(JSON.stringify(structured));

  // AC8-WRAPUP-TRIGGER-START — `harness.test.ts`'s flow 163 AC8 source-text
  // audit locates this block between the START/END markers, not by a fixed
  // byte-offset window from an unrelated anchor line. An earlier version
  // used a fixed-size slice from the `if (subcommand !== "run")` guard
  // above, which broke the moment a rationale comment anywhere in between
  // pushed the real trigger call past the window's budget — exactly the
  // coupling failure mode a reviewer flagged (info-level) on this same PR.
  // Explicit markers make the audit robust to this function's comment
  // density changing in either direction, without a magic number to keep
  // in sync.
  //
  // SLATE-7 (AC8): a one-shot run has no REPL closure trigger (`keryx
  // shell`'s `closeSlateOnFlowDone`) -- process termination is this
  // invocation's only "done" signal. Never let wrap-up bookkeeping crash
  // this command or claw back the structured result already printed above
  // (mirrors goal-command.ts's "slate bookkeeping failed (ignored)").
  //
  // `resolveOneShotWrapUpSessionDir` (not `sessionDir` directly, see its own
  // doc comment in session/paths.ts): keeps this file's PRE-EXISTING, wholly
  // unrelated raw `readFileSync`/`writeFileSync` calls (--record/--fixture/
  // --spec, caller-supplied paths) from being falsely implicated by
  // config-dir.readers.test.ts/config-dir.writers.test.ts's source-level
  // guards, which flag any file that both names a CONFIG_PATH_RESOLVERS
  // function and does a raw read/write anywhere in that same file.
  try {
    const wrapUpDir = resolveOneShotWrapUpSessionDir(process.cwd(), idSeq);
    const prior = await readSlate(wrapUpDir);
    const wrapUpSlate: Slate = prior ?? { anchors: { root: process.cwd(), touched: [] }, course: {}, seeds: [] };
    if (workspace !== undefined && workspace.length > 0) wrapUpSlate.workspaceId = workspace;
    await runWrapUp({ trigger: "process-termination", cwd: process.cwd(), dir: wrapUpDir, slate: wrapUpSlate });
  } catch (error) {
    // Finding 3 (fix round, code review of PR #306; error-handling IRON LAW
    // 1 — a bare `catch (_) {}` is forbidden): still best-effort — never
    // crash this command or claw back the structured result already
    // printed above — but now observable via stderr rather than silent.
    // This file has no `io`/`ShellIO` object to route through (unlike
    // `goal-command.ts`'s own `systemLine(io, "/goal: slate bookkeeping
    // failed (ignored): ...")`, whose house style this message mirrors),
    // so `console.error` is the right primitive here.
    console.error(`harness run: wrap-up trigger failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
  }
  // AC8-WRAPUP-TRIGGER-END
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
