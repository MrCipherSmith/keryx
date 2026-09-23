// Flow 295 (AC2-AC5, AC14): an `agent-task` schedule runs one unattended agent
// turn on a free-form prompt and leaves a REPORT the operator reads later.
//
// It is an ADAPTER (`src/commands/**`). The decisions that need no I/O (the
// entry's shape, the content hash, the granted-tool catalogue and the floor)
// live in `../trigger/*` (core). The containment and spend steps are shared with the
// `flow-next` dispatch (`./trigger-dispatch.ts`, flow 295 C4). What differs is what
// surrounds the model: there is no flow, no task, no git worktree, no commit and no
// health gate.
//
// Shape of one run, in order — every refusal happens before any model call:
//
//   1. a per-schedule lock (`timeoutMs: 0`): a second run of the SAME schedule refuses.
//   2. the confirmed-content check (AC5): the stored entry must still hash to
//      the `confirmedHash` the operator confirmed, or the run is refused with
//      `grants-changed`. An entry edited behind its installed timer never runs.
//   3. containment: a scratch directory is the agent's working directory, and
//      the project root is bound READ-ONLY. Network is off unless the grant says `full`.
//      `trust` refuses (`sandbox-unavailable`) when the hardened sandbox cannot
//      be built. `ask` is read-only by construction.
//   4. the provider must report token usage, then the spend is reserved under the
//      project-wide lock (AC14), exactly as for `flow-next`.
//   5. one agent turn. The roster is the read tools, `shell_exec` (sandboxed) and the GRANTED
//      tools (AC3). There is no `apply_patch`, web, MCP, subagent or `ask_user`. The unattended
//      floor comes first and the entry's permission mode after it. Every approval request is denied.
//   6. the DISPATCHER, not the agent, writes the final message to
//      `.metaproject/data/trigger/reports/<name>/<runId>.md`, under a header
//      (AC2). The directory is self-ignoring, and the floor keeps the agent out of it.
//
// A GRANTED TOOL runs here, outside the sandbox, through `execFile`: there is no shell,
// the argv is fixed, the parameters are checked, and there is a timeout and an output cap.
// Its output is redacted before the model sees it, both by the secret detector and by
// scrubbing the exact value of every credential-looking environment variable.
// The operator's token therefore never reaches the model, the provider or the report (AC3).

