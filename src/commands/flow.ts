import { optionValue } from "../lib/args";
import { createFlowService } from "../flow/service";
import { githubAdapter } from "../flow/tracker/github";
import { createCodeHealthService } from "../health/service";
import { securityFlowGate } from "../security/guard";
import {
  banner,
  heading,
  helpTitle,
  helpUsage,
  note,
  statusLine,
  style,
  symbols,
  nextSteps,
} from "../lib/ui";
import type { FlowService, FlowStatus, TaskKind } from "../flow/types";

// Colorize a flow status: terminal states green/red, active states cyan,
// pre-work states yellow.
function flowStatusLabel(status: FlowStatus): string {
  if (status === "done") {
    return style.green(status);
  }
  if (status === "blocked") {
    return style.red(status);
  }
  if (status === "in-progress" || status === "implemented" || status === "completing") {
    return style.cyan(status);
  }
  return style.yellow(status);
}

let service: FlowService | null = null;

function getService(): FlowService {
  service ??= createFlowService({
    tracker: githubAdapter,
    healthGate: async (cwd) => {
      const result = await createCodeHealthService().gate({ cwd });
      return { status: result.status, reasons: result.reasons };
    },
    securityGate: (cwd) => securityFlowGate(cwd),
    now: () => new Date(),
  });
  return service;
}

