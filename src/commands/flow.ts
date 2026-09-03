import path from "node:path";
import { optionValue } from "../lib/args";
import { writeFileAtomic } from "../lib/fs";
import { createFlowService } from "../flow/service";
import { durableExternalCommentsGate } from "../flow/review-gate";
import { flowStateSchema } from "../flow/schema";
import { duplicateFlowIds } from "../flow/store";
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
import { ATTEMPT_CLI_OUTCOMES } from "../flow/types";
import type {
  AttemptCliOutcome,
  FlowService,
  FlowServiceDeps,
  FlowStatus,
  TaskDisposition,
  TaskKind,
} from "../flow/types";

const VALID_TASK_KINDS: readonly TaskKind[] = ["context", "implement", "test", "verify", "review", "docs"];

function parseTaskKind(raw: string | undefined): TaskKind | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!(VALID_TASK_KINDS as readonly string[]).includes(raw)) {
    throw new Error(`Invalid --kind "${raw}". Expected one of: ${VALID_TASK_KINDS.join(", ")}`);
  }
  return raw as TaskKind;
}

/**
 * Positional args only. Without this, `flow task attempt --outcome started`
 * reads "--outcome" as the flow id and fails with "Flow not found: --outcome"
 * instead of showing the usage line.
 */
function positional(args: string[], index: number): string | undefined {
  const value = args[index];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

const VALID_DISPOSITIONS = ["completed", "blocked", "failed", "skipped"] as const;

/**
 * Validate `--disposition` instead of casting it.
 *
 * The first version of this cast the raw string straight to `TaskDisposition`.
 * A typo therefore reached disk verbatim, and because the gate asked
 * `=== "failed"` and `=== "skipped"` and nothing else, an unrecognised value
 * matched neither check and passed — `--disposition skiped` closed a task with
 * no warning from either the CLI guard or the gate. `flow check` caught it
 * afterwards through the schema enum, which is too late: the flow was already
 * `done`.
 */
function parseDisposition(raw: string | undefined): TaskDisposition | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!(VALID_DISPOSITIONS as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid --disposition "${raw}". Expected one of: ${VALID_DISPOSITIONS.join(", ")}`,
    );
  }
  return raw as TaskDisposition;
}

function parseAttemptOutcome(raw: string | undefined): AttemptCliOutcome {
  if (raw === undefined || !(ATTEMPT_CLI_OUTCOMES as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid --outcome "${raw ?? ""}". Expected one of: ${ATTEMPT_CLI_OUTCOMES.join(", ")}`,
    );
  }
  return raw as AttemptCliOutcome;
}

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

/**
 * The composition root: every dependency `flow complete` runs its gates with.
 *
 * Exported so a test can assert what the CLI is actually built from. That is
 * not ceremony — `externalCommentsGate` was declared on `FlowServiceDeps`, read
 * by `service.ts`, and supplied by two test cases and by nothing else, so the
 * seam existed everywhere except on the path an operator runs. A dependency
 * that only tests provide is a dependency that is not wired.
 */
export function flowServiceDeps(): FlowServiceDeps {
  return {
    tracker: githubAdapter,
    healthGate: async (cwd) => {
      const result = await createCodeHealthService().gate({ cwd });
      return { status: result.status, reasons: result.reasons };
    },
    securityGate: (cwd) => securityFlowGate(cwd),
    // The review gate's condition 4 (AC5), bound to the record
    // `keryx review comments collect|reply` writes. The seam was declared, read
    // by `service.ts`, and provided only by two test cases — so on the path an
    // operator actually runs it was never supplied, and the condition fell back
    // to a coverage name that any `--reviewers` value could produce.
    // `runReviewGate` also defaults to this collector, so forgetting the wiring
    // here cannot weaken the gate again; it is passed explicitly because the
    // dependency being visible at the composition root is the point of having it.
    externalCommentsGate: durableExternalCommentsGate,
    now: () => new Date(),
  };
}

function getService(): FlowService {
  service ??= createFlowService(flowServiceDeps());
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
        return await runList(args.slice(1));
      case "status":
        return await runStatus(args.slice(1));
      case "freeze":
        return await runSimple(args.slice(1), "freeze");
      case "start":
        return await runSimple(args.slice(1), "start");
      case "next":
        return await runNext(args.slice(1));
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
      case "renumber":
        return await runRenumber(args.slice(1));
      case "plan":
        return await runPlan(args.slice(1));
      case "schema":
        return await runSchema(args.slice(1));
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
    `Freeze and start: ${style.cyan(`keryx flow freeze ${result.flow.id}`)} then ${style.cyan(`flow start ${result.flow.id}`)}.`,
  ]);
}