import { execFile } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { buildAgentSystemInstruction, runAgentTurn, type AgentDeps, type AgentIO } from "./agent";
import { builtinReadOnlyTools, type InteractiveTool, type InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { makeCommandRunner, shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import type { NormalizedMessage, ProviderPort } from "../harness/provider/types";
import { planUnattendedSandbox, type UnattendedSandboxInput, type UnattendedSandboxPlan } from "../harness/process/sandbox/unattended";
import { withFileLock } from "../lib/fs";
import { ensureLocksDir } from "../lib/maintenance-lock";
import { redactSensitiveText } from "../security/service";
import { scheduleContentCanonical, type AgentTaskAction, type TriggerDispatch, type TriggerEntry } from "../trigger/config";
import { readScheduleKey, scheduleMac } from "../trigger/schedule-key";
import {
  buildGrantedArgv,
  grantedToolInputSchema,
  grantedToolSpec,
  type GrantedToolSpec,
} from "../trigger/granted-tools";
import type {
  DispatchRefusalCode,
  GrantedCallRecord,
  TriggerAgentTaskRecord,
  TriggerRunCost,
  TriggerRunOutcomeKind,
  UnattendedDenial,
} from "../trigger/record";
import { reserveTriggerSpend } from "../trigger/run";
import { ensureTriggerDataIgnored, readScheduleStore, triggerReportsDir } from "../trigger/store";
import { UNATTENDED_EXCLUDED_TOOLS, unattendedRefusal } from "../trigger/unattended";
import {
  createSpendMeter,
  deniedUnattendedApproval,
  defaultMakeProvider,
  dispatchLockPath,
  guardUsage,
  keryxInvocation,
  NETWORK_ON_WARNING,
} from "./trigger-dispatch";

/** What `./trigger.ts` records and prints for one agent-task run. */
export interface AgentTaskResult {
  readonly outcome: TriggerRunOutcomeKind;
  readonly detail: string;
  readonly cost: TriggerRunCost;
  readonly agentTask: TriggerAgentTaskRecord;
  readonly exitCode: 0 | 1;
}

/** Injectable seams. Production passes none. */
export interface AgentTaskDeps {
  readonly makeProvider?: (dispatch: TriggerDispatch) => ProviderPort | { readonly error: string; readonly code?: DispatchRefusalCode };
  readonly planSandbox?: (input: UnattendedSandboxInput) => UnattendedSandboxPlan;
  readonly armTimeout?: (ms: number, fire: () => void) => () => void;
  readonly runId?: () => string;
  readonly now?: () => Date;
  /** The environment granted tools run with (default `process.env`) — the operator's own. */
  readonly grantedEnv?: Record<string, string | undefined>;
}

const GRANTED_TIMEOUT_MS = 30_000;
const GRANTED_MAX_BYTES = 64 * 1024;

/** Names of environment variables whose VALUES are scrubbed from every granted-tool output. */
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;

/**
 * Flow 295 (F5): token shapes GitHub issues, caught even when no environment variable holds
 * them: classic `ghp_/gho_/ghu_/ghs_/ghr_` tokens (and a prefix of one, at 8 characters
 * or more), fine-grained `github_pat_` tokens, and an `Authorization: token|bearer`
 * header value.
 */
const TOKEN_SHAPES: readonly [RegExp, string][] = [
  [/github_pat_[A-Za-z0-9_]{8,}/g, "[redacted:github_pat]"],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, "[redacted:github_token]"],
  [/(authorization:\s*(?:token|bearer)\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]"],
];

/**
 * AC3 / F5: redact a granted tool's output before the model sees it. There are four layers:
 *   1. the exact values the dispatcher already knows are secrets (the `gh auth token` it
 *      fetched at run start);
 *   2. the exact value of every credential-looking environment variable;
 *   3. GitHub token shapes;
 *   4. the deterministic secret detector every tool output goes through.
 */
export function scrubGrantedOutput(text: string, env: Record<string, string | undefined>, secrets: readonly string[] = []): string {
  let out = text;
  for (const value of secrets) {
    if (value.length >= 8) out = out.split(value).join("[redacted:gh-auth-token]");
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < 8 || !SECRET_ENV_NAME.test(name)) continue;
    out = out.split(value).join(`[redacted:${name}]`);
  }
  for (const [shape, mask] of TOKEN_SHAPES) out = out.replace(shape, mask);
  return redactSensitiveText(out);
}

/**
 * F5: scrub FIRST, then cap. A cap applied first can cut a token in half, and a half
 * token matches neither an exact value nor a shape. After capping, the trailing
 * partial line is dropped as well.
 */
export function scrubThenCap(raw: string, env: Record<string, string | undefined>, secrets: readonly string[], max: number = GRANTED_MAX_BYTES): string {
  const scrubbed = scrubGrantedOutput(raw, env, secrets);
  if (scrubbed.length <= max) return scrubbed;
  const head = scrubbed.slice(0, max);
  const lastBreak = head.lastIndexOf("\n");
  return `${lastBreak > 0 ? head.slice(0, lastBreak) : ""}\n[output truncated at ${max} bytes]`;
}

/** Run one granted command with `execFile` — no shell — and return scrubbed, capped output. */
async function runGrantedCommand(
  bin: string,
  argv: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
  secrets: readonly string[] = [],
): Promise<{ output: string; exitCode: number | null; ok: boolean }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [...argv],
      { cwd, env: env as NodeJS.ProcessEnv, timeout: GRANTED_TIMEOUT_MS, maxBuffer: GRANTED_MAX_BYTES * 4, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        const raw = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null;
        const reason = error === null ? "" : `\n[exit: ${code ?? (error as Error).message}]`;
        resolve({ output: `${scrubThenCap(raw, env, secrets)}${scrubGrantedOutput(reason, env, secrets)}`, exitCode: code, ok: error === null });
      },
    );
  });
}

