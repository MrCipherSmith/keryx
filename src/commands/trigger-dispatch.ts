// Flow 290 T8/T9 (AC1-AC8), hardened in T13 (AC13-AC15): a `flow-next`
// trigger entry with a `dispatch` block DISPATCHES a keryx agent to work the
// flow's next ready task, with no TTY and nobody present, and records what
// happened.
//
// ADAPTER zone (`src/commands/**`): it composes the agent driver
// (`./agent`), the flow service, git, the unattended sandbox and the trigger
// core. The decisions that need no I/O — the unattended floor, the dispatch
// config, the spend ceiling — live in `../trigger/*` (core).
//
// Shape of one dispatch, in order — every refusal happens before any model call:
//
//   1. per-flow dispatch lock (`timeoutMs: 0`) — a second dispatch on the SAME
//      flow refuses (`dispatch-locked`). The project's MAINTENANCE lock is not
//      held across the agent run: the agent's own `keryx gdgraph build` must be
//      able to take it.
//   2. flow checks: `in-progress`, AC frozen, `flow next` is `ready`, no open
//      attempt, attempt count under the cap.
//   3. containment (AC13): `trust` refuses (`sandbox-unavailable`) unless the
//      hardened unattended sandbox can be built here — no launcher, a launcher
//      that cannot create namespaces, a non-Linux host, or an operator opt-out
//      (`KERYX_DANGEROUSLY_DISABLE_SANDBOX=1`, `KERYX_SANDBOX_SHELL=off`) all
//      refuse. `ask` is read-only by construction (every `shell_exec` and
//      `apply_patch` is an approval request, and every approval request is
//      denied), so it may run without a sandbox; its shell runner then refuses
//      every command outright as well.
//   4. the provider (AC14): one that is not known to report token usage is
//      refused (`provider-usage-unknown`); at run time a response that arrives
//      without usage stops the run and is charged the whole reservation.
//   5. spend reservation (AC14) under the project-wide spend lock, written to
//      the ledger before the first model call. Everything after this point
//      returns a result carrying the run id, so the run's own record closes it.
//   6. a throwaway worktree on `trigger/<flow>-<task>`, after recovering a
//      stale registration a killed run left behind (AC15).
//   7. `task attempt --outcome started` with the run id — BEFORE the model.
//   8. one in-process agent turn (`runAgentTurn`) with `unattended: true`, the
//      entry's own permission mode, an approver that denies and records, the
//      unattended floor, a restricted roster, `shell_exec` inside the hardened
//      sandbox, a wall-clock limit and a spend stop.
//   9. commit whatever changed; the health gate runs INSIDE the same sandbox.
//  10. exactly ONE closing fact: `task done` (normal end + commit + health
//      gate) or `task attempt --outcome failed|blocked` with the reason.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildAgentSystemInstruction, runAgentTurn, type AgentDeps, type AgentIO } from "./agent";
import { applyPatchTool } from "../harness/tool/builtin/apply-patch-tool";
import { builtinReadOnlyTools, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { makeCommandRunner, shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { makeProvider } from "../harness/provider/make-provider";
import { FakeProvider } from "../harness/provider/fake-provider";
import type { NormalizedEvent, NormalizedMessage, NormalizedUsage, ProviderPort } from "../harness/provider/types";
import { planUnattendedSandbox, type UnattendedSandboxInput, type UnattendedSandboxPlan } from "../harness/process/sandbox/unattended";
import { providerByName } from "./providers";
import { withFileLock } from "../lib/fs";
import { ensureLocksDir, keryxLocksDir } from "../lib/maintenance-lock";
import { envWithSavedApiKeys } from "../lib/shell-config";
import { spendFromTokens } from "../review/caps";
import type { FlowService, FlowTask } from "../flow/types";
import type { TriggerDispatch, TriggerEntry } from "../trigger/config";
import type {
  DispatchRefusalCode,
  TriggerDispatchRecord,
  TriggerRunCost,
  TriggerRunOutcomeKind,
  UnattendedDenial,
} from "../trigger/record";
import { reserveTriggerSpend } from "../trigger/run";
import { UNATTENDED_EXCLUDED_TOOLS, unattendedRefusal } from "../trigger/unattended";

const execFileAsync = promisify(execFile);

/** What `./trigger.ts` records and prints for one dispatch. */
export interface DispatchResult {
  readonly outcome: TriggerRunOutcomeKind;
  readonly detail: string;
  readonly cost: TriggerRunCost;
  readonly dispatch: TriggerDispatchRecord;
  /** Non-zero only when the dispatched work itself did not succeed (AC2's "the action failed"). */
  readonly exitCode: 0 | 1;
}

export interface HealthGateResult {
  readonly pass: boolean;
  readonly detail: string;
}

/** Injectable seams. Production passes only `service`; tests replace the model, the gate and the clock. */
export interface DispatchDeps {
  readonly service: FlowService;
  /** Build the provider for the entry. Default: `makeProvider` with saved API keys; a missing credential or unknown usage reporting is refused. */
  readonly makeProvider?: (dispatch: TriggerDispatch) => ProviderPort | { readonly error: string; readonly code?: DispatchRefusalCode };
  /** Default: `keryx health run` then `keryx health gate`, inside the run's sandbox. */
  readonly healthGate?: (worktree: string, sandbox: UnattendedSandboxPlan) => Promise<HealthGateResult>;
  /** Arm the wall-clock limit; returns a disarm function. Default: `setTimeout`. */
  readonly armTimeout?: (ms: number, fire: () => void) => () => void;
  /** Where worktrees are created. Default: `<tmpdir>/keryx-trigger-worktrees`. */
  readonly worktreeParent?: string;
  readonly runId?: () => string;
  readonly now?: () => Date;
  /** Build the unattended sandbox. Default: `planUnattendedSandbox` against this host. */
  readonly planSandbox?: (input: UnattendedSandboxInput) => UnattendedSandboxPlan;
}

export const UNATTENDED_ROSTER_DESCRIPTION =
  "get_cwd, list_dir, read_file, shell_exec, apply_patch — no web, no MCP, no subagents, no ask_user";

/**
 * The unattended tool roster (AC5). `shell_exec` runs through `runner` — the
 * hardened sandbox — never through the interactive spawn path.
 */
export function buildUnattendedRoster(
  worktree: string,
  runner: (command: string) => Promise<{ output: string; isError: boolean }> = async () => ({
    output: "shell_exec is unavailable in this unattended run",
    isError: true,
  }),
): InteractiveTool[] {
  const tools = [...builtinReadOnlyTools(worktree), shellExecTool(worktree, runner), applyPatchTool(worktree)];
  const excluded = tools.filter((tool) => UNATTENDED_EXCLUDED_TOOLS.includes(tool.definition.name));
  if (excluded.length > 0) {
    throw new Error(`unattended roster must not offer: ${excluded.map((t) => t.definition.name).join(", ")}`);
  }
  return tools;
}

/** Per-flow dispatch lock — beside the maintenance lock in the self-ignoring `.metaproject/data/.locks/`. */
export function dispatchLockPath(projectRoot: string, flow: string): string {
  return path.join(keryxLocksDir(projectRoot), `dispatch-${flow.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
}

export function triggerBranchName(flow: string, task: string): string {
  return `trigger/${flow}-${task}`.replace(/[^A-Za-z0-9/._-]/g, "-");
}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function refusal(
  runId: string,
  flow: string,
  code: DispatchRefusalCode,
  detail: string,
  task?: FlowTask,
): DispatchResult {
  return {
    outcome: "dispatch-refused",
    detail,
    cost: { recorded: false, reason: "the dispatch was refused before any model call" },
    dispatch: { runId, flow, ...(task !== undefined ? { task: task.id } : {}), refusal: code },
    exitCode: 0,
  };
}

/**
 * Whether `provider`'s adapter is known to report token usage on every
 * response (AC14). The built-in Anthropic, OpenAI and Gemini adapters emit it;
 * an OpenAI-compatible gateway does only when its registry entry declares
 * `streamUsage` (it must be sent `stream_options.include_usage`, which a
 * non-conformant gateway may reject — so it is enabled per provider, where
 * confirmed, and never guessed here). Anything else is refused: a run whose
 * cost cannot be counted cannot be held to a ceiling.
 */
export function providerReportsUsage(provider: string): boolean {
  if (provider === "anthropic" || provider === "openai" || provider === "gemini") return true;
  return providerByName(provider)?.streamUsage === true;
}

/** Default provider construction: fails closed on a missing credential and on unknown usage reporting. */
function defaultMakeProvider(dispatch: TriggerDispatch): ProviderPort | { error: string; code?: DispatchRefusalCode } {
  if (!providerReportsUsage(dispatch.provider)) {
    return {
      code: "provider-usage-unknown",
      error:
        `provider "${dispatch.provider}" is not known to report token usage on every response, so this run's cost ` +
        "could not be counted against its ceiling — refusing. Use anthropic, openai, gemini, or an OpenAI-compatible " +
        "provider whose registry entry sets streamUsage.",
    };
  }
  const env = envWithSavedApiKeys(process.env);
  const provider = makeProvider(dispatch.provider, dispatch.model, {
    fetch: globalThis.fetch,
    env,
    ...(dispatch.baseUrl !== undefined ? { baseUrl: dispatch.baseUrl } : {}),
  });
  if (provider instanceof FakeProvider && dispatch.provider !== "fake") {
    return {
      error:
        `provider "${dispatch.provider}" has no usable credential in this environment (it would fall back to the ` +
        "offline fake provider) — refusing to start an unattended run that could do nothing but look successful.",
    };
  }
  return provider;
}

/**
 * Wrap a provider so a response that completes WITHOUT a usage event is
 * caught (AC14): the run is stopped and charged its whole reservation, because
 * a response whose tokens were never reported cannot be priced.
 */
export function guardUsage(inner: ProviderPort, onMissing: () => void): ProviderPort {
  return {
    describe: () => inner.describe(),
    stream: (request, opts) =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        let sawUsage = false;
        let errored = false;
        let ended = false;
        try {
          for await (const event of inner.stream(request, opts)) {
            if (event.kind === "usage_update" && event.usage !== undefined) sawUsage = true;
            if (event.kind === "provider_error") errored = true;
            if (event.kind === "model_end") ended = true;
            yield event;
          }
        } finally {
          if (ended && !sawUsage && !errored) onMissing();
        }
      })(),
  };
}