async function runPlan(args: string[]): Promise<void> {
  const id = requireId(args);
  const cwd = process.cwd();
  const flow = await getService().get({ cwd, id });

  const { readFile } = await import("node:fs/promises");
  const pathMod = (await import("node:path")).default;
  const { resolveFlowDir } = await import("../flow/store");
  const dir = await resolveFlowDir(cwd, id);
  const read = async (name: string): Promise<string> => {
    try {
      return await readFile(pathMod.join(cwd, ".metaproject", "flows", dir, name), "utf8");
    } catch {
      return "(none)";
    }
  };
  const [description, ac] = await Promise.all([
    read("description.md"),
    read("acceptance-criteria.md"),
  ]);

  const { narrate } = await import("../lib/narrate");
  await narrate({
    args,
    requestId: `flow-plan:${flow.id}`,
    maxOutputTokens: 1200,
    system:
      "You are a tech lead decomposing a work item into atomic, verifiable implementation " +
      "tasks. Output a numbered task list; each task is small, independently testable, and " +
      "phrased as an action. Note ordering/dependencies where they matter. This is a " +
      "suggestion only — it does not modify flow state.",
    user: [
      `Flow ${flow.id}: ${flow.title}`,
      "",
      "Description:",
      description,
      "",
      "Acceptance criteria:",
      ac,
    ].join("\n"),
  });
}

