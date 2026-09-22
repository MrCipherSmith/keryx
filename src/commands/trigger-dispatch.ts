// Flow 290 T8/T9 (AC1-AC8): a `flow-next` trigger entry with a `dispatch`
// block DISPATCHES a keryx agent to work the flow's next ready task, with no
// TTY and nobody present, and records what happened.
//
// ADAPTER zone (`src/commands/**`): it composes the agent driver
// (`./agent`), the flow service, git and the trigger core. The decisions that
// need no I/O — the unattended floor, the dispatch config, the spend ceiling —
// live in `../trigger/*` (core) and are only called from here.
//
// Shape of one dispatch, in order — every refusal happens before any model call:
//
//   1. per-flow dispatch lock (`timeoutMs: 0`) — a second dispatch on the SAME
//      flow refuses (`dispatch-locked`); different flows do not serialize.
//      The project's MAINTENANCE lock is deliberately NOT held across the agent
//      run: the agent's own `keryx gdgraph build` must be able to take it.
//   2. flow checks: `in-progress`, AC frozen, `flow next` is `ready`, the ready
//      task has no open attempt, and its attempt count is under the cap.
//   3. a throwaway git worktree on `trigger/<flow>-<task>` — never the
//      operator's checkout, never pushed.
//   4. `task attempt --outcome started` with the run id — BEFORE the model.
//   5. one in-process agent turn (`runAgentTurn`) with `unattended: true`, the
//      entry's own permission mode (never the stored project default, never a
//      saved shell allowlist), an approver that denies and records, the
//      unattended floor, a restricted roster, a wall-clock limit and a spend stop.
//   6. commit whatever changed on the trigger branch; health gate in the worktree.
//   7. exactly ONE closing fact: `task done` (normal end + commit + health gate)
//      or `task attempt --outcome failed|blocked` with the reason.
//
// The caller (the budget check, the record, the exit code) is `./trigger.ts`.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildAgentSystemInstruction, runAgentTurn, type AgentDeps, type AgentIO } from "./agent";
import { applyPatchTool } from "../harness/tool/builtin/apply-patch-tool";
import { builtinReadOnlyTools, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { makeProvider } from "../harness/provider/make-provider";
import { FakeProvider } from "../harness/provider/fake-provider";
import type { NormalizedMessage, NormalizedUsage, ProviderPort } from "../harness/provider/types";
import { resolveShellSandboxMode } from "../harness/process/shell-spawn";
import { detectSandboxLauncher } from "../harness/process/sandbox/detect";
import { withFileLock } from "../lib/fs";
import { gitScopedLockPath } from "../lib/maintenance-lock";
import { envWithSavedApiKeys } from "../lib/shell-config";
import { spendFromTokens } from "../review/caps";
import type { FlowService, FlowTask } from "../flow/types";
import type { TriggerDispatch } from "../trigger/config";
import type {
  DispatchRefusalCode,
  TriggerDispatchRecord,
  TriggerRunCost,
  TriggerRunOutcomeKind,
  UnattendedDenial,
} from "../trigger/record";
import { triggerDataDir } from "../trigger/record";
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
  /** Build the provider for the entry. Default: `makeProvider` with saved API keys; a missing credential is refused. */
  readonly makeProvider?: (dispatch: TriggerDispatch) => ProviderPort | { readonly error: string };
  /** Default: `keryx health run` then `keryx health gate` in the worktree. */
  readonly healthGate?: (worktree: string) => Promise<HealthGateResult>;
  /** Arm the wall-clock limit; returns a disarm function. Default: `setTimeout`. */
  readonly armTimeout?: (ms: number, fire: () => void) => () => void;
  /** Where worktrees are created. Default: `<tmpdir>/keryx-trigger-worktrees`. */
  readonly worktreeParent?: string;
  readonly runId?: () => string;
  readonly now?: () => Date;
  /** Whether to force the OS shell sandbox. Default: force `workspace` when available and not set by the operator. */
  readonly sandbox?: "auto" | "leave";
}

export const UNATTENDED_ROSTER_DESCRIPTION =
  "get_cwd, list_dir, read_file, shell_exec, apply_patch — no web, no MCP, no subagents, no ask_user";

/** The unattended tool roster (AC5). Built from the same factories the ACP server uses, then checked. */
export function buildUnattendedRoster(worktree: string): InteractiveTool[] {
  const tools = [...builtinReadOnlyTools(worktree), shellExecTool(worktree), applyPatchTool(worktree)];
  const excluded = tools.filter((tool) => UNATTENDED_EXCLUDED_TOOLS.includes(tool.definition.name));
  if (excluded.length > 0) {
    throw new Error(`unattended roster must not offer: ${excluded.map((t) => t.definition.name).join(", ")}`);
  }
  return tools;
}

