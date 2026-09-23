import path from "node:path";
import { optionValue } from "../lib/args";
import { writeFileAtomic } from "../lib/fs";
import { createFlowService } from "../flow/service";
import { durableExternalCommentsGate } from "../flow/review-gate";
import { flowStateSchema } from "../flow/schema";
import { duplicateFlowIds } from "../flow/store";
import { githubAdapter } from "../flow/tracker/github";
import { repairMovedFlowReviewRecords } from "../review/flow-move";
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
import { taskResumeState, type TaskResumeState } from "../flow/machine";
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

/**
 * Marker for "the record cannot answer this", kept distinct from `symbols.ok`
 * and `symbols.cross`. An unresolved attempt is neither a pass nor a failure,
 * and borrowing either symbol would put it in the wrong bucket at a glance.
 */
const WARN = "!";

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

/**
 * Tokenize, validate, and extract flag values for one `flow ac` subcommand,
 * in a single pass — replacing `rejectUnusedAcArgs` + separate `optionValue`
 * calls (flow 293 T9, review finding #4).
 *
 * The two-pass version had a `flow ac confirm <id> AC1 --note "--dry-run
 * mode was used"` bug: `optionValue`'s generic rule — "the next token is a
 * value only if it does not itself start with `--`" — exists to stop
 * `--runtime --json` from reading `--json` as `--runtime`'s value, but it
 * also means a value that legitimately STARTS WITH `--` (quoted text, here)
 * is never consumed as one. The strict-argument check then saw that same
 * unconsumed string as its own token, and because it too starts with `--`,
 * reported it as an unrecognised flag — refusing a legitimate confirm with a
 * misleading `unknown option --dry-run mode was used…`. Every flag `flow ac`
 * accepts is a value flag (there are no booleans here), so this function
 * knows that once and applies it once: a recognised flag ALWAYS consumes the
 * very next token as its value, whatever that token looks like — UNLESS the
 * next token is itself one of this subcommand's known flag names, which is
 * refused by name (`missing value for --note`) rather than silently eating
 * the next flag as if it were text.
 *
 * This is still the `rejectUnknownFlags` precedent from `keryx review`
 * (`src/commands/review.ts:363-374`) — "refused rather than ignored" —
 * extended to the positional count (an extra positional, e.g. the AC3
 * regression's stray `AC1`, is the same failure as an unrecognised flag) and
 * now also to value extraction, so the check and the value a caller reads
 * can never disagree about what a flag's value was.
 */
function parseAcArgs(
  args: readonly string[],
  usage: string,
  allowedFlags: readonly string[],
  maxPositionals: number,
): { positionals: string[]; values: Map<string, string> } {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const problems: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 0) {
      const name = token.slice(0, equals);
      if (allowedFlags.includes(name)) {
        values.set(name, token.slice(equals + 1));
      } else {
        problems.push(`unknown option ${name}`);
      }
      continue;
    }
    if (!allowedFlags.includes(token)) {
      problems.push(`unknown option ${token}`);
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || allowedFlags.includes(next)) {
      problems.push(`missing value for ${token}`);
      continue;
    }
    values.set(token, next);
    index += 1;
  }
  const problemsWithPositionals = [
    ...positionals.slice(maxPositionals).map((value) => `unexpected argument "${value}"`),
    ...problems,
  ];
  if (problemsWithPositionals.length > 0) {
    const positionalNote =
      maxPositionals > 0 ? `, and ${maxPositionals} positional argument${maxPositionals > 1 ? "s" : ""}` : "";
    throw new Error(
      `Refused for \`keryx flow ac ${usage}\`: ${problemsWithPositionals.join(", ")}. ` +
        `Accepted: ${allowedFlags.length > 0 ? allowedFlags.join(", ") : "(no flags)"}${positionalNote}. ` +
        "Refused rather than ignored — an argument that is silently dropped changes nothing and reports success.",
    );
  }
  return { positionals, values };
}

const AC_CONFIRM_FLAGS = ["--note", "--signed-by"] as const;
const AC_UPDATE_FLAGS = ["--reason", "--criterion", "--text"] as const;
const AC_RESEAL_FLAGS = ["--reason"] as const;

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
/**
 * A comma-separated option as a trimmed, de-duplicated list.
 *
 * Returns `undefined` when the flag is absent, so an omitted flag leaves an
 * existing value alone, while `--ac ""` clears it — the two are different
 * intentions and collapsing them would make a field impossible to unset.
 */