async function runList(args: string[] = []): Promise<void> {
  const flows = await getService().list({ cwd: process.cwd() });
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        flows.map((flow) => ({
          id: flow.id,
          status: flow.status,
          title: flow.title,
          tasksDone: flow.tasksDone,
          tasksTotal: flow.tasksTotal,
          dir: flow.dir,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (flows.length === 0) {
    console.log(`  ${style.dim("No flows yet.")} Start one: ${style.cyan('keryx flow init --title "..."')}`);
    return;
  }
  // A number shared by two packages makes every bare-id command ambiguous —
  // say so here, where the listing is what usually reveals it.
  const shared = duplicateFlowIds(flows.map((flow) => flow.id));
  heading(`Flows (${flows.length})`);
  for (const flow of flows) {
    const marker = shared.has(flow.id) ? ` ${style.red(`${symbols.cross} duplicate id`)}` : "";
    console.log(
      `  ${style.bold(flow.id)}${marker} ${style.dim("[")}${flowStatusLabel(flow.status)}${style.dim("]")} ${flow.title} ${style.dim(`(tasks ${flow.tasksDone}/${flow.tasksTotal})`)}`,
    );
    console.log(`     ${style.dim(flow.dir)}`);
  }
  if (shared.size > 0) {
    note(
      `${shared.size} duplicated id(s). Repair with: keryx flow renumber <dir> --to <free id> --reason "<why>"`,
    );
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
    // Flow 209 AC6: the two v2 fields, on the screen an operator already reads.
    // Both were written, migrated and typed while nothing ever displayed them,
    // so an operator had to open flow.json to discover either — which is how a
    // field goes a release without anyone noticing it stayed at zero.
    const attempts = task.attempts?.count ?? 0;
    const declared = task.dependsOn ?? [];
    const annotations = [
      ...(declared.length === 0 ? [] : [`depends on ${declared.join(", ")}`]),
      ...(attempts === 0 ? [] : [`${attempts} attempt(s)`]),
    ];
    statusLine(
      `${task.id} ${task.title}${annotations.length === 0 ? "" : ` ${style.dim(`[${annotations.join("; ")}]`)}`}`,
      task.status === "done",
      task.kind,
    );
  }

  heading("Recent history");
  for (const event of flow.history.slice(-5)) {
    console.log(
      `  ${style.dim(event.at)} ${event.event}${event.detail ? style.dim(`: ${event.detail}`) : ""}`,
    );
  }
}

/**
 * `keryx flow next` — the resume decision, computed from `dependsOn` (flow 209,
 * AC6).
 *
 * `flow-orchestrator` has documented "resume at the first task not done,
 * respecting `dependsOn` order" since the field was added, and until now nothing
 * computed it: `dependsOn` was written by `flow task add --depends`, migrated by
 * the store, typed in `types.ts`, and read by nothing. An agent resuming a flow
 * re-derived the order from prose, which is the same as not having the field.
 *
 * Exits non-zero when work remains and nothing is startable. That state is a
 * declared cycle or a typo, and reporting it as "nothing to do" would let a flow
 * close over open work.
 */
async function runNext(args: string[]): Promise<void> {
  const id = requireId(args);
  const decision = await getService().next({ cwd: process.cwd(), id });

  if (args.includes("--json")) {
    console.log(JSON.stringify(decision, null, 2));
    if (decision.kind === "blocked") {
      process.exitCode = 1;
    }
    return;
  }

  if (decision.kind === "ready") {
    console.log(
      `  ${style.cyan(symbols.arrow)} ${style.bold(decision.task.id)} ${decision.task.title} ${style.dim(`(${decision.task.kind})`)}`,
    );
    const declared = decision.task.dependsOn ?? [];
    note(
      declared.length === 0
        ? "no declared dependencies; this is the first task that is not done"
        : `all declared dependencies are done: ${declared.join(", ")}`,
    );
    return;
  }

  if (decision.kind === "none") {
    console.log(`  ${style.green(symbols.ok)} Every task is done.`);
    return;
  }

  heading(`${style.red(symbols.cross)} ${decision.blocked.length} task(s) remain and none can start`);
  for (const entry of decision.blocked) {
    console.log(
      `  ${style.red(symbols.cross)} ${style.bold(entry.task.id)} ${entry.task.title} ${style.dim(`waiting on ${entry.waitingOn.join(", ")}`)}`,
    );
  }
  note(
    "A dependency that is not done, does not exist, or forms a cycle. `keryx flow check` names which.",
  );
  process.exitCode = 1;
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
      throw new Error('Usage: keryx flow task add <id> --title "<t>" [--kind context|implement|test|verify|review|docs] [--depends T1,T2]');
    }
    const dependsRaw = optionValue(args, "--depends");
    const dependsOn = dependsRaw
      ? dependsRaw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean)
      : undefined;
    const flow = await getService().taskAdd({
      cwd: process.cwd(),
      id,
      title,
      kind: parseTaskKind(optionValue(args, "--kind")),
      dependsOn,
    });
    console.log(`  ${style.green(symbols.ok)} Added ${style.bold(flow.tasks[flow.tasks.length - 1]?.id ?? "task")} to flow ${flow.id}`);
    return;
  }
  if (sub === "done") {
    const id = positional(args, 1);
    const taskId = positional(args, 2);
    if (!id || !taskId) {
      throw new Error(
        'Usage: keryx flow task done <id> <taskId> [--disposition completed|blocked|failed|skipped] [--reason "<why>"]',
      );
    }
    const disposition = parseDisposition(optionValue(args, "--disposition"));
    const reason = optionValue(args, "--reason");
    const flow = await getService().taskDone({
      cwd: process.cwd(),
      id,
      taskId,
      disposition,
      reason,
    });
    const done = flow.tasks.filter((task) => task.status === "done").length;
    console.log(`  ${style.green(symbols.ok)} Task ${style.bold(taskId.toUpperCase())} done ${style.dim(`(${done}/${flow.tasks.length})`)}`);
    // Say it here rather than at `flow complete`, where the flow is already
    // being closed and the fix is a round trip away.
    if (disposition === "skipped" && !reason?.trim()) {
      note(
        'A skipped task without --reason "<why>" fails the task gate at `keryx flow complete`. ' +
          "Re-run with a reason to record why the work was not needed.",
      );
    }
    if (disposition === "blocked") {
      note(
        "A blocked task fails the task gate at `keryx flow complete` — it is recorded as terminal, " +
          "but the work did not happen. Resolve it, or close it as skipped with a reason.",
      );
    }
    return;
  }
  if (sub === "attempt") {
    const id = positional(args, 1);
    const taskId = positional(args, 2);
    if (!id || !taskId) {
      throw new Error(
        `Usage: keryx flow task attempt <id> <taskId> --outcome ${ATTEMPT_CLI_OUTCOMES.join("|")} [--detail "<what happened>"]`,
      );
    }
    const flow = await getService().taskAttempt({
      cwd: process.cwd(),
      id,
      taskId,
      outcome: parseAttemptOutcome(optionValue(args, "--outcome")),
      detail: optionValue(args, "--detail"),
    });
    const task = flow.tasks.find((item) => item.id.toUpperCase() === taskId.toUpperCase());
    console.log(
      `  ${style.green(symbols.ok)} Attempt recorded on ${style.bold(taskId.toUpperCase())} ${style.dim(`(count ${task?.attempts?.count ?? 0})`)}`,
    );
    return;
  }
  throw new Error("Usage: keryx flow task <add|done|attempt> ...");
}

async function runAc(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "confirm") {
    const id = args[1];
    const criterion = args[2];
    if (!id || !criterion) {
      throw new Error('Usage: keryx flow ac confirm <id> <ACn> [--note "<evidence>"]');
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
      throw new Error('Usage: keryx flow ac update <id> --reason "<why>"');
    }
    await getService().acUpdate({ cwd: process.cwd(), id, reason });
    console.log(`  ${style.green(symbols.ok)} Acceptance criteria re-frozen; ${style.dim("prior confirmations cleared")}.`);
    return;
  }
  if (sub === "reseal") {
    const id = requireId(args.slice(1));
    const reason = optionValue(args, "--reason");
    if (!reason) {
      throw new Error('Usage: keryx flow ac reseal <id> --reason "<why the checksum is stale>"');
    }
    const flow = await getService().acReseal({ cwd: process.cwd(), id, reason });
    console.log(
      `  ${style.green(symbols.ok)} Checksum re-sealed over the unchanged file; ` +
        `${style.dim(`${Object.keys(flow.acConfirmed).length} confirmation(s) kept`)}.`,
    );
    return;
  }
  throw new Error("Usage: keryx flow ac <confirm|update|reseal> ...");
}