export async function flowCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case "init":
        return await runInit(args.slice(1));
      case "list":
        return await runList();
      case "status":
        return await runStatus(args.slice(1));
      case "freeze":
        return await runSimple(args.slice(1), "freeze");
      case "start":
        return await runSimple(args.slice(1), "start");
      case "task":
        return await runTask(args.slice(1));
      case "ac":
        return await runAc(args.slice(1));
      case "implemented":
        return await runImplemented(args.slice(1));
      case "complete":
        return await runComplete(args.slice(1));
      case "block":
        return await runBlock(args.slice(1));
      case "unblock":
        return await runSimple(args.slice(1), "unblock");
      case "check":
        return await runCheck();
      default:
        console.error(`Unknown flow command: ${command}`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(`${style.red(symbols.cross)} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function runInit(args: string[]): Promise<void> {
  const result = await getService().init({
    cwd: process.cwd(),
    title: optionValue(args, "--title"),
    issue: optionValue(args, "--issue"),
    slug: optionValue(args, "--slug"),
  });
  banner("flow init", `Created flow ${result.flow.id}`);
  console.log(`  ${style.green(symbols.ok)} ${style.bold(result.flow.title)}`);
  note(result.dir);
  console.log(`  status: ${flowStatusLabel(result.flow.status)}`);
  if (result.contextNotes.length > 0) {
    heading("Context collected");
    for (const contextNote of result.contextNotes) {
      console.log(`  ${style.cyan(symbols.bullet)} ${contextNote}`);
    }
  }
  nextSteps([
    "Enrich context.md, formalize description.md, and write plan.md.",
    `Write hard, verifiable criteria in ${style.cyan("acceptance-criteria.md")}.`,
    `Freeze and start: ${style.cyan(`gd-metapro flow freeze ${result.flow.id}`)} then ${style.cyan(`flow start ${result.flow.id}`)}.`,
  ]);
}

async function runList(): Promise<void> {
  const flows = await getService().list({ cwd: process.cwd() });
  if (flows.length === 0) {
    console.log(`  ${style.dim("No flows yet.")} Start one: ${style.cyan('gd-metapro flow init --title "..."')}`);
    return;
  }
  heading(`Flows (${flows.length})`);
  for (const flow of flows) {
    console.log(
      `  ${style.bold(flow.id)} ${style.dim("[")}${flowStatusLabel(flow.status)}${style.dim("]")} ${flow.title} ${style.dim(`(tasks ${flow.tasksDone}/${flow.tasksTotal})`)}`,
    );
    console.log(`     ${style.dim(flow.dir)}`);
  }
}

async function runStatus(args: string[]): Promise<void> {
  const id = requireId(args);
  const flow = await getService().get({ cwd: process.cwd(), id });
  banner(`flow ${flow.id}`, flow.title);
  console.log(`  status:  ${flowStatusLabel(flow.status)}`);
  console.log(
    `  source:  ${flow.source.type}${flow.source.ref ? style.dim(` (${flow.source.ref})`) : ""}`,
  );
  const acLabel = flow.acChecksum ? style.green("frozen") : style.yellow("not frozen");
  console.log(`  AC:      ${acLabel}, ${Object.keys(flow.acConfirmed).length} confirmed`);
  console.log(`  PR:      ${flow.pr.url ? style.cyan(flow.pr.url) : style.dim("none")}`);

  const doneCount = flow.tasks.filter((task) => task.status === "done").length;
  heading(`Tasks (${doneCount}/${flow.tasks.length})`);
  for (const task of flow.tasks) {
    statusLine(`${task.id} ${task.title}`, task.status === "done", task.kind);
  }

  heading("Recent history");
  for (const event of flow.history.slice(-5)) {
    console.log(
      `  ${style.dim(event.at)} ${event.event}${event.detail ? style.dim(`: ${event.detail}`) : ""}`,
    );
  }
}

async function runSimple(args: string[], action: "freeze" | "start" | "unblock"): Promise<void> {
  const id = requireId(args);
  const flow = await getService()[action]({ cwd: process.cwd(), id });
  console.log(`  ${style.green(symbols.ok)} Flow ${flow.id} ${style.cyan(symbols.arrow)} ${flowStatusLabel(flow.status)}`);
}

async function runTask(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "add") {
    const id = requireId(args.slice(1));
    const title = optionValue(args, "--title");
    if (!title) {
      throw new Error('Usage: gd-metapro flow task add <id> --title "<t>" [--kind context|implement|test|review|docs]');
    }
    const flow = await getService().taskAdd({
      cwd: process.cwd(),
      id,
      title,
      kind: optionValue(args, "--kind") as TaskKind | undefined,
    });
    console.log(`  ${style.green(symbols.ok)} Added ${style.bold(flow.tasks[flow.tasks.length - 1]?.id ?? "task")} to flow ${flow.id}`);
    return;
  }
  if (sub === "done") {
    const id = args[1];
    const taskId = args[2];
    if (!id || !taskId) {
      throw new Error("Usage: gd-metapro flow task done <id> <taskId>");
    }
    const flow = await getService().taskDone({ cwd: process.cwd(), id, taskId });
    const done = flow.tasks.filter((task) => task.status === "done").length;
    console.log(`  ${style.green(symbols.ok)} Task ${style.bold(taskId.toUpperCase())} done ${style.dim(`(${done}/${flow.tasks.length})`)}`);
    return;
  }
  throw new Error("Usage: gd-metapro flow task <add|done> ...");
}

async function runAc(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "confirm") {
    const id = args[1];
    const criterion = args[2];
    if (!id || !criterion) {
      throw new Error('Usage: gd-metapro flow ac confirm <id> <ACn> [--note "<evidence>"]');
    }
    const flow = await getService().acConfirm({
      cwd: process.cwd(),
      id,
      criterion,
      note: optionValue(args, "--note"),
    });
    console.log(`  ${style.green(symbols.ok)} Confirmed ${style.bold(criterion.toUpperCase())} ${style.dim(`(${Object.keys(flow.acConfirmed).length} total)`)}`);
    return;
  }
  if (sub === "update") {
    const id = requireId(args.slice(1));
    const reason = optionValue(args, "--reason");
    if (!reason) {
      throw new Error('Usage: gd-metapro flow ac update <id> --reason "<why>"');
    }
    await getService().acUpdate({ cwd: process.cwd(), id, reason });
    console.log(`  ${style.green(symbols.ok)} Acceptance criteria re-frozen; ${style.dim("prior confirmations cleared")}.`);
    return;
  }
  throw new Error("Usage: gd-metapro flow ac <confirm|update> ...");
}

async function runImplemented(args: string[]): Promise<void> {
  const id = requireId(args);
  const prUrl = optionValue(args, "--pr");
  if (!prUrl) {
    throw new Error("Usage: gd-metapro flow implemented <id> --pr <draft PR url>");
  }
  const flow = await getService().implemented({ cwd: process.cwd(), id, prUrl });
  console.log(
    `  ${style.green(symbols.ok)} Flow ${flow.id} ${style.cyan(symbols.arrow)} ${flowStatusLabel(flow.status)} ${style.dim(`(PR: ${prUrl})`)}`,
  );
}

async function runComplete(args: string[]): Promise<void> {
  const id = requireId(args);
  const result = await getService().complete({
    cwd: process.cwd(),
    id,
    comment: args.includes("--comment"),
  });

  heading(
    result.passed
      ? `${style.green(symbols.ok)} flow complete: DONE`
      : `${style.yellow(symbols.cross)} flow complete: returned to in-progress`,
  );
  for (const gate of result.gates) {
    const mark =
      gate.status === "pass"
        ? style.green(symbols.ok)
        : gate.status === "skipped"
          ? style.gray(symbols.off)
          : style.red(symbols.cross);
    console.log(`  ${mark} ${gate.name} ${style.dim(`(${gate.detail})`)}`);
  }
  if (result.passed && result.issueComment) {
    if (result.flow.source.type === "github-issue") {
      console.log("");
      console.log(
        result.commented
          ? `  ${style.green(symbols.ok)} Issue comment posted.`
          : `  ${style.cyan(symbols.arrow)} Suggested issue comment:`,
      );
      if (!result.commented) {
        console.log("");
        console.log(result.issueComment);
      }
    } else {
      note("No source issue. Ask the user whether to create a ticket for the record.");
    }
  }
  process.exitCode = result.passed ? 0 : 1;
}

async function runBlock(args: string[]): Promise<void> {
  const id = requireId(args);
  const reason = optionValue(args, "--reason");
  if (!reason) {
    throw new Error('Usage: gd-metapro flow block <id> --reason "<why>"');
  }
  const flow = await getService().block({ cwd: process.cwd(), id, reason });
  console.log(`  ${style.yellow(symbols.cross)} Flow ${flow.id} ${style.cyan(symbols.arrow)} ${flowStatusLabel(flow.status)}`);
}

async function runCheck(): Promise<void> {
  const result = await getService().check({ cwd: process.cwd() });
  if (result.ok) {
    console.log(`  ${style.green(symbols.ok)} All flows are consistent.`);
    return;
  }
  heading(`${style.red(symbols.cross)} flow check: ${result.issues.length} issue(s)`);
  for (const issue of result.issues) {
    console.log(`  ${style.red(symbols.cross)} ${style.dim(`[${issue.kind}]`)} ${style.bold(issue.flow)}: ${issue.message}`);
  }
  process.exitCode = 1;
}

function requireId(args: string[]): string {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    throw new Error("Missing flow id. Run: gd-metapro flow list");
  }
  return id;
}

function printHelp(): void {
  helpTitle("gd-metapro flow", "agent-first managed work (flows)");
  helpUsage([
    'gd-metapro flow init (--issue <url> | --title "<t>") [--slug <s>]',
    "gd-metapro flow list",
    "gd-metapro flow status <id>",
    "gd-metapro flow freeze <id>",
    "gd-metapro flow start <id>",
    'gd-metapro flow task add <id> --title "<t>" [--kind context|implement|test|review|docs]',
    "gd-metapro flow task done <id> <taskId>",
    'gd-metapro flow ac confirm <id> <ACn> [--note "<evidence>"]',
    'gd-metapro flow ac update <id> --reason "<why>"',
    "gd-metapro flow implemented <id> --pr <url>",
    "gd-metapro flow complete <id> [--comment]",
    'gd-metapro flow block <id> --reason "<why>"   /   flow unblock <id>',
    "gd-metapro flow check",
  ]);
}