/** Build the interactive tool for one granted catalogue entry. Every call is recorded in `calls`. */
export function grantedTool(
  spec: GrantedToolSpec,
  action: AgentTaskAction,
  projectRoot: string,
  env: Record<string, string | undefined>,
  calls: GrantedCallRecord[],
  /** Flow 295 (F1d): the realpaths `verifyGrantedBinaries` just checked. Only these are executed. */
  verified: Readonly<Record<string, string>>,
  scrubValues: readonly string[] = [],
): InteractiveTool {
  return {
    definition: {
      name: spec.tool,
      description: `${spec.description} Runs with the operator's credentials outside your sandbox; you get only its (redacted) output.`,
      inputSchema: grantedToolInputSchema(spec, action.grants.repos),
      risk: "read",
    },
    invoke: async (input, ctx): Promise<InteractiveToolResult> => {
      const built = buildGrantedArgv(spec, input, action.grants.repos);
      if (!built.ok) return { output: built.reason, isError: true };
      const bin = verified[spec.program];
      if (bin === undefined) {
        return {
          output: `${spec.tool}: no absolute path for "${spec.program}" was confirmed with this schedule — recreate it to grant the tool`,
          isError: true,
        };
      }
      const result = await runGrantedCommand(bin, built.argv, projectRoot, env, ctx?.signal, scrubValues);
      calls.push({ tool: spec.tool, argv: [bin, ...built.argv], exitCode: result.exitCode, ok: result.ok });
      // Third-party text (PR bodies, comments) — it may be shown, never obeyed.
      return { output: result.output, isError: !result.ok, untrusted: true };
    },
  };
}

/** `gh auth token`, run by the dispatcher, for scrubbing only. Never logged; empty on any failure. */
function ghAuthToken(bin: string | undefined, cwd: string, env: Record<string, string | undefined>): Promise<string[]> {
  if (bin === undefined) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(bin, ["auth", "token"], { cwd, env: env as NodeJS.ProcessEnv, timeout: 10_000 }, (error, stdout) => {
      const token = error === null ? String(stdout).trim() : "";
      resolve(token.length >= 8 ? [token] : []);
    });
  });
}

/** The fixed preamble every scheduled prompt is wrapped in. */
export function buildAgentTaskPrompt(entry: TriggerEntry, action: AgentTaskAction): string {
  const granted = action.grants.tools
    .map((id) => grantedToolSpec(id)?.tool)
    .filter((t): t is string => t !== undefined);
  return [
    "You are running UNATTENDED, as a scheduled task — nobody is present to answer questions or approve actions.",
    `Schedule "${entry.name}". The operator's task, in their words:`,
    "",
    action.prompt,
    "",
    granted.length > 0
      ? `Granted tools (the operator's own credentials, run by keryx outside your sandbox): ${granted.join(", ")}. ` +
        `Repositories: ${action.grants.repos.join(", ")}.`
      : "No granted tools: you have only read access to the project.",
    `Your shell runs in a sandbox with network ${action.grants.network === "full" ? "ON (host network)" : "OFF"} and no credentials. The project is read-only.`,
    "Do not try to change the repository, push, merge, publish or change any schedule. Such calls are refused.",
    "Your FINAL message is the report the operator reads later. Make it a concise summary of what needs their attention.",
  ].join("\n");
}

function refusal(runId: string, code: DispatchRefusalCode, detail: string, action: AgentTaskAction): AgentTaskResult {
  return {
    outcome: "dispatch-refused",
    detail,
    cost: { recorded: false, reason: "the run was refused before any model call" },
    agentTask: { runId, refusal: code, permissionMode: action.dispatch.permissionMode, network: action.grants.network },
    exitCode: 0,
  };
}

/** True when `child` is `parent` or inside it (both already resolved). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Flow 295 (F1d/F6): every granted program must still be exactly the binary the operator
 * confirmed. The basename must equal the program, it must resolve outside the project
 * (a `bin/` that direnv put on PATH does not count), and the realpath and sha256 must be
 * those recorded at confirmation. Returns the verified realpath per program, or the
 * reason for refusing.
 */