/** The package root (the nearest ancestor holding a package.json) of `file`, or its directory. */
function packageRoot(file: string): string {
  let dir = statSafeIsDir(file) ? file : path.dirname(file);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return statSafeIsDir(file) ? file : path.dirname(file);
}

function statSafeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** How to invoke this keryx from inside the sandbox, and which roots that needs readable. */
export function keryxInvocation(): { readonly argv: readonly string[]; readonly roots: readonly string[] } {
  const script = process.argv[1];
  const roots = new Set<string>([packageRoot(realOr(import.meta.dir))]);
  const exec = realOr(process.execPath);
  roots.add(path.dirname(exec));
  if (script !== undefined && /\.(?:[cm]?[jt]s)$/.test(script) && existsSync(script)) {
    const resolved = realOr(script);
    roots.add(packageRoot(resolved));
    return { argv: [exec, resolved], roots: [...roots] };
  }
  // A compiled keryx binary IS the executable.
  return { argv: [exec], roots: [...roots] };
}

/** Default health gate: `keryx health run`, then `keryx health gate`, both INSIDE the run's sandbox (AC13). */
export async function sandboxedHealthGate(
  worktree: string,
  sandbox: UnattendedSandboxPlan,
  run: (argv: readonly string[], env: Record<string, string>, cwd: string) => Promise<{ code: number; out: string }> = runArgv,
): Promise<HealthGateResult> {
  if (!sandbox.ok) {
    return { pass: false, detail: `health gate not run: no sandbox to run the worktree's code in (${sandbox.reason})` };
  }
  const invocation = keryxInvocation();
  // Both steps run the WORKTREE's code (tests, lint and type configs the agent
  // may have written) — so both run inside the sandbox, with its environment.
  await run(sandbox.wrap([...invocation.argv, "health", "run"]), sandbox.env, worktree);
  const gate = await run(sandbox.wrap([...invocation.argv, "health", "gate"]), sandbox.env, worktree);
  const tail = gate.out.trim().split("\n").slice(0, 6).join(" | ");
  return { pass: gate.code === 0, detail: `keryx health gate (sandboxed) exit ${gate.code}: ${tail}` };
}

