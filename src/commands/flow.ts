import { optionValue } from "../lib/args";
import { createFlowService } from "../flow/service";
import { githubAdapter } from "../flow/tracker/github";
import { createCodeHealthService } from "../health/service";
import type { FlowService, TaskKind } from "../flow/types";

let service: FlowService | null = null;

function getService(): FlowService {
  service ??= createFlowService({
    tracker: githubAdapter,
    healthGate: async (cwd) => {
      const result = await createCodeHealthService().gate({ cwd });
      return { status: result.status, reasons: result.reasons };
    },
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
    console.error(error instanceof Error ? error.message : String(error));
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
  console.log(`Created flow ${result.flow.id}: ${result.dir}`);
  console.log(`status: ${result.flow.status}`);
  for (const note of result.contextNotes) {
    console.log(`- ${note}`);
  }
  console.log("");
  console.log("Next: enrich context, formalize description, write plan and");
  console.log("acceptance criteria, then `gd-metapro flow freeze` + `flow start`.");
}

async function runList(): Promise<void> {
  const flows = await getService().list({ cwd: process.cwd() });
  if (flows.length === 0) {
    console.log("No flows yet. Start one: gd-metapro flow init --title \"...\"");
    return;
  }
  console.log("# Flows");
  console.log("");
  for (const flow of flows) {
    console.log(
      `- ${flow.id} [${flow.status}] ${flow.title} (tasks ${flow.tasksDone}/${flow.tasksTotal}) - ${flow.dir}`,
    );
  }
}

async function runStatus(args: string[]): Promise<void> {
  const id = requireId(args);
  const flow = await getService().get({ cwd: process.cwd(), id });
  console.log(`# Flow ${flow.id}: ${flow.title}`);
  console.log("");
  console.log(`status: ${flow.status}`);
  console.log(`source: ${flow.source.type}${flow.source.ref ? ` (${flow.source.ref})` : ""}`);
  console.log(`AC: ${flow.acChecksum ? "frozen" : "not frozen"}; confirmed: ${Object.keys(flow.acConfirmed).length}`);
  console.log(`PR: ${flow.pr.url ?? "none"}`);
  console.log("");
  console.log("## Tasks");
  for (const task of flow.tasks) {
    console.log(`- [${task.status === "done" ? "x" : " "}] ${task.id} (${task.kind}) ${task.title}`);
  }
  console.log("");
  console.log("## Recent history");
  for (const event of flow.history.slice(-5)) {
    console.log(`- ${event.at} ${event.event}${event.detail ? `: ${event.detail}` : ""}`);
  }
}

async function runSimple(args: string[], action: "freeze" | "start" | "unblock"): Promise<void> {
  const id = requireId(args);
  const flow = await getService()[action]({ cwd: process.cwd(), id });
  console.log(`Flow ${flow.id} -> ${flow.status}`);
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
    console.log(`Added ${flow.tasks[flow.tasks.length - 1]?.id} to flow ${flow.id}`);
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
    console.log(`Task ${taskId.toUpperCase()} done (${done}/${flow.tasks.length})`);
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
    console.log(`Confirmed ${criterion.toUpperCase()} (${Object.keys(flow.acConfirmed).length} total)`);
    return;
  }
  if (sub === "update") {
    const id = requireId(args.slice(1));
    const reason = optionValue(args, "--reason");
    if (!reason) {
      throw new Error('Usage: gd-metapro flow ac update <id> --reason "<why>"');
    }
    await getService().acUpdate({ cwd: process.cwd(), id, reason });
    console.log("Acceptance criteria re-frozen; prior confirmations cleared.");
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
  console.log(`Flow ${flow.id} -> ${flow.status} (PR: ${prUrl})`);
}

async function runComplete(args: string[]): Promise<void> {
  const id = requireId(args);
  const result = await getService().complete({
    cwd: process.cwd(),
    id,
    comment: args.includes("--comment"),
  });

  console.log(`# flow complete: ${result.passed ? "DONE" : "RETURNED TO IN-PROGRESS"}`);
  console.log("");
  for (const gate of result.gates) {
    console.log(`- ${gate.name}: ${gate.status} (${gate.detail})`);
  }
  if (result.passed && result.issueComment) {
    console.log("");
    if (result.flow.source.type === "github-issue") {
      console.log(result.commented ? "Issue comment posted." : "Suggested issue comment:");
      if (!result.commented) {
        console.log("");
        console.log(result.issueComment);
      }
    } else {
      console.log("No source issue. Ask the user whether to create a ticket for the record.");
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
  console.log(`Flow ${flow.id} -> blocked`);
}

async function runCheck(): Promise<void> {
  const result = await getService().check({ cwd: process.cwd() });
  console.log("# flow check");
  console.log("");
  if (result.ok) {
    console.log("All flows are consistent.");
    return;
  }
  console.log(`issues: ${result.issues.length}`);
  for (const issue of result.issues) {
    console.log(`- [${issue.kind}] ${issue.flow}: ${issue.message}`);
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
  console.log(`gd-metapro flow

Usage:
  gd-metapro flow init (--issue <url> | --title "<t>") [--slug <s>]
  gd-metapro flow list
  gd-metapro flow status <id>
  gd-metapro flow freeze <id>
  gd-metapro flow start <id>
  gd-metapro flow task add <id> --title "<t>" [--kind context|implement|test|review|docs]
  gd-metapro flow task done <id> <taskId>
  gd-metapro flow ac confirm <id> <ACn> [--note "<evidence>"]
  gd-metapro flow ac update <id> --reason "<why>"
  gd-metapro flow implemented <id> --pr <url>
  gd-metapro flow complete <id> [--comment]
  gd-metapro flow block <id> --reason "<why>" / flow unblock <id>
  gd-metapro flow check
`);
}