export async function verifyGrantedBinaries(
  projectRoot: string,
  action: AgentTaskAction,
): Promise<{ readonly ok: true; readonly realpaths: Record<string, string> } | { readonly ok: false; readonly reason: string }> {
  const realpaths: Record<string, string> = {};
  const root = realOr(projectRoot);
  for (const [program, bin] of Object.entries(action.grants.bins)) {
    const recorded = action.grants.binDigests[program];
    if (path.basename(bin) !== program) return { ok: false, reason: `granted binary for "${program}" is "${bin}", not a program named "${program}"` };
    if (recorded === undefined) return { ok: false, reason: `granted binary "${bin}" has no recorded digest — recreate the schedule` };
    let real: string;
    try {
      real = realpathSync(bin);
    } catch {
      return { ok: false, reason: `granted binary "${bin}" no longer exists` };
    }
    if (isInside(root, real) || isInside(root, path.resolve(bin))) {
      return { ok: false, reason: `granted binary "${bin}" resolves inside the project (${real}) — a project may not supply the program that holds your credentials` };
    }
    if (real !== recorded.realpath) return { ok: false, reason: `granted binary "${bin}" now resolves to ${real}, not ${recorded.realpath} as confirmed` };
    let digest: string;
    try {
      digest = createHash("sha256").update(await readFile(real)).digest("hex");
    } catch (error) {
      return { ok: false, reason: `granted binary ${real} could not be read (${error instanceof Error ? error.message : String(error)})` };
    }
    if (digest !== recorded.sha256) return { ok: false, reason: `granted binary ${real} changed since it was confirmed (sha256 differs)` };
    realpaths[program] = real;
  }
  for (const id of action.grants.tools) {
    const program = grantedToolSpec(id)?.program;
    if (program !== undefined && realpaths[program] === undefined) {
      return { ok: false, reason: `granted tool ${id} has no confirmed binary for "${program}"` };
    }
  }
  return { ok: true, realpaths };
}

/**
 * AC5 / F1a: does the STORED entry still carry this machine's signature (an HMAC keyed
 * by the per-machine schedule key) over exactly the content the operator confirmed?
 */
async function confirmedContentProblem(
  projectRoot: string,
  entry: TriggerEntry,
): Promise<{ readonly code: DispatchRefusalCode; readonly reason: string } | undefined> {
  const key = readScheduleKey();
  if (!key.ok) return { code: "schedule-key-unavailable", reason: `no stored schedule runs: ${key.reason}` };
  const reason = await signatureProblem(projectRoot, entry, key.key);
  return reason === undefined ? undefined : { code: "grants-changed", reason };
}

async function signatureProblem(projectRoot: string, entry: TriggerEntry, key: Buffer): Promise<string | undefined> {
  if (entry.source !== "store" || entry.confirmedHash === undefined) {
    return `schedule "${entry.name}" was never confirmed by an operator (no confirmed content hash) — create it with \`keryx schedule add\``;
  }
  let raw: Record<string, unknown> | undefined;
  try {
    raw = (await readScheduleStore(projectRoot)).find((e) => e["name"] === entry.name);
  } catch (error) {
    return `the schedule store could not be read (${error instanceof Error ? error.message : String(error)})`;
  }
  if (raw === undefined) return `schedule "${entry.name}" is no longer in the schedule store`;
  const { confirmedHash, enabled: _enabled, ...content } = raw;
  const actual = Buffer.from(scheduleMac(key, scheduleContentCanonical(content)), "hex");
  const claimed = typeof confirmedHash === "string" && /^[0-9a-f]{64}$/.test(confirmedHash) ? Buffer.from(confirmedHash, "hex") : Buffer.alloc(0);
  if (claimed.length !== actual.length || !timingSafeEqual(claimed, actual) || confirmedHash !== entry.confirmedHash) {
    return (
      `schedule "${entry.name}" changed after the operator confirmed it (prompt, cadence, runner or grants) — ` +
      "refusing to run content nobody confirmed. Remove it and create it again with `keryx schedule add`."
    );
  }
  return undefined;
}

function lastAssistantText(history: readonly NormalizedMessage[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    if (message.role === "assistant" && message.content.trim().length > 0) return message.content.trim();
  }
  return "";
}

/** Keep the newest `keep` reports of one schedule. Report names start with an ISO-ish stamp, so name order is time order. */
async function pruneReports(dir: string, keep: number): Promise<void> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".md")).sort();
  for (const old of names.slice(0, Math.max(0, names.length - keep))) {
    await rm(path.join(dir, old), { force: true }).catch(() => {});
  }
}