/** Per-flow dispatch lock — in the git directory, like the maintenance lock, so a long dispatch never leaves it where `git add -A` could commit it. */
export function dispatchLockPath(projectRoot: string, flow: string): string {
  const name = `keryx-dispatch-${flow.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`;
  return gitScopedLockPath(projectRoot, name, path.join(path.relative(projectRoot, triggerDataDir(projectRoot)), name));
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

/** Default provider construction: fails closed when the provider would silently fall back to the offline fake. */
function defaultMakeProvider(dispatch: TriggerDispatch): ProviderPort | { error: string } {
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

/** Default health check: `keryx health run` (writes the report), then `keryx health gate`, in the worktree. */
async function defaultHealthGate(worktree: string): Promise<HealthGateResult> {
  const script = process.argv[1];
  const base = script !== undefined ? [path.resolve(script)] : [];
  const run = async (args: string[]): Promise<{ code: number; out: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [...base, ...args], {
        cwd: worktree,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, out: `${stdout}${stderr}` };
    } catch (error) {
      const e = error as { code?: unknown; stdout?: string; stderr?: string };
      return { code: typeof e.code === "number" ? e.code : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  await run(["health", "run"]);
  const gate = await run(["health", "gate"]);
  const tail = gate.out.trim().split("\n").slice(0, 6).join(" | ");
  return { pass: gate.code === 0, detail: `keryx health gate exit ${gate.code}: ${tail}` };
}

function buildTaskPrompt(flowId: string, flowTitle: string, flowDir: string | undefined, task: FlowTask): string {
  const pkg = flowDir !== undefined ? `\nThe flow package is at \`${flowDir}\` (description.md, context.md, acceptance-criteria.md, plan.md) — read it first.` : "";
  return [
    `You are working UNATTENDED — nobody is present to answer questions or approve actions.`,
    `Flow ${flowId} ("${flowTitle}"), task ${task.id} (${task.kind}): ${task.title}.${pkg}`,
    "Do this one task in the current directory, which is a throwaway git worktree on its own branch.",
    "Make the change, run the focused tests for what you touched, and stop when the task is done.",
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

/**
 * Force the OS shell sandbox for this run when it is available and the
 * operator has not set `KERYX_SANDBOX_SHELL` themselves. Returns what was done
 * and a restore function. `shell_exec` reads the mode from `process.env` at
 * spawn time, and `keryx trigger run` is a single-purpose process, so setting
 * it for the run's duration is the whole mechanism.
 */
function applySandbox(mode: "auto" | "leave"): { readonly note: string; readonly restore: () => void } {
  if (mode === "leave") return { note: "left as configured", restore: () => {} };
  const current = resolveShellSandboxMode(process.env);
  if (current !== "off") return { note: `operator-configured (${current})`, restore: () => {} };
  if (process.env["KERYX_DANGEROUSLY_DISABLE_SANDBOX"] === "1") {
    return { note: "disabled by KERYX_DANGEROUSLY_DISABLE_SANDBOX=1", restore: () => {} };
  }
  const launcher = detectSandboxLauncher();
  if (!launcher.available) {
    return { note: `unavailable (${launcher.reason ?? "no launcher"}) — shell_exec runs uncontained`, restore: () => {} };
  }
  const previous = process.env["KERYX_SANDBOX_SHELL"];
  process.env["KERYX_SANDBOX_SHELL"] = "workspace";
  return {
    note: "forced workspace sandbox for this run",
    restore: () => {
      if (previous === undefined) delete process.env["KERYX_SANDBOX_SHELL"];
      else process.env["KERYX_SANDBOX_SHELL"] = previous;
    },
  };
}

/**
 * Run one dispatch. The budget check is the caller's (it happens before this,
 * so a refusal there never reaches git or the model); `remainingUsd` is the
 * allowance that check returned.
 */
export async function runFlowNextDispatch(
  projectRoot: string,
  triggerName: string,
  flow: string,
  dispatch: TriggerDispatch,
  remainingUsd: number,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const runId = deps.runId?.() ?? `trg-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  try {
    return await withFileLock(
      dispatchLockPath(projectRoot, flow),
      async () => {
        await dispatchLockHoldSeam();
        return dispatchLocked(projectRoot, triggerName, flow, dispatch, remainingUsd, deps, runId);
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
  triggerName: string,
  flow: string,
  dispatch: TriggerDispatch,
  remainingUsd: number,
  deps: DispatchDeps,
  runId: string,
): Promise<DispatchResult> {
  const service = deps.service;
  const now = deps.now ?? (() => new Date());

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

  // --- provider, before anything is written -----------------------------------
  const provider = (deps.makeProvider ?? defaultMakeProvider)(dispatch);
  if ("error" in provider) {
    return {
      outcome: "failed",
      detail: `dispatch for task ${task.id} not started: ${provider.error}`,
      cost: { recorded: false, reason: "no model was called — the provider could not be built" },
      dispatch: { runId, flow, task: task.id },
      exitCode: 1,
    };
  }

  // --- 3. worktree ------------------------------------------------------------
  const branch = triggerBranchName(flow, task.id);
  const parent = deps.worktreeParent ?? path.join(tmpdir(), "keryx-trigger-worktrees");
  const worktree = path.join(parent, `${flow}-${task.id}-${runId}`.replace(/[^A-Za-z0-9._-]/g, "-"));
  await mkdir(parent, { recursive: true });
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
  const startTip = await git(worktree, ["rev-parse", "HEAD"]);
  // A JS project's health gate needs its dependencies; a fresh worktree has none.
  const mainModules = path.join(projectRoot, "node_modules");
  const wtModules = path.join(worktree, "node_modules");
  if (existsSync(mainModules) && !existsSync(wtModules)) {
    await symlink(mainModules, wtModules, "dir").catch(() => {});
  }

  // --- 4. attempt started, BEFORE the model (AC2) ------------------------------
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
    await removeWorktree(projectRoot, worktree);
    throw error;
  }

  // Everything below must end in exactly one closing fact, whatever throws.
  const denials: UnattendedDenial[] = [];
  const tokens = { input: 0, output: 0 };
  const priced = (): number =>
    spendFromTokens({
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      inputRatePerMillion: dispatch.rates.inputUsdPerMTok,
      outputRatePerMillion: dispatch.rates.outputUsdPerMTok,
    });
  const controller = new AbortController();
  let timedOut = false;
  let spendStopped = false;
  let providerError: string | undefined;
  let terminal: string | undefined;
  let finishReason: string | undefined;
  let crashed: string | undefined;
  const sandbox = applySandbox(deps.sandbox ?? "auto");
  const disarm = (deps.armTimeout ?? defaultArmTimeout)(dispatch.maxSeconds * 1000, () => {
    timedOut = true;
    controller.abort();
  });

  try {
    const tools = buildUnattendedRoster(worktree);
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
        if (!spendStopped && priced() >= remainingUsd) {
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
      onTerminalState: (state) => {
        terminal = state.reason;
        if (state.reason === "ask_user_unanswerable") {
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
    sandbox.restore();
  }

  const usd = priced();
  const cost: TriggerRunCost = { recorded: true, usd, tokens: { input: tokens.input, output: tokens.output } };
  const normal =
    crashed === undefined &&
    providerError === undefined &&
    !timedOut &&
    !spendStopped &&
    finishReason === undefined &&
    terminal === undefined;

  // --- 6. commit whatever changed, then the health gate -----------------------
  let committed = false;
  let head = startTip;
  let commitNote = "";
  try {
    await git(worktree, ["add", "-A", "--", ".", ":(exclude)node_modules"]);
    const staged = await git(worktree, ["diff", "--cached", "--name-only"]);
    if (staged.length > 0) {
      await git(
        worktree,
        [
          "commit",
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
    gate = await (deps.healthGate ?? defaultHealthGate)(worktree).catch((error: unknown) => ({
      pass: false,
      detail: `health gate could not run: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }

  // --- 7. exactly one closing fact (AC2) --------------------------------------
  const why = closingReason({ crashed, providerError, timedOut, spendStopped, finishReason, terminal, committed, gate, dispatch, commitNote });
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
    // `task done` refused (a gate) — record the attempt as failed instead, so
    // the attempt never stays open.
    closingNote = ` (closing as done was refused: ${error instanceof Error ? error.message : String(error)})`;
    closing = "failed";
    await service.taskAttempt({
      cwd: projectRoot,
      id: flow,
      taskId: task.id,
      outcome: "failed",
      detail: `trigger ${triggerName} run ${runId}: ${why}${closingNote}`,
    });
  }

  await removeWorktree(projectRoot, worktree);

  const summary =
    closing === "done"
      ? `task ${task.id} done on ${branch} (${head.slice(0, 8)}); ${gate?.detail ?? ""}`
      : `task ${task.id} attempt ${attemptNumber} ${closing}: ${why}${closingNote}`;
  return {
    outcome: closing === "done" ? "ok" : "failed",
    detail: `${summary} [sandbox: ${sandbox.note}; ${denials.length} denial(s); $${usd.toFixed(4)}]`,
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

function closingReason(input: {
  crashed: string | undefined;
  providerError: string | undefined;
  timedOut: boolean;
  spendStopped: boolean;
  finishReason: string | undefined;
  terminal: string | undefined;
  committed: boolean;
  gate: HealthGateResult | undefined;
  dispatch: TriggerDispatch;
  commitNote: string;
}): string {
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
