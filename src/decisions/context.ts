// Flow 392: which flow, and which stage of it, a question belongs to.
//
// An agent that asks through `ask_user` does not say. Without this every such
// question was recorded as flow = null, stage = "ask_user" and left no line in the
// flow's journal.md, so the report could not tell the stages apart. The context
// is derived, in this order, from the first source that names exactly one flow:
//
//   1. KERYX_FLOW, when the harness or the operator set it
//   2. the git branch: a flow number ("flow-392", "392-...") or the slug of a
//      flow ("feat/flow-f-recommendation-journal" carries "recommendation-journal")
//   3. the only flow in progress (several in progress is ambiguous: no guess)
//
// The stage is the kind of the task in progress (implement, test, review, ...),
// else the flow's status; outside a flow it stays the caller's default.

import { flowIdOf, listFlowDirs, readFlow, resolveFlowDir } from "../flow/store";

export interface FlowContext {
  flow?: string | undefined;
  stage?: string | undefined;
}

/** How many of the newest flows step 3 inspects: a flow in progress is a recent one. */
const RECENT_FLOWS = 30;
const MIN_SLUG_LENGTH = 6;

async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0 || out.length === 0 || out === "HEAD") return undefined;
    return out;
  } catch {
    return undefined;
  }
}

function fromBranch(branch: string, dirs: readonly string[]): string | undefined {
  const lower = branch.toLowerCase();
  const number = /(?:^|[/_-])flow[-/_]?(\d{1,4})(?![\d])/.exec(lower) ?? /(?:^|\/)(\d{3})-/.exec(lower);
  if (number?.[1] !== undefined) {
    const id = number[1].padStart(3, "0");
    const matches = dirs.filter((dir) => flowIdOf(dir) === id);
    if (matches.length === 1) return id;
  }
  const bySlug = dirs.filter((dir) => {
    const slug = dir.slice(15).toLowerCase();
    return slug.length >= MIN_SLUG_LENGTH && lower.includes(slug);
  });
  const ids = [...new Set(bySlug.map(flowIdOf))];
  return ids.length === 1 && bySlug.length === 1 ? ids[0] : undefined;
}

async function stageOf(cwd: string, dir: string): Promise<string | undefined> {
  try {
    const flow = await readFlow(cwd, dir);
    const active = flow.tasks.find((task) => task.status === "in-progress");
    return active?.kind ?? flow.status;
  } catch {
    return undefined;
  }
}

async function onlyInProgress(cwd: string, dirs: readonly string[]): Promise<string | undefined> {
  const found: string[] = [];
  for (const dir of dirs.slice(-RECENT_FLOWS)) {
    try {
      if ((await readFlow(cwd, dir)).status === "in-progress") found.push(dir);
    } catch {
      // an unreadable flow is not the active one
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

/** Never throws: any failure is "no context", and the question carries on without one. */
export async function resolveFlowContext(cwd: string, env: Record<string, string | undefined> = process.env): Promise<FlowContext> {
  try {
    const dirs = await listFlowDirs(cwd);
    const fromEnv = env["KERYX_FLOW"];
    let dir: string | undefined;
    if (fromEnv !== undefined && fromEnv.length > 0) {
      try {
        dir = await resolveFlowDir(cwd, fromEnv);
      } catch {
        // KERYX_FLOW names something that is not a flow here: keep it as given, there is no stage to read
        return { flow: fromEnv };
      }
    } else {
      const branch = await currentBranch(cwd);
      const id = branch === undefined ? undefined : fromBranch(branch, dirs);
      dir = id === undefined ? undefined : dirs.find((candidate) => flowIdOf(candidate) === id);
      dir ??= await onlyInProgress(cwd, dirs);
    }
    if (dir === undefined) return {};
    return { flow: flowIdOf(dir), stage: await stageOf(cwd, dir) };
  } catch {
    return {};
  }
}