/** Run one `agent-task` entry. */
export async function runAgentTaskDispatch(
  projectRoot: string,
  entry: TriggerEntry,
  action: AgentTaskAction,
  deps: AgentTaskDeps = {},
): Promise<AgentTaskResult> {
  const now = deps.now ?? (() => new Date());
  const runId = deps.runId?.() ?? `sch-${now().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  await ensureLocksDir(projectRoot);
  try {
    return await withFileLock(dispatchLockPath(projectRoot, `schedule-${entry.name}`), () => runLocked(projectRoot, entry, action, deps, runId, now), {
      timeoutMs: 0,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Timed out waiting for lock:")) {
      return refusal(runId, "dispatch-locked", `schedule "${entry.name}" is already running — refusing a second concurrent run. It runs again on the next fire.`, action);
    }
    throw error;
  }
}

async function runLocked(
  projectRoot: string,
  entry: TriggerEntry,
  action: AgentTaskAction,
  deps: AgentTaskDeps,
  runId: string,
  now: () => Date,
): Promise<AgentTaskResult> {
  const dispatch = action.dispatch;

  // --- 2. confirmed content (AC5, F1) ---------------------------------------
  const changed = await confirmedContentProblem(projectRoot, entry);
  if (changed !== undefined) return refusal(runId, changed.code, changed.reason, action);
  const binaries = await verifyGrantedBinaries(projectRoot, action);
  if (!binaries.ok) return refusal(runId, "grants-changed", `refusing to run: ${binaries.reason}`, action);

  // --- 3. containment -------------------------------------------------------
  // Every run's scratch lives under one 0700 parent, and that parent is hidden inside
  // the sandbox (only this run's own directories are bound back), so one run cannot
  // read another's scratch however TMPDIR is set.
  const scratchParent = path.join(tmpdir(), "keryx-agent-tasks");
  await mkdir(scratchParent, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(scratchParent, `${entry.name.replace(/[^A-Za-z0-9._-]/g, "-")}-`));
  const workdir = path.join(scratch, "work");
  const scratchHome = path.join(scratch, "home");
  await mkdir(workdir, { recursive: true });
  await mkdir(scratchHome, { recursive: true });
  const cleanup = async (): Promise<void> => {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const invocation = keryxInvocation();
    const network = action.grants.network === "full";
    const sandbox = (deps.planSandbox ?? planUnattendedSandbox)({
      worktree: workdir,
      scratchHome,
      network,
      readOnly: [projectRoot, ...invocation.roots],
      hide: [scratchParent],
      env: process.env,
      home: homedir(),
      ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
    });
    if (!sandbox.ok && dispatch.permissionMode === "trust") {
      return refusal(
        runId,
        "sandbox-unavailable",
        `permissionMode "trust" runs commands, and it never does so uncontained — refusing: ${sandbox.reason}. ` +
          'Fix the sandbox, or use permissionMode "ask" (read-only: every command is denied; granted tools still run).',
        action,
      );
    }
    const sandboxNote = sandbox.ok
      ? `hardened sandbox, network ${network ? `ON — ${NETWORK_ON_WARNING}` : "off"}`
      : `none (${sandbox.reason}) — "ask" mode, every shell_exec refused`;

    // --- 4. provider, then the reservation (AC14) ----------------------------
    const built = (deps.makeProvider ?? defaultMakeProvider)(dispatch);
    if ("error" in built) {
      if (built.code !== undefined) return refusal(runId, built.code, built.error, action);
      return {
        outcome: "failed",
        detail: `schedule "${entry.name}" not started: ${built.error}`,
        cost: { recorded: false, reason: "no model was called — the provider could not be built" },
        agentTask: { runId, permissionMode: dispatch.permissionMode, network: action.grants.network },
        exitCode: 1,
      };
    }
    const reservation = await reserveTriggerSpend(projectRoot, {
      runId,
      trigger: entry.name,
      firedBy: entry.fire,
      action: entry.action,
      perTrigger: { name: entry.name, ceilingUsd: dispatch.ceilingUsd },
      now,
      actionKind: "agent-task",
    });
    if (!reservation.reserved) {
      return {
        outcome: "budget-refused",
        detail: reservation.reason,
        cost: { recorded: false, reason: "run was refused on the spend ceiling before any model call" },
        agentTask: { runId, permissionMode: dispatch.permissionMode, network: action.grants.network },
        exitCode: 0,
      };
    }

    // From here on every path returns a result carrying `runId`, which closes the reservation.
    const controller = new AbortController();
    const meter = createSpendMeter(dispatch, reservation.usd, () => controller.abort());
    const denials: UnattendedDenial[] = [];
    const grantedCalls: GrantedCallRecord[] = [];
    let timedOut = false;
    let providerError: string | undefined;
    let terminal: string | undefined;
    let finishReason: string | undefined;
    let crashed: string | undefined;
    const history: NormalizedMessage[] = [];
    const disarm = (deps.armTimeout ?? defaultArmTimeout)(dispatch.maxSeconds * 1000, () => {
      timedOut = true;
      controller.abort();
    });
    try {
      const env = deps.grantedEnv ?? process.env;
      // F5: gh's own token, fetched once, outside the sandbox. It is never logged or
      // shown, and it is scrubbed by exact value from every granted-tool output.
      const extraSecrets = await ghAuthToken(binaries.realpaths["gh"], projectRoot, env);
      const granted = action.grants.tools
        .map((id) => grantedToolSpec(id))
        .filter((spec): spec is GrantedToolSpec => spec !== undefined)
        .map((spec) => grantedTool(spec, action, projectRoot, env, grantedCalls, binaries.realpaths, extraSecrets));
      const tools = [...builtinReadOnlyTools(projectRoot), shellExecTool(workdir, sandboxedRunner(workdir, sandbox)), ...granted];
      const offending = tools.filter((t) => UNATTENDED_EXCLUDED_TOOLS.includes(t.definition.name));
      if (offending.length > 0) throw new Error(`agent-task roster must not offer: ${offending.map((t) => t.definition.name).join(", ")}`);
      const provider = guardUsage(built as ProviderPort, () => meter.markUsageMissing());
      const agentDeps: AgentDeps = {
        provider,
        providerId: dispatch.provider,
        modelId: dispatch.model,
        tools,
        systemInstruction: buildAgentSystemInstruction(undefined, {
          providerId: dispatch.provider,
          modelId: dispatch.model,
          toolNames: tools.map((t) => t.definition.name),
        }),
        idSeq: () => randomUUID(),
        unattended: true,
        hardDeny: unattendedRefusal,
      };
      const io: AgentIO = {
        write: () => {},
        onSystem: (text) => {
          if (/\[error\]/.test(text)) providerError ??= text.replace(/\s+/g, " ").trim().slice(0, 400);
        },
        onUsage: (usage) => meter.onUsage(usage),
        // The ONLY permission mode is the entry's — never the project default, never a saved allowlist.
        permissionMode: () => dispatch.permissionMode,
        readOnly: () => false,
        requestApproval: deniedUnattendedApproval(dispatch.permissionMode, denials),
        onAutoApproved: () => {},
        onUnattendedDenial: (tool, reason) => {
          denials.push({ tool, reason });
        },
        onTerminalState: (state) => {
          terminal = state.reason;
        },
      };
      const result = await runAgentTurn(io, agentDeps, history, buildAgentTaskPrompt(entry, action), { signal: controller.signal });
      finishReason = result.finishReason;
    } catch (error) {
      crashed = error instanceof Error ? error.message : String(error);
    } finally {
      disarm();
    }

    const cost = meter.cost();
    const { spendStopped, usageMissing } = meter.state;
    const why =
      usageMissing
        ? "the provider sent a response without token usage — charged the whole reservation"
        : spendStopped
          ? "spend cap reached — the run was stopped at its remaining allowance"
          : timedOut
            ? `timed out after ${dispatch.maxSeconds}s`
            : crashed !== undefined
              ? `the agent run threw: ${crashed}`
              : providerError !== undefined
                ? `provider error: ${providerError}`
                : terminal !== undefined
                  ? `the turn stopped unattended (${terminal})`
                  : finishReason !== undefined
                    ? `the turn was cut short (${finishReason})`
                    : undefined;
    const outcome: TriggerRunOutcomeKind = why === undefined ? "ok" : "failed";
    const summary = lastAssistantText(history);

    // --- 6. the report, written by the dispatcher (AC2) ----------------------
    let reportPath: string | undefined;
    let reportNote = "";
    try {
      await ensureTriggerDataIgnored(projectRoot);
      const dir = path.join(triggerReportsDir(projectRoot), entry.name);
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${runId}.md`);
      await writeFile(
        file,
        renderReport({ entry, action, runId, at: now().toISOString(), outcome, why, cost, grantedCalls, denials, sandboxNote, summary }),
        "utf8",
      );
      await pruneReports(dir, action.report.keep);
      reportPath = path.relative(projectRoot, file);
    } catch (error) {
      reportNote = ` (report NOT written: ${error instanceof Error ? error.message : String(error)})`;
    }

    return {
      outcome,
      detail:
        `${outcome === "ok" ? "report written" : `run ${outcome}: ${why}`}${reportPath !== undefined ? ` → ${reportPath}` : ""}${reportNote} ` +
        `[sandbox: ${sandboxNote}; ${grantedCalls.length} granted call(s); ${denials.length} denial(s); ` +
        `$${cost.recorded ? cost.usd.toFixed(4) : "?"} of $${reservation.usd.toFixed(4)} reserved]`,
      cost,
      agentTask: {
        runId,
        ...(reportPath !== undefined ? { reportPath } : {}),
        grantedCalls,
        ...(denials.length > 0 ? { denials } : {}),
        permissionMode: dispatch.permissionMode,
        network: action.grants.network,
      },
      exitCode: outcome === "ok" ? 0 : 1,
    };
  } finally {
    await cleanup();
  }
}