function listOption(args: string[], flag: string): string[] | undefined {
  const raw = optionValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value.length > 0) {
      seen.add(value);
    }
  }
  return [...seen];
}

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

/**
 * The local git identity, or undefined (flow 289, AC3).
 *
 * Mirrors `gitUserEmail` in `src/commands/sync.ts` exactly, colocated here
 * rather than imported: read at the command layer (never inside
 * `FlowService`, which stays free of process spawning and stays testable
 * without mocking git), and passed in as `gitIdentity` — the weakest, always
 * `derived`, never-promoted-to-`stated` input to `resolveSignerIdentity`.
 * Undefined is a real answer here and is passed through as such: it becomes
 * an `unknown` signer, never a blank or a fabricated one.
 */
async function readGitUserEmail(cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "config", "user.email"], { cwd, stdout: "pipe", stderr: "ignore" });
    if ((await proc.exited) !== 0) {
      return undefined;
    }
    const value = (await new Response(proc.stdout).text()).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Signer identity inputs shared by `flow ac confirm` and `flow complete`
 * (AC3, AC4). Takes the already-resolved `--signed-by` value rather than
 * re-parsing `args` itself: `flow complete` still resolves it via the
 * generic `optionValue`, while `flow ac confirm` resolves it via
 * {@link parseAcArgs} (flow 293 T9, review finding #4) — one function, two
 * value sources, so the two commands' different flag-parsing rules never
 * have to agree with each other, only each with its own caller.
 */
async function signerIdentityArgs(
  cwd: string,
  signedBy: string | undefined,
): Promise<{ signedBy: string | undefined; signedByEnv: string | undefined; gitIdentity: string | undefined }> {
  return {
    signedBy,
    signedByEnv: process.env["KERYX_ACTOR"],
    gitIdentity: await readGitUserEmail(cwd),
  };
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
      case "owner":
        return await runOwner(args.slice(1));
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
      case "repair-reviews":
        return await runRepairReviews();
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
    // The branch this work is told to land on. Recorded now because the
    // completion gate has no other way to learn the INTENT: reading the pull
    // request's base when the gate runs asks where it points today, which a
    // retargeted PR answers in its own favour.
    baseBranch: optionValue(args, "--base"),
    // Never inferred (AC1): only an explicit --owner populates it.
    owner: optionValue(args, "--owner"),
  });
  banner("flow init", `Created flow ${result.flow.id}`);
  console.log(`  ${style.green(symbols.ok)} ${style.bold(result.flow.title)}`);
  note(result.dir);
  console.log(`  status: ${flowStatusLabel(result.flow.status)}`);
  if (result.flow.baseBranch !== undefined) {
    console.log(`  base:   ${result.flow.baseBranch}`);
  }
  console.log(`  owner:  ${result.flow.owner?.value ?? style.dim("not set")}`);
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
  // Flow 289, AC7: owner and the latest signature, in the same line style as
  // the rows above — no reader should have to open flow.json by hand to
  // learn who owns or last signed this flow.
  console.log(
    `  owner:   ${flow.owner?.value ? `${flow.owner.value} ${style.dim(`[${flow.owner.basis}]`)}` : style.dim("not set")}`,
  );
  const latestSignature = flow.signatures?.at(-1);
  console.log(
    `  signed:  ${
      latestSignature
        ? `${latestSignature.identity.value ?? "unknown"} ${style.dim(`[${latestSignature.identity.basis}]`)} ${style.dim(`(${latestSignature.kind}, ${latestSignature.at})`)}`
        : style.dim("no signatures yet")
    }`,
  );

  const doneCount = flow.tasks.filter((task) => task.status === "done").length;
  const unresolvedTasks: string[] = [];
  heading(`Tasks (${doneCount}/${flow.tasks.length})`);
  for (const task of flow.tasks) {
    // Flow 209 AC6: the two v2 fields, on the screen an operator already reads.
    // Both were written, migrated and typed while nothing ever displayed them,
    // so an operator had to open flow.json to discover either — which is how a
    // field goes a release without anyone noticing it stayed at zero.
    const attempts = task.attempts?.count ?? 0;
    const declared = task.dependsOn ?? [];
    // A bare count says "1 attempt(s)" for an attempt that failed and closed and
    // for an attempt that opened and never came back. Those call for different
    // acts on resume, so the openness — not just the number — is on the line.
    const resume = taskResumeState(task);
    const annotations = [
      ...(declared.length === 0 ? [] : [`depends on ${declared.join(", ")}`]),
      ...(attempts === 0 ? [] : [`${attempts} attempt(s)`]),
      ...(resume.kind === "unresolved" ? [`${resume.reason}: outcome UNKNOWN`] : []),
    ];
    statusLine(
      `${task.id} ${task.title}${annotations.length === 0 ? "" : ` ${style.dim(`[${annotations.join("; ")}]`)}`}`,
      task.status === "done",
      task.kind,
    );
    if (resume.kind === "unresolved") {
      unresolvedTasks.push(task.id);
    }
  }
  if (unresolvedTasks.length > 0) {
    note(
      `${unresolvedTasks.join(", ")}: an attempt was opened and no end was recorded. Whether that work landed cannot be told from this record — resolve it before redoing or closing the task.`,
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
 * The one sentence a resuming or handed-off agent needs, in words that differ
 * between the three answers it must not confuse.
 *
 * `unresolved` is deliberately phrased as ignorance rather than as a diagnosis.
 * "The previous agent crashed" would be a guess: an open attempt is equally
 * consistent with another agent still working, because the flow lock covers one
 * mutation and not one task. What is certain is only that no end was recorded,
 * and that this build cannot tell from the record whether the work landed.
 */
function resumeSummary(taskId: string, resume: TaskResumeState): string | null {
  switch (resume.kind) {
    case "done":
      return `${taskId} is already done.`;
    case "never-started":
      return `${taskId} has no recorded attempt: nothing has been tried yet.`;
    case "ended":
      return `${taskId} has ${resume.attempts} recorded attempt(s); the last one ended ${resume.outcome} at ${resume.at}. This would be attempt ${resume.attempts + 1}.`;
    case "unresolved":
      return resume.reason === "attempt-not-closed"
        ? `${taskId} has an attempt opened at ${resume.openedAt} that never recorded an end. Whether its work partially landed is UNKNOWN — this is not the same as "not started". Inspect the tree before redoing it, then close the attempt with \`keryx flow task attempt <flow> ${taskId} --outcome failed|blocked\` or \`keryx flow task done\`.${resume.detail ? ` Last detail: ${resume.detail}` : ""}`
        : `${taskId} has an attempt record this build cannot read as complete (${resume.reason}, ${resume.attempts} claimed). What was already tried is UNKNOWN — do not treat it as "not started".`;
  }
}

/** Print the resume state of the task the caller is about to pick up. */
function reportResume(taskId: string, resume: TaskResumeState): void {
  const summary = resumeSummary(taskId, resume);
  if (!summary) {
    return;
  }
  if (resume.kind === "unresolved") {
    console.log(`  ${style.yellow(WARN)} ${summary}`);
    return;
  }
  note(summary);
}

/**
 * Unresolved tasks OTHER than the one being handed back.
 *
 * A flow can have several tasks dispatched at once; reporting only the next one
 * would hide every other interrupted attempt behind it until it closed, which is
 * the same silence one task over.
 */
function reportOtherUnresolved(
  unresolved: ReadonlyArray<{ task: { id: string }; resume: TaskResumeState }>,
  exclude: string | null,
): void {
  const others = unresolved.filter((entry) => entry.task.id !== exclude);
  if (others.length === 0) {
    return;
  }
  heading(
    `${style.yellow(WARN)} ${others.length} other task(s) carry an attempt with no recorded end`,
  );
  for (const entry of others) {
    const summary = resumeSummary(entry.task.id, entry.resume);
    if (summary) {
      console.log(`  ${style.yellow(WARN)} ${summary}`);
    }
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
    // The line that used to be missing. Without it the two sentences above were
    // the WHOLE answer, and they read identically for a task nobody has touched
    // and a task an agent started and never closed.
    reportResume(decision.task.id, decision.resume);
    reportOtherUnresolved(decision.unresolved, decision.task.id);
    return;
  }

  if (decision.kind === "none") {
    console.log(`  ${style.green(symbols.ok)} Every task is done.`);
    reportOtherUnresolved(decision.unresolved, null);
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
  reportOtherUnresolved(decision.unresolved, null);
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
  if (sub === "depends") {
    const id = positional(args, 1);
    const taskId = positional(args, 2);
    const on = optionValue(args, "--on");
    const reason = optionValue(args, "--reason");
    if (!id || !taskId || on === undefined || !reason) {
      throw new Error(
        'Usage: keryx flow task depends <id> <taskId> --on T1,T2|none --reason "<why>"',
      );
    }
    // `--on none` and `--on ""` both mean "no dependencies". Spelling the empty
    // case explicitly keeps clearing the field from looking like a forgotten flag.
    const dependsOn =
      on.trim().toLowerCase() === "none" || on.trim() === ""
        ? []
        : on.split(",").map((value) => value.trim()).filter(Boolean);
    const flow = await getService().taskDepends({ cwd: process.cwd(), id, taskId, dependsOn, reason });
    const task = flow.tasks.find((item) => item.id.toUpperCase() === taskId.toUpperCase());
    const now = task?.dependsOn ?? [];
    console.log(
      `  ${style.green(symbols.ok)} ${style.bold(task?.id ?? taskId)} depends on ` +
        `${now.length > 0 ? style.cyan(now.join(", ")) : style.dim("nothing")}`,
    );
    return;
  }
  if (sub === "done") {
    const id = positional(args, 1);
    const taskId = positional(args, 2);
    if (!id || !taskId) {
      throw new Error(
        'Usage: keryx flow task done <id> <taskId> [--disposition completed|blocked|failed|skipped] [--reason "<why>"] [--ac AC1,AC2] [--evidence <path|ref>,...]',
      );
    }
    const disposition = parseDisposition(optionValue(args, "--disposition"));
    const reason = optionValue(args, "--reason");
    // `acRefs` and `evidenceRefs` have been in the task schema since v2 with no
    // way to set them from the command line, so every task in every flow of
    // this programme carries two empty arrays where the trace from work to
    // criterion was supposed to be. The fields were not missing; the writer
    // was.
    const acRefs = listOption(args, "--ac");
    const evidenceRefs = listOption(args, "--evidence");
    const flow = await getService().taskDone({
      cwd: process.cwd(),
      id,
      taskId,
      disposition,
      reason,
      acRefs,
      evidenceRefs,
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
  throw new Error("Usage: keryx flow task <add|depends|done|attempt> ...");
}

async function runOwner(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "set") {
    const id = requireId(args.slice(1));
    const owner = optionValue(args, "--owner");
    const reason = optionValue(args, "--reason");
    if (!owner || !reason) {
      throw new Error('Usage: keryx flow owner set <id> --owner "<name>" --reason "<why>"');
    }
    const flow = await getService().ownerSet({ cwd: process.cwd(), id, owner, reason });
    console.log(
      `  ${style.green(symbols.ok)} Owner ${style.cyan(symbols.arrow)} ${style.bold(flow.owner?.value ?? owner)}`,
    );
    return;
  }
  throw new Error('Usage: keryx flow owner set <id> --owner "<name>" --reason "<why>"');
}

async function runAc(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "confirm") {
    const { positionals, values } = parseAcArgs(args.slice(1), "confirm", AC_CONFIRM_FLAGS, 2);
    const id = positionals[0];
    const criterion = positionals[1];
    if (!id || !criterion) {
      throw new Error('Usage: keryx flow ac confirm <id> <ACn> [--note "<evidence>"] [--signed-by "<name>"]');
    }
    const cwd = process.cwd();
    const flow = await getService().acConfirm({
      cwd,
      id,
      criterion,
      note: values.get("--note"),
      ...(await signerIdentityArgs(cwd, values.get("--signed-by"))),
    });
    console.log(`  ${style.green(symbols.ok)} Confirmed ${style.bold(criterion.toUpperCase())} ${style.dim(`(${Object.keys(flow.acConfirmed).length} total)`)}`);
    const signature = flow.signatures?.at(-1);
    if (signature) {
      note(`Signed: ${signature.identity.value ?? "unknown"} [${signature.identity.basis}] — ${signature.identity.source}`);
    }
    return;
  }
  if (sub === "update") {
    const { positionals, values } = parseAcArgs(args.slice(1), "update", AC_UPDATE_FLAGS, 1);
    const id = requireId(positionals);
    const reason = values.get("--reason");
    const criterion = values.get("--criterion");
    const text = values.get("--text");
    if ((criterion === undefined) !== (text === undefined)) {
      throw new Error(
        'Usage: keryx flow ac update <id> --criterion ACn --text "<criterion>" --reason "<why>" ' +
          '(both --criterion and --text together), or keryx flow ac update <id> --reason "<why>" (neither).',
      );
    }
    if (!reason) {
      throw new Error(
        'Usage: keryx flow ac update <id> --reason "<why>" [--criterion ACn --text "<criterion>"]',
      );
    }
    // Was `criterion` already one of the known ACs, or is this call about to
    // APPEND the next unused one? Read before the mutation — `acUpdate`
    // itself makes exactly this same check internally (service.ts) to decide
    // whether to replace a line or append one, but its return value is a
    // plain `FlowState` with nowhere to report which one happened, so the
    // caller re-asks the same read-only question rather than the service
    // widening its return shape for one CLI print line.
    const cwd = process.cwd();
    let wasKnownCriterion = false;
    if (criterion !== undefined) {
      const { readAcCriteria, resolveFlowDir } = await import("../flow/store");
      const dir = await resolveFlowDir(cwd, id);
      wasKnownCriterion = (await readAcCriteria(cwd, dir)).includes(criterion.toUpperCase());
    }
    await getService().acUpdate({ cwd, id, reason, criterion, text });
    if (criterion && text) {
      console.log(
        `  ${style.green(symbols.ok)} ${style.bold(criterion.toUpperCase())} ${wasKnownCriterion ? "rewritten" : "appended"}; ` +
          `${style.dim("acceptance criteria re-frozen, prior confirmations cleared")}.`,
      );
    } else {
      console.log(`  ${style.green(symbols.ok)} Acceptance criteria re-frozen; ${style.dim("prior confirmations cleared")}.`);
    }
    return;
  }
  if (sub === "reseal") {
    const { positionals, values } = parseAcArgs(args.slice(1), "reseal", AC_RESEAL_FLAGS, 1);
    const id = requireId(positionals);
    const reason = values.get("--reason");
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
  throw new Error(
    'Usage: keryx flow ac <confirm <id> <ACn> | update <id> --reason "<why>" [--criterion ACn --text "<criterion>"] | reseal <id> --reason "<why>"> ...',
  );
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
  const cwd = process.cwd();
  const result = await getService().complete({
    cwd,
    id,
    comment: args.includes("--comment"),
    mergedCommit: optionValue(args, "--merged"),
    ...(await signerIdentityArgs(cwd, optionValue(args, "--signed-by"))),
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
  if (result.passed) {
    const signature = result.flow.signatures?.at(-1);
    if (signature) {
      // AC8: never present a stated/derived identity as proof of a human —
      // only `stated` says so much as "explicitly claimed", and `derived`
      // says outright that it is a weaker guess.
      const caveat =
        signature.identity.basis === "unknown"
          ? "no identity was available; this completion is signed as unknown."
          : `this is a ${signature.identity.basis} claim (${signature.identity.source}), not proof a human signed.`;
      note(`Signed by: ${signature.identity.value ?? "unknown"} [${signature.identity.basis}] — ${caveat}`);
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
  const { rewritten, unreadable } = result.reviewRecords;
  if (rewritten.length > 0) {
    note(`${rewritten.length} review record(s) re-pointed at flow ${result.to}`);
  }
  for (const file of unreadable) {
    note(`left unchanged, could not be parsed: ${file}`);
  }
  // Review notes live outside the flow directory, so they are named here or
  // they get left out of the commit.
  const outside = rewritten.filter((file) => !file.startsWith(`.metaproject/flows/${result.toDir}/`));
  nextSteps([
    `Commit the move together with ${[".metaproject/flows/id-map.json", ...outside].map((file) => style.cyan(file)).join(", ")}.`,
    `id-map.json records ${result.from} ${symbols.arrow} ${result.to} for references outside the repository (PR titles, commit messages); \`keryx flow\` commands take the new id only.`,
  ]);
}

// Flows renumbered before `renumber` rewrote review records still name their
// old id. One pass over id-map.json re-points them; a second pass finds nothing.
async function runRepairReviews(): Promise<void> {
  const { rewritten, unreadable } = await repairMovedFlowReviewRecords(process.cwd());
  if (rewritten.length === 0) {
    console.log(`  ${style.green(symbols.ok)} Every renumbered flow's review records already name its current id.`);
  } else {
    console.log(`  ${style.green(symbols.ok)} ${rewritten.length} review record(s) re-pointed at their flow's current id`);
    for (const file of rewritten) {
      note(file);
    }
  }
  for (const file of unreadable) {
    note(`left unchanged, could not be parsed: ${file}`);
  }
  if (rewritten.length > 0) {
    nextSteps(["Review the diff, then commit the rewritten records listed above."]);
  }
}

function requireId(args: string[]): string {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    throw new Error("Missing flow id. Run: keryx flow list");
  }
  return id;
}

/**
 * The single source of truth for `keryx flow`'s own help — also called
 * directly by `src/cli.ts` for the top-level `keryx flow --help` (AC5, flow
 * 294): the static `USAGE_BODY` slice `groupUsage` used to intercept with
 * listed only `init`/`list`/`status`/`complete`, silently omitting
 * `freeze`/`start`/`next`/`task`/`owner`/`ac`/`implemented`/`block`/`unblock`/
 * `check`/`renumber`/`repair-reviews`/`plan`/`schema` — a second copy of this
 * same list that had already drifted from it.
 */
export function printFlowHelp(): void {
  printHelp();
}

function printHelp(): void {
  helpTitle("keryx flow", "agent-first managed work (flows)");
  helpUsage([
    'keryx flow init (--issue <url> | --title "<t>") [--slug <s>] [--base <branch>] [--owner "<name>"]',
    "keryx flow list",
    "keryx flow status <id>",
    "keryx flow freeze <id>",
    "keryx flow start <id>",
    "keryx flow next <id> [--json]   (first task not done whose dependsOn are all done)",
  'keryx flow task add <id> --title "<t>" [--kind context|implement|test|verify|review|docs] [--depends T1,T2]',
    'keryx flow task done <id> <taskId> [--disposition completed|blocked|failed|skipped] [--reason "<why>"]',
    'keryx flow task attempt <id> <taskId> --outcome started|failed|blocked [--detail "<what happened>"]',
    'keryx flow task depends <id> <taskId> --on T1,T2|none --reason "<why>"   (repair an unsatisfiable dependsOn)',
    'keryx flow owner set <id> --owner "<name>" --reason "<why>"   (the human accountable; never inferred)',
    'keryx flow ac confirm <id> <ACn> [--note "<evidence>"] [--signed-by "<name>"]',
    'keryx flow ac update <id> --reason "<why>"   (re-freeze the file as already edited; VOIDS prior confirmations)',
    'keryx flow ac update <id> --criterion ACn --text "<criterion>" --reason "<why>"   (rewrite/append that one criterion, then re-freeze; VOIDS prior confirmations)',
    'keryx flow ac reseal <id> --reason "<why>"   (checksum stale, file unchanged; KEEPS confirmations)',
    "  every `flow ac` subcommand refuses an argument it does not use — an extra positional, an unknown flag, or --criterion/--text given alone",
    "keryx flow implemented <id> --pr <url>",
    'keryx flow complete <id> [--comment] [--merged <commit>] [--signed-by "<name>"]',
    'keryx flow block <id> --reason "<why>"   /   flow unblock <id>',
    "keryx flow check",
    'keryx flow renumber <dir> --to <id> --reason "<why>"   (repair a duplicate id)',
    "keryx flow repair-reviews   (re-point review records of flows renumbered before renumber rewrote them)",
    "keryx flow plan <id> [--provider <p>] [--json]   (model-suggested task breakdown)",
    "keryx flow schema [--out <path>]",
  ]);
  note(
    "`--signed-by` names the signer explicitly (stated). Falls back to KERYX_ACTOR (also " +
      "stated), then to `git config user.email` in this checkout (derived — the person who " +
      "RAN the command, not necessarily who signed), then to `unknown`. None of these is proof " +
      "a human signed: a flag, an environment variable, and a local git identity can all be set " +
      "by an agent. `--owner` is never inferred at all — see docs/decisions/keryx-harness/.",
  );
}