async function runArgv(
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(argv[0]!, argv.slice(1), { cwd, env, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function buildTaskPrompt(flowId: string, flowTitle: string, flowDir: string | undefined, task: FlowTask): string {
  const pkg = flowDir !== undefined ? `\nThe flow package is at \`${flowDir}\` (description.md, context.md, acceptance-criteria.md, plan.md) — read it first.` : "";
  return [
    `You are working UNATTENDED — nobody is present to answer questions or approve actions.`,
    `Flow ${flowId} ("${flowTitle}"), task ${task.id} (${task.kind}): ${task.title}.${pkg}`,
    "Do this one task in the current directory, which is a throwaway git worktree on its own branch.",
    "Make the change, run the focused tests for what you touched, and stop when the task is done.",
    "Commands run in a sandbox with no network and no credentials.",
    "Do NOT commit, push, merge or tag, and do NOT run `keryx flow` commands that change flow state — the dispatcher",
    "records the outcome itself. Anything that would need an approval will be refused; work around it or stop and say why.",
  ].join("\n");
}

function usageTokens(usage: NormalizedUsage): { input: number; output: number } {
  const input = Number.isFinite(usage.inputTokens) ? (usage.inputTokens as number) : 0;
  let output = Number.isFinite(usage.outputTokens) ? (usage.outputTokens as number) : 0;
  if (input === 0 && output === 0 && Number.isFinite(usage.totalTokens)) output = usage.totalTokens as number;
  return { input, output };
}

/** The sandboxed `shell_exec` runner: the hardened plan, or a refusal of every command when there is none. */
function unattendedRunner(worktree: string, plan: UnattendedSandboxPlan): (command: string) => Promise<{ output: string; isError: boolean }> {
  if (!plan.ok) {
    return async () => ({
      output: `shell_exec refused: this unattended run has no sandbox (${plan.reason})`,
      isError: true,
    });
  }
  return makeCommandRunner(worktree, async (command) => ({
    ok: true,
    plan: { spawnArgs: plan.wrap(["/bin/sh", "-c", command]), env: plan.env, netClose: async () => {} },
  }));
}

/**
 * AC15: a killed run leaves its worktree registered to the trigger branch,
 * and `git worktree add` then fails on that branch forever. Prune dead
 * registrations; remove a LIVE one only when it is ours (under the worktree
 * parent this dispatcher uses). A branch checked out anywhere else — an
 * operator's own worktree — is never touched: that is a conflict to report.
 */
export async function recoverStaleWorktree(
  projectRoot: string,
  branch: string,
  parent: string,
): Promise<{ readonly ok: true; readonly recovered: string | undefined } | { readonly ok: false; readonly reason: string }> {
  await git(projectRoot, ["worktree", "prune"]).catch(() => "");
  let listing: string;
  try {
    listing = await git(projectRoot, ["worktree", "list", "--porcelain"]);
  } catch {
    return { ok: true, recovered: undefined };
  }
  const parentReal = realOr(parent);
  for (const block of listing.split(/\n\n+/)) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    const ref = /^branch (.+)$/m.exec(block)?.[1];
    if (wt === undefined || ref !== `refs/heads/${branch}`) continue;
    const wtReal = realOr(wt);
    if (!wtReal.startsWith(`${parentReal}${path.sep}`)) {
      return {
        ok: false,
        reason: `branch ${branch} is checked out in ${wt}, which this dispatcher did not create — not touching it; free the branch first.`,
      };
    }
    await git(projectRoot, ["worktree", "remove", "--force", wt]).catch(async () => {
      await rm(wt, { recursive: true, force: true }).catch(() => {});
      await git(projectRoot, ["worktree", "prune"]).catch(() => "");
    });
    await rm(`${wt}-home`, { recursive: true, force: true }).catch(() => {});
    return { ok: true, recovered: wt };
  }
  return { ok: true, recovered: undefined };
}

/** Run one dispatch for `entry` (a `flow-next` with a `dispatch` block). */
export async function runFlowNextDispatch(
  projectRoot: string,
  entry: TriggerEntry,
  flow: string,
  dispatch: TriggerDispatch,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const runId = deps.runId?.() ?? `trg-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await ensureLocksDir(projectRoot);
  try {
    return await withFileLock(
      dispatchLockPath(projectRoot, flow),
      async () => {
        await dispatchLockHoldSeam();
        return dispatchLocked(projectRoot, entry, flow, dispatch, deps, runId);
      },
      { timeoutMs: 0 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Timed out waiting for lock:")) {
      return refusal(
        runId,
        flow,
        "dispatch-locked",
        `another dispatch is already working flow ${flow} — refusing rather than starting a second agent on it. Retry on the next fire.`,
      );
    }
    throw error;
  }
}

/** TEST SEAM, never set in production: hold the per-flow dispatch lock until a file exists (same shape as the maintenance-lock seam). */
async function dispatchLockHoldSeam(): Promise<void> {
  const release = process.env["KERYX_DISPATCH_LOCK_HOLD_UNTIL"];
  if (release === undefined || release.length === 0) return;
  const { writeFile, stat } = await import("node:fs/promises");
  await writeFile(`${release}.acquired`, `${process.pid}\n`, "utf8");
  for (;;) {
    try {
      await stat(release);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function dispatchLocked(
  projectRoot: string,
  entry: TriggerEntry,
  flow: string,
  dispatch: TriggerDispatch,
  deps: DispatchDeps,
  runId: string,
): Promise<DispatchResult> {
  const service = deps.service;
  const now = deps.now ?? (() => new Date());
  const triggerName = entry.name;

  // --- 2. flow checks (AC3) — all before any model call -----------------------
  const state = await service.get({ cwd: projectRoot, id: flow });
  if (state.status !== "in-progress") {
    return refusal(runId, flow, "flow-not-in-progress", `flow ${flow} is "${state.status}", not "in-progress" — an unattended run only works a started flow.`);
  }
  if (state.acChecksum === null) {
    return refusal(runId, flow, "flow-not-frozen", `flow ${flow}'s acceptance criteria are not frozen — an unattended run never works a flow whose criteria an operator has not fixed.`);
  }
  const decision = await service.next({ cwd: projectRoot, id: flow });
  if (decision.kind === "none") {
    return refusal(runId, flow, "nothing-ready", `flow ${flow} has no undone task — nothing to dispatch.`);
  }
  if (decision.kind === "blocked") {
    const waiting = decision.blocked.map((b) => `${b.task.id} (waiting on ${b.waitingOn.join(", ")})`).join("; ");
    return refusal(runId, flow, "blocked", `flow ${flow} has work but nothing startable — blocked: ${waiting}.`);
  }
  const task = decision.task;
  if (decision.resume.kind === "unresolved") {
    return refusal(
      runId,
      flow,
      "open-attempt",
      `task ${task.id} carries an open attempt (${decision.resume.reason}) — someone may be working it, or its work half-landed. ` +
        "Resolve it (`keryx flow task attempt … --outcome failed|blocked` or `task done`) before an unattended run touches it.",
      task,
    );
  }
  const attemptsSoFar = task.attempts?.count ?? 0;
  if (attemptsSoFar >= dispatch.maxAttempts) {
    return refusal(
      runId,
      flow,
      "attempt-cap",
      `task ${task.id} already has ${attemptsSoFar} attempt(s), at the cap of ${dispatch.maxAttempts} (dispatch.maxAttempts) — not dispatching it again unattended.`,
      task,
    );
  }

  // --- 3. containment (AC13) — decided before anything is written --------------
  const branch = triggerBranchName(flow, task.id);
  const parent = deps.worktreeParent ?? path.join(tmpdir(), "keryx-trigger-worktrees");
  const worktree = path.join(parent, `${flow}-${task.id}-${runId}`.replace(/[^A-Za-z0-9._-]/g, "-"));
  const scratchHome = `${worktree}-home`;
  const invocation = keryxInvocation();
  const gitCommon = await git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "");
  const sandbox = (deps.planSandbox ?? planUnattendedSandbox)({
    worktree,
    scratchHome,
    network: dispatch.network,
    readOnly: [
      ...(gitCommon.length > 0 ? [gitCommon] : []),
      ...invocation.roots,
      path.join(projectRoot, "node_modules"),
    ],
    env: process.env,
    home: homedir(),
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
  });
  if (!sandbox.ok && dispatch.permissionMode === "trust") {
    return refusal(
      runId,
      flow,
      "sandbox-unavailable",
      `permissionMode "trust" runs commands, and it never does so uncontained — refusing: ${sandbox.reason}. ` +
        'Fix the sandbox, or use permissionMode "ask" (read-only: every command and patch is denied).',
      task,
    );
  }
  const sandboxNote = sandbox.ok
    ? `hardened bwrap sandbox, network ${dispatch.network ? "ON (dispatch.network)" : "off"}`
    : `none (${sandbox.reason}) — "ask" mode, every shell_exec refused`;

  // --- 4. provider (AC14) ------------------------------------------------------
  const built = (deps.makeProvider ?? defaultMakeProvider)(dispatch);
  if ("error" in built) {
    if (built.code !== undefined) return refusal(runId, flow, built.code, built.error, task);
    return {
      outcome: "failed",
      detail: `dispatch for task ${task.id} not started: ${built.error}`,
      cost: { recorded: false, reason: "no model was called — the provider could not be built" },
      dispatch: { runId, flow, task: task.id },
      exitCode: 1,
    };
  }

  // --- 5. spend reservation (AC14) — the last refusal point ---------------------
  const reservation = await reserveTriggerSpend(projectRoot, {
    runId,
    trigger: triggerName,
    firedBy: entry.fire,
    action: entry.action,
    perTrigger: { name: triggerName, ceilingUsd: dispatch.ceilingUsd },
    now,
  });
  if (!reservation.reserved) {
    return {
      outcome: "budget-refused",
      detail: reservation.reason,
      cost: { recorded: false, reason: "run was refused on the spend ceiling before any model call" },
      dispatch: { runId, flow, task: task.id },
      exitCode: 0,
    };
  }
  const reservedUsd = reservation.usd;

  // From here on every path returns a result carrying `runId`, whose record
  // closes the reservation; a throw is turned into such a result below.
  const tokens = { input: 0, output: 0 };
  let usageMissing = false;
  const priced = (): number =>
    usageMissing
      ? reservedUsd
      : spendFromTokens({
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          inputRatePerMillion: dispatch.rates.inputUsdPerMTok,
          outputRatePerMillion: dispatch.rates.outputUsdPerMTok,
        });
  const costNow = (): TriggerRunCost => ({ recorded: true, usd: priced(), tokens: { input: tokens.input, output: tokens.output } });
  try {
    return await runReserved();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "failed",
      detail: `dispatch for task ${task.id} failed after its spend was reserved: ${message}`,
      cost: costNow(),
      dispatch: { runId, flow, task: task.id, branch },
      exitCode: 1,
    };
  }

  async function runReserved(): Promise<DispatchResult> {
    // --- 6. worktree, after recovering a stale registration (AC15) -------------
    await mkdir(parent, { recursive: true });
    const recovery = await recoverStaleWorktree(projectRoot, branch, parent);
    if (!recovery.ok) {
      return { ...refusal(runId, flow, "worktree-conflict", recovery.reason, task), cost: costNow() };
    }
    try {
      if (await branchExists(projectRoot, branch)) {
        await git(projectRoot, ["worktree", "add", "--quiet", worktree, branch]);
      } else {
        await git(projectRoot, ["worktree", "add", "--quiet", "-b", branch, worktree, "HEAD"]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome: "failed",
        detail: `dispatch for task ${task.id} not started: could not create the worktree on ${branch} (${message.trim()})`,
        cost: { recorded: false, reason: "no model was called — the worktree could not be created" },
        dispatch: { runId, flow, task: task.id, branch },
        exitCode: 1,
      };
    }
    await mkdir(scratchHome, { recursive: true });
    const recoveredNote = recovery.recovered !== undefined ? `; recovered a stale worktree at ${recovery.recovered}` : "";
    const startTip = await git(worktree, ["rev-parse", "HEAD"]);
    // A JS project's health gate needs its dependencies; a fresh worktree has none.
    const mainModules = path.join(projectRoot, "node_modules");
    const wtModules = path.join(worktree, "node_modules");
    if (existsSync(mainModules) && !existsSync(wtModules)) {
      await symlink(mainModules, wtModules, "dir").catch(() => {});
    }

    // --- 7. attempt started, BEFORE the model (AC2) ----------------------------
    let attemptNumber = attemptsSoFar + 1;
    try {
      const after = await service.taskAttempt({
        cwd: projectRoot,
        id: flow,
        taskId: task.id,
        outcome: "started",
        detail: `trigger ${triggerName} run ${runId} on branch ${branch}`,
      });
      attemptNumber = after.tasks.find((t) => t.id === task.id)?.attempts?.count ?? attemptNumber;
    } catch (error) {
      await cleanup();
      throw error;
    }

    const denials: UnattendedDenial[] = [];
    const controller = new AbortController();
    let timedOut = false;
    let spendStopped = false;
    let providerError: string | undefined;
    let terminal: string | undefined;
    let finishReason: string | undefined;
    let crashed: string | undefined;
    const disarm = (deps.armTimeout ?? defaultArmTimeout)(dispatch.maxSeconds * 1000, () => {
      timedOut = true;
      controller.abort();
    });
    const provider = guardUsage(built as ProviderPort, () => {
      usageMissing = true;
      controller.abort();
    });

    try {
      const tools = buildUnattendedRoster(worktree, unattendedRunner(worktree, sandbox));
      const toolNames = tools.map((t) => t.definition.name);
      const agentDeps: AgentDeps = {
        provider,
        providerId: dispatch.provider,
        modelId: dispatch.model,
        tools,
        systemInstruction: buildAgentSystemInstruction(undefined, {
          providerId: dispatch.provider,
          modelId: dispatch.model,
          toolNames,
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
        onUsage: (usage) => {
          const t = usageTokens(usage);
          tokens.input += t.input;
          tokens.output += t.output;
          if (!spendStopped && priced() >= reservedUsd) {
            spendStopped = true;
            controller.abort();
          }
        },
        // AC4: the ONLY permission mode is the entry's. Never the project's
        // stored default, never a saved shell allowlist — this io consults neither.
        permissionMode: () => dispatch.permissionMode,
        readOnly: () => false,
        requestApproval: async (tool, _input, meta) => {
          const floors = [
            meta?.credentials === true ? "touches credential files" : undefined,
            meta?.publishLease === true ? "a publish lease applies" : undefined,
            meta?.destructive === true ? "destructive" : undefined,
            meta?.untrustedOrigin === true ? "follows untrusted content" : undefined,
          ].filter((x): x is string => x !== undefined);
          denials.push({
            tool,
            reason:
              `approval required under permission mode "${dispatch.permissionMode}"` +
              (floors.length > 0 ? ` (${floors.join(", ")})` : "") +
              " — unattended, so denied",
          });
          return false;
        },
        onAutoApproved: () => {},
        onUnattendedDenial: (tool, reason) => {
          denials.push({ tool, reason });
        },
        onTerminalState: (terminalState) => {
          terminal = terminalState.reason;
          if (terminalState.reason === "ask_user_unanswerable") {
            denials.push({ tool: "ask_user", reason: "nobody is present to answer — the turn stopped" });
          }
        },
      };
      const flowDir = (await service.list({ cwd: projectRoot })).find((f) => f.id === state.id)?.dir;
      const history: NormalizedMessage[] = [];
      const result = await runAgentTurn(io, agentDeps, history, buildTaskPrompt(state.id, state.title, flowDir, task), {
        signal: controller.signal,
      });
      finishReason = result.finishReason;
    } catch (error) {
      crashed = error instanceof Error ? error.message : String(error);
    } finally {
      disarm();
    }

    const cost = costNow();
    const normal =
      crashed === undefined &&
      providerError === undefined &&
      !timedOut &&
      !spendStopped &&
      !usageMissing &&
      finishReason === undefined &&
      terminal === undefined;

    // --- 9. commit whatever changed, then the health gate (sandboxed) ---------
    let committed = false;
    let head = startTip;
    let commitNote = "";
    try {
      // The dispatcher's own git runs OUTSIDE the sandbox, over content the
      // agent wrote. A repository whose hooks live in the tree
      // (`core.hooksPath=.githooks`, husky) would run agent-edited hook scripts
      // here with the operator's full rights — so this commit runs no hooks.
      const noHooks = ["-c", "core.hooksPath=/dev/null"];
      await git(worktree, [...noHooks, "add", "-A", "--", ".", ":(exclude)node_modules"]);
      const staged = await git(worktree, ["diff", "--cached", "--name-only"]);
      if (staged.length > 0) {
        await git(
          worktree,
          [
            ...noHooks,
            "commit",
            "--no-verify",
            "-q",
            "-m",
            `${normal ? "trigger" : "wip(trigger)"}(${flow}): ${task.id} ${task.title}\n\ntask: ${task.id}\ntrigger-run: ${runId}`,
          ],
          // The dispatcher's own commit must not kick off a graph rebuild in the
          // worktree through the shared post-commit hook.
          { KERYX_GDGRAPH_HOOK_REBUILD: "0" },
        );
      }
      head = await git(worktree, ["rev-parse", "HEAD"]);
      committed = head !== startTip;
    } catch (error) {
      commitNote = ` (commit failed: ${(error instanceof Error ? error.message : String(error)).trim().slice(0, 300)})`;
    }

    let gate: HealthGateResult | undefined;
    if (normal && committed) {
      gate = await (deps.healthGate ?? sandboxedHealthGate)(worktree, sandbox).catch((error: unknown) => ({
        pass: false,
        detail: `health gate could not run: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }

    // --- 10. exactly one closing fact (AC2) ----------------------------------
    const why = closingReason({ crashed, providerError, timedOut, spendStopped, usageMissing, finishReason, terminal, committed, gate, dispatch, commitNote });
    const done = normal && committed && gate?.pass === true;
    let closing: "done" | "failed" | "blocked";
    let closingNote = "";
    try {
      if (done) {
        await service.taskDone({
          cwd: projectRoot,
          id: flow,
          taskId: task.id,
          disposition: "completed",
          runLink: { runId, sessionId: runId, attempt: attemptNumber, at: now().toISOString() },
          evidenceRefs: [`branch:${branch}`, `commit:${head}`],
        });
        closing = "done";
      } else {
        closing = terminal === "ask_user_unanswerable" || (denials.length > 0 && !committed) ? "blocked" : "failed";
        await service.taskAttempt({
          cwd: projectRoot,
          id: flow,
          taskId: task.id,
          outcome: closing,
          detail: `trigger ${triggerName} run ${runId}: ${why}`,
        });
      }
    } catch (error) {
      // `task done` refused (a gate), or the attempt write itself failed. Try
      // once to close the attempt as failed; if even that throws, the cost
      // below is still returned and recorded (review item 5).
      closingNote = ` (closing ${done ? "as done" : "the attempt"} failed: ${error instanceof Error ? error.message : String(error)})`;
      closing = "failed";
      await service
        .taskAttempt({
          cwd: projectRoot,
          id: flow,
          taskId: task.id,
          outcome: "failed",
          detail: `trigger ${triggerName} run ${runId}: ${why}${closingNote}`,
        })
        .catch((second: unknown) => {
          closingNote += `; the fallback attempt record also failed (${second instanceof Error ? second.message : String(second)}) — the attempt stays open`;
        });
    }

    await cleanup();

    const summary =
      closing === "done"
        ? `task ${task.id} done on ${branch} (${head.slice(0, 8)}); ${gate?.detail ?? ""}`
        : `task ${task.id} attempt ${attemptNumber} ${closing}: ${why}${closingNote}`;
    return {
      outcome: closing === "done" ? "ok" : "failed",
      detail: `${summary} [sandbox: ${sandboxNote}; ${denials.length} denial(s); $${cost.recorded ? cost.usd.toFixed(4) : "?"} of $${reservedUsd.toFixed(4)} reserved${recoveredNote}]`,
      cost,
      dispatch: {
        runId,
        flow,
        task: task.id,
        attempt: attemptNumber,
        branch,
        closing,
        ...(denials.length > 0 ? { denials } : {}),
      },
      exitCode: closing === "done" ? 0 : 1,
    };
  }

  async function cleanup(): Promise<void> {
    await removeWorktree(projectRoot, worktree);
    await rm(scratchHome, { recursive: true, force: true }).catch(() => {});
  }
}

function closingReason(input: {
  crashed: string | undefined;
  providerError: string | undefined;
  timedOut: boolean;
  spendStopped: boolean;
  usageMissing: boolean;
  finishReason: string | undefined;
  terminal: string | undefined;
  committed: boolean;
  gate: HealthGateResult | undefined;
  dispatch: TriggerDispatch;
  commitNote: string;
}): string {
  if (input.usageMissing) {
    return "the provider sent a response without token usage — it cannot be priced, so the run was stopped and charged its whole reservation";
  }
  if (input.spendStopped) return "spend cap reached — the run was stopped at its remaining allowance";
  if (input.timedOut) return `timed out after ${input.dispatch.maxSeconds}s (dispatch.maxSeconds)`;
  if (input.crashed !== undefined) return `the agent run threw: ${input.crashed}`;
  if (input.providerError !== undefined) return `provider error: ${input.providerError}`;
  if (input.terminal !== undefined) return `the turn stopped unattended (${input.terminal})`;
  if (input.finishReason !== undefined) return `the turn was cut short (${input.finishReason})`;
  if (!input.committed) return `the run changed nothing on the trigger branch${input.commitNote}`;
  if (input.gate !== undefined && !input.gate.pass) return `health gate failed — ${input.gate.detail}`;
  return "ended without meeting the done conditions";
}

function defaultArmTimeout(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

async function removeWorktree(projectRoot: string, worktree: string): Promise<void> {
  try {
    await git(projectRoot, ["worktree", "remove", "--force", worktree]);
  } catch {
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
    await git(projectRoot, ["worktree", "prune"]).catch(() => "");
  }
}