function sandboxedRunner(workdir: string, plan: UnattendedSandboxPlan): (command: string) => Promise<{ output: string; isError: boolean }> {
  if (!plan.ok) {
    return async () => ({ output: `shell_exec refused: this unattended run has no sandbox (${plan.reason})`, isError: true });
  }
  return makeCommandRunner(workdir, async (command) => ({
    ok: true,
    plan: { spawnArgs: plan.wrap(["/bin/sh", "-c", command]), env: plan.env, netClose: async () => {} },
  }));
}

function renderReport(input: {
  entry: TriggerEntry;
  action: AgentTaskAction;
  runId: string;
  at: string;
  outcome: TriggerRunOutcomeKind;
  why: string | undefined;
  cost: TriggerRunCost;
  grantedCalls: readonly GrantedCallRecord[];
  denials: readonly UnattendedDenial[];
  sandboxNote: string;
  summary: string;
}): string {
  const cost = input.cost.recorded
    ? `$${input.cost.usd.toFixed(4)} (${input.cost.tokens?.input ?? 0} in / ${input.cost.tokens?.output ?? 0} out tokens)`
    : `not recorded (${input.cost.reason})`;
  const lines = [
    `# ${input.entry.name} — scheduled report`,
    "",
    `- run: ${input.runId}`,
    `- at: ${input.at}`,
    `- outcome: ${input.outcome}${input.why !== undefined ? ` — ${input.why}` : ""}`,
    `- cost: ${cost}`,
    `- runner: ${input.action.dispatch.provider}/${input.action.dispatch.model}, mode ${input.action.dispatch.permissionMode}`,
    `- sandbox: ${input.sandboxNote}`,
    `- granted calls: ${input.grantedCalls.length === 0 ? "none" : ""}`,
    ...input.grantedCalls.map((c) => `  - ${c.tool}: \`${c.argv.slice(1).join(" ")}\` → ${c.ok ? "ok" : `exit ${c.exitCode ?? "?"}`}`),
    `- denials: ${input.denials.length === 0 ? "none" : ""}`,
    ...input.denials.map((d) => `  - ${d.tool}: ${d.reason}`),
    "",
    "## Report",
    "",
    input.summary.length > 0 ? input.summary : "_(the agent wrote no final message)_",
    "",
  ];
  return lines.join("\n");
}

function defaultArmTimeout(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}
