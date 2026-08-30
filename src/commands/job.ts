import { optionValue } from "../lib/args";
import { createJobService } from "../job/service";
import { toStatusFlag } from "../job/machine";
import { DOCUMENT_TYPES, JOB_INTENTS, STEP_STATUS_FLAGS } from "../job/types";
import type { JobPhase, JobService, JobStepStatus } from "../job/types";
import {
  banner,
  heading,
  helpTitle,
  helpUsage,
  nextSteps,
  note,
  style,
  symbols,
} from "../lib/ui";

/**
 * Positional args only. Without this, `job step --status completed` reads
 * "--status" as the job name and fails with "Job not found: --status" instead of
 * printing the usage line — the same trap `src/commands/flow.ts` documents.
 */
function positional(args: string[], index: number): string | undefined {
  const value = args[index];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

let service: JobService | null = null;

/** Exported so a test can assert what the CLI is actually built from. */
export function jobServiceDeps(): { now: () => Date } {
  return { now: () => new Date() };
}

function getService(): JobService {
  service ??= createJobService(jobServiceDeps());
  return service;
}

function phaseLabel(phase: JobPhase): string {
  if (phase === "COMPLETION") {
    return style.green(phase);
  }
  if (phase === "EXECUTION") {
    return style.cyan(phase);
  }
  return style.yellow(phase);
}

function stepLabel(status: JobStepStatus): string {
  const flag = toStatusFlag(status);
  if (status === "completed") {
    return style.green(flag);
  }
  if (status === "failed") {
    return style.red(flag);
  }
  if (status === "skipped") {
    return style.gray(flag);
  }
  if (status === "in_progress") {
    return style.cyan(flag);
  }
  return style.yellow(flag);
}

export async function jobCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case "init":
        return await runInit(args.slice(1));
      case "status":
        return await runStatus(args.slice(1));
      case "step":
        return await runStep(args.slice(1));
      case "document":
        return await runDocument(args.slice(1));
      case "complete":
        return await runComplete(args.slice(1));
      case "list":
        return await runList(args.slice(1));
      default:
        console.error(`Unknown job command: ${command}`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `${style.red(symbols.cross)} ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

function requireName(args: string[], usage: string): string {
  const name = positional(args, 0);
  if (!name) {
    throw new Error(`Missing job name. Usage: ${usage}`);
  }
  return name;
}

async function runInit(args: string[]): Promise<void> {
  const result = await getService().init({
    cwd: process.cwd(),
    name: optionValue(args, "--name") ?? "",
    intent: optionValue(args, "--intent"),
    projectDir: optionValue(args, "--project"),
  });
  banner("job init", `Created job ${result.state.job_name}`);
  console.log(`  ${style.green(symbols.ok)} ${style.bold(result.state.job_name)}`);
  note(result.dir);
  console.log(`  intent:  ${style.cyan(result.state.intent)}`);
  console.log(`  phase:   ${phaseLabel(result.state.phase)}`);
  console.log(`  steps:   ${result.state.plan.steps.length}`);
  nextSteps([
    `Resume any time with ${style.cyan(`keryx job status ${result.state.job_name}`)} — it names the next open step.`,
    `Record progress: ${style.cyan(`keryx job step ${result.state.job_name} <step-id> --status in-progress`)}.`,
  ]);
}

async function runStatus(args: string[]): Promise<void> {
  const name = requireName(args, "keryx job status <name> [--json]");
  const report = await getService().status({ cwd: process.cwd(), name });

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          job_name: report.state.job_name,
          phase: report.state.phase,
          intent: report.state.intent,
          dir: report.dir,
          steps_done: report.stepsDone,
          steps_total: report.stepsTotal,
          // The resumption fact, first-class in the machine-readable shape: a
          // resuming agent reads this instead of recalling where it was.
          next_step: report.nextStep
            ? { id: report.nextStep.id, agent: report.nextStep.agent, status: toStatusFlag(report.nextStep.status) }
            : null,
          open: report.open,
          failed: report.failed,
          retries: report.retries,
          documents: report.documents,
        },
        null,
        2,
      ),
    );
    return;
  }

  banner(`job ${report.state.job_name}`, report.dir);
  console.log(`  phase:   ${phaseLabel(report.state.phase)}`);
  console.log(`  intent:  ${style.cyan(report.state.intent)}`);
  console.log(
    `  next:    ${
      report.nextStep
        ? `${style.bold(report.nextStep.id)} ${style.dim(`(${report.nextStep.agent})`)}`
        : style.dim("none — every step is terminal")
    }`,
  );

  heading(`Steps (${report.stepsDone}/${report.stepsTotal})`);
  for (const step of report.state.plan.steps) {
    const retries = report.retries[step.id] ?? 0;
    const suffix = retries > 0 ? style.dim(` (retries ${retries})`) : "";
    const conditional = step.conditional ? style.dim(" [conditional]") : "";
    console.log(
      `  ${style.bold(step.id.padEnd(16))} ${stepLabel(step.status)}${suffix}${conditional} ${style.dim(step.agent)}`,
    );
  }

  heading(`Documents (${report.documents.length})`);
  if (report.documents.length === 0) {
    note("none recorded — keryx job document <name> --type <type> --file <path>");
  }
  for (const document of report.documents) {
    console.log(`  ${style.cyan(symbols.bullet)} ${document}`);
  }
}

async function runStep(args: string[]): Promise<void> {
  const usage = `keryx job step <name> <step-id> --status ${STEP_STATUS_FLAGS.join("|")} [--reason "<text>"]`;
  const name = positional(args, 0);
  const stepId = positional(args, 1);
  if (!name || !stepId) {
    throw new Error(`Usage: ${usage}`);
  }
  const result = await getService().step({
    cwd: process.cwd(),
    name,
    stepId,
    status: optionValue(args, "--status") ?? "",
    reason: optionValue(args, "--reason"),
  });
  console.log(
    `  ${style.green(symbols.ok)} ${style.bold(result.step.id)} ${style.cyan(symbols.arrow)} ` +
      `${stepLabel(result.step.status)} ${style.dim(`(retries ${result.retries})`)}`,
  );
  if (result.state.plan.current_step) {
    note(`next open step: ${result.state.plan.current_step}`);
  }
}

async function runDocument(args: string[]): Promise<void> {
  const usage = `keryx job document <name> --type ${DOCUMENT_TYPES.join("|")} --file <path>`;
  const name = requireName(args, usage);
  const result = await getService().document({
    cwd: process.cwd(),
    name,
    type: optionValue(args, "--type") ?? "",
    file: optionValue(args, "--file") ?? "",
  });
  console.log(
    `  ${style.green(symbols.ok)} Recorded ${style.bold(result.document)} ${style.cyan(symbols.arrow)} ${result.path}`,
  );
}

async function runComplete(args: string[]): Promise<void> {
  const name = requireName(args, "keryx job complete <name>");
  const state = await getService().complete({ cwd: process.cwd(), name });
  console.log(
    `  ${style.green(symbols.ok)} Job ${style.bold(state.job_name)} ${style.cyan(symbols.arrow)} ${phaseLabel(state.phase)}`,
  );
}

async function runList(args: string[]): Promise<void> {
  const jobs = await getService().list({ cwd: process.cwd() });
  if (args.includes("--json")) {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }
  if (jobs.length === 0) {
    console.log(
      `  ${style.dim("No jobs yet.")} Start one: ${style.cyan("keryx job init --name <slug>")}`,
    );
    return;
  }
  heading(`Jobs (${jobs.length})`);
  for (const job of jobs) {
    console.log(
      `  ${style.bold(job.name)} ${style.dim("[")}${phaseLabel(job.phase)}${style.dim("]")} ` +
        `${style.dim(`${job.intent}, steps ${job.stepsDone}/${job.stepsTotal}`)}` +
        `${job.nextStep ? style.dim(`, next ${job.nextStep}`) : ""}`,
    );
    console.log(`     ${style.dim(job.dir)}`);
  }
}

function printHelp(): void {
  helpTitle("keryx job", "agent-first job packages (job-orchestrator state)");
  helpUsage([
    `keryx job init --name <slug> [--intent ${JOB_INTENTS.join("|")}] [--project <path>]`,
    "keryx job status <name> [--json]",
    `keryx job step <name> <step-id> --status ${STEP_STATUS_FLAGS.join("|")} [--reason "<text>"]`,
    `keryx job document <name> --type ${DOCUMENT_TYPES.join("|")} --file <path>`,
    "keryx job complete <name>",
    "keryx job list [--json]",
  ]);
}
