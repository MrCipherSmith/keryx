// `/setup` Run: keryx runs the confirmed steps itself, one background job per step, in order,
// in the project root. No model is involved. The job registry is injected (the shell's own
// session registry in production, a fake in tests), so every rule below is testable headless.
//
// Stop rules: a failed required step stops the run; a failed optional step is reported and the
// run goes on; a `keryx update` that stops on a version divergence ends the run and names both
// flags without ever choosing one; killing a step's job (Background Jobs, /interrupt) ends the run.

import type { SetupStep } from "../commands/setup-guide";
import { MAX_TASK_IDLE_TIMEOUT_MS } from "../harness/tool/builtin/background-job-registry";
import type { BackgroundJobInfo, JobRegistry } from "../harness/tool/builtin/background-job-registry";
import { invocationArgv, resolveKeryxInvocation } from "../trigger/schedule";

/** What the modal hands the shell after the operator said yes. */
export interface SetupRunRequest {
  readonly scenarioTab: string;
  readonly scenarioTitle: string;
  readonly projectRoot: string;
  /** Runnable steps, in order. */
  readonly steps: readonly SetupStep[];
  /** Steps left out because their command still holds a placeholder. Never run. */
  readonly skipped: readonly SetupStep[];
}

/** The slice of the job registry a run needs. */
export type SetupJobs = Pick<JobRegistry, "start" | "waitForExit" | "get" | "readOutput" | "markObserved">;

export interface SetupRunOptions {
  /** Command prefix that replaces the leading `keryx`: the keryx this shell runs on. */
  readonly prefix: string;
  /** One transcript line (no trailing newline). */
  readonly say: (line: string) => void;
}

export type SetupRunOutcome =
  | { readonly status: "done"; readonly ran: number }
  | { readonly status: "stopped"; readonly ran: number; readonly step: SetupStep; readonly reason: string }
  | { readonly status: "cancelled"; readonly ran: number; readonly step: SetupStep };

export const DIVERGENCE_REASON =
  "version divergence: rerun the step by hand with --accept-version or --keep-existing; this run never picks one";

/** A command that still holds `<value>` cannot run unattended. */
export function hasPlaceholder(cli: string): boolean {
  return /<[^<>\s]+>/.test(cli);
}

/** Split the steps of a plan into those that run and those that need a value first. */
export function selectSetupSteps(
  steps: readonly SetupStep[],
  includeOptional: boolean,
): { run: SetupStep[]; skipped: SetupStep[] } {
  const wanted = steps.filter((step) => step.required || includeOptional);
  return {
    run: wanted.filter((step) => !hasPlaceholder(step.cli)),
    skipped: wanted.filter((step) => hasPlaceholder(step.cli)),
  };
}

function quote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The prefix that runs the keryx this process is: `[interpreter, script]` or the compiled binary
 * (`resolveKeryxInvocation`, the helper schedules and triggers use). It never falls back to
 * `keryx` on PATH, because the interpreter path is always known.
 */
export function ownKeryxPrefix(): string {
  return invocationArgv(resolveKeryxInvocation()).map(quote).join(" ");
}

/** `keryx update --yes` becomes `<prefix> update --yes`. */
export function stepCommand(cli: string, prefix: string): string {
  return `${prefix}${cli.replace(/^keryx/, "")}`;
}

function isDivergence(step: SetupStep, output: string): boolean {
  if (!step.cli.startsWith("keryx update")) return false;
  return /diverged from what this writer recorded/.test(output) || (output.includes("--accept-version") && output.includes("--keep-existing"));
}

function lastLine(output: string): string {
  const line = output.split("\n").map((row) => row.trim()).filter(Boolean).at(-1) ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

type Terminal = Pick<BackgroundJobInfo, "status" | "exitCode">;

/** Run the steps in order. Resolves when the run is done, stopped or cancelled. */
export async function runSetupSteps(
  request: SetupRunRequest,
  jobs: SetupJobs,
  options: SetupRunOptions,
): Promise<SetupRunOutcome> {
  const { say } = options;
  const total = request.steps.length;
  say(`◇ setup ${request.scenarioTab}: running ${total} step${total === 1 ? "" : "s"} in ${request.projectRoot} (progress in Background Jobs)`);
  for (const step of request.skipped) say(`◇ skipped, needs a value: ${step.cli}`);
  let ran = 0;
  const optionalFailed: string[] = [];
  for (const [index, step] of request.steps.entries()) {
    const started = await jobs.start(stepCommand(step.cli, options.prefix), {
      phase: "background",
      description: `setup ${index + 1}/${total}: ${step.cli}`,
      idleTimeoutMs: MAX_TASK_IDLE_TIMEOUT_MS,
    });
    let terminal: Terminal | undefined;
    let output = "";
    let failure = "";
    if (!started.ok) {
      failure = started.error;
    } else {
      // The run reports each step itself, so the main agent is not woken for it as well.
      jobs.markObserved(started.jobId);
      while ((await jobs.waitForExit(started.jobId, 2_000)) === "timeout") {
        // still running
      }
      terminal = jobs.get(started.jobId);
      const read = jobs.readOutput(started.jobId);
      output = read.ok ? read.output : "";
      jobs.markObserved(started.jobId);
      if (terminal === undefined) failure = "keryx lost track of the job";
    }
    ran += 1;
    if (terminal?.status === "completed") {
      say(`✓ ${step.cli}`);
      continue;
    }
    if (terminal?.status === "killed") {
      say(`✗ ${step.cli} (stopped from Background Jobs)`);
      say(`◇ setup ${request.scenarioTab} cancelled at ${step.cli}`);
      return { status: "cancelled", ran, step };
    }
    const detail = failure.length > 0 ? failure : `exit ${terminal?.exitCode ?? "?"}${lastLine(output) ? `: ${lastLine(output)}` : ""}`;
    if (terminal !== undefined && isDivergence(step, output)) {
      say(`✗ ${step.cli} (${detail})`);
      say(`◇ setup ${request.scenarioTab} stopped at ${step.cli}: ${DIVERGENCE_REASON}`);
      return { status: "stopped", ran, step, reason: DIVERGENCE_REASON };
    }
    say(`✗ ${step.cli} (${detail})`);
    if (step.required) {
      say(`◇ setup ${request.scenarioTab} stopped at required step ${step.cli}: ${detail}`);
      return { status: "stopped", ran, step, reason: detail };
    }
    optionalFailed.push(step.cli);
  }
  say(
    `◇ setup ${request.scenarioTab} finished: ${ran} step${ran === 1 ? "" : "s"} run` +
      (optionalFailed.length > 0 ? `, optional steps that failed: ${optionalFailed.join(", ")}` : ""),
  );
  return { status: "done", ran };
}