async function runImplemented(args: string[]): Promise<void> {
  const id = requireId(args);
  const prUrl = optionValue(args, "--pr");
  if (!prUrl) {
    throw new Error("Usage: keryx flow implemented <id> --pr <draft PR url>");
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
    mergedCommit: optionValue(args, "--merged"),
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
    // A failing gate has to say WHICH condition failed and for which findings —
    // one line per condition rather than one line per gate, because the review
    // gate reports five and a single wrapped line hides four of them.
    const [first = "", ...rest] = gate.detail.split(" | ");
    console.log(`  ${mark} ${gate.name} ${style.dim(`(${first}${rest.length === 0 ? ")" : ""}`)}`);
    for (const [index, line] of rest.entries()) {
      console.log(`      ${style.dim(`${line}${index === rest.length - 1 ? ")" : ""}`)}`);
    }
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
    throw new Error('Usage: keryx flow block <id> --reason "<why>"');
  }
  const flow = await getService().block({ cwd: process.cwd(), id, reason });
  console.log(`  ${style.yellow(symbols.cross)} Flow ${flow.id} ${style.cyan(symbols.arrow)} ${flowStatusLabel(flow.status)}`);
}

async function runSchema(args: string[]): Promise<void> {
  const json = `${JSON.stringify(flowStateSchema(), null, 2)}\n`;
  const out = optionValue(args, "--out");
  if (out) {
    const target = path.isAbsolute(out) ? out : path.join(process.cwd(), out);
    await writeFileAtomic(target, json);
    console.log(`  ${style.green(symbols.ok)} Wrote flow-state schema ${style.cyan(symbols.arrow)} ${out}`);
    return;
  }
  process.stdout.write(json);
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

async function runRenumber(args: string[]): Promise<void> {
  const ref = requireId(args);
  const to = optionValue(args, "--to");
  const reason = optionValue(args, "--reason");
  if (!to || !reason) {
    throw new Error('Usage: keryx flow renumber <dir> --to <id> --reason "<why>"');
  }
  const result = await getService().renumber({ cwd: process.cwd(), ref, to, reason });
  console.log(
    `  ${style.green(symbols.ok)} Flow ${style.bold(result.from)} ${style.cyan(symbols.arrow)} ${style.bold(result.to)}`,
  );
  note(`${result.fromDir} ${symbols.arrow} ${result.toDir}`);
  nextSteps([
    `Commit the move together with ${style.cyan(".metaproject/flows/id-map.json")}.`,
    `Old references to flow ${result.from} stay valid through the id map.`,
  ]);
}

function requireId(args: string[]): string {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    throw new Error("Missing flow id. Run: keryx flow list");
  }
  return id;
}

function printHelp(): void {
  helpTitle("keryx flow", "agent-first managed work (flows)");
  helpUsage([
    'keryx flow init (--issue <url> | --title "<t>") [--slug <s>]',
    "keryx flow list",
    "keryx flow status <id>",
    "keryx flow freeze <id>",
    "keryx flow start <id>",
    "keryx flow next <id> [--json]   (first task not done whose dependsOn are all done)",
  'keryx flow task add <id> --title "<t>" [--kind context|implement|test|verify|review|docs] [--depends T1,T2]',
    'keryx flow task done <id> <taskId> [--disposition completed|blocked|failed|skipped] [--reason "<why>"]',
    'keryx flow task attempt <id> <taskId> --outcome started|failed|blocked [--detail "<what happened>"]',
    'keryx flow ac confirm <id> <ACn> [--note "<evidence>"]',
    'keryx flow ac update <id> --reason "<why>"   (criteria changed; VOIDS prior confirmations)',
    'keryx flow ac reseal <id> --reason "<why>"   (checksum stale, file unchanged; KEEPS confirmations)',
    "keryx flow implemented <id> --pr <url>",
    "keryx flow complete <id> [--comment] [--merged <commit>]",
    'keryx flow block <id> --reason "<why>"   /   flow unblock <id>',
    "keryx flow check",
    'keryx flow renumber <dir> --to <id> --reason "<why>"   (repair a duplicate id)',
    "keryx flow plan <id> [--provider <p>] [--json]   (model-suggested task breakdown)",
    "keryx flow schema [--out <path>]",
  ]);
}
