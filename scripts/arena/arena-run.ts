// One arm, and one task's pair of arms.
//
// The skeleton is the pilot's and is deliberately unchanged in order:
// materialize -> strip or provision -> assert the arm is the arm it claims ->
// prove the answer is unreachable -> inventory -> run the agent -> score ->
// clean up. Every step in that sequence exists because its absence produced a
// number that looked like a result, and the comments in `retrieval-run.ts` record
// which. Four things differ.
//
// **The prompt and the scorer are injected.** The pilot calls one hardwired prompt
// builder and one hardwired scorer from inside `runArm`. The arena has two task
// types whose prompts cannot be shared and whose metrics have nothing in common.
//
// **Arm order alternates.** The pilot always runs `context-on` first, for every
// task, in every leg. Over a multi-hour sweep that confounds the arm with
// everything that drifts: vendor-side model rollouts, rate-limit throttling, the
// page cache of an 8,632-file tree the first arm just warmed, and prompt-cache
// hits that lower the second arm's dollar cost. The control arm was systematically
// second in all of it. Here the order is a deterministic function of
// `(harness, task)` and is recorded in the row.
//
// **Trees come from a per-commit cache.** 78 arms would otherwise mean 78 shallow
// fetches of the same handful of commits.
//
// **Leakage is checked by content as well as by reachability.** A commit being
// absent from the tree says nothing about whether the provisioning step wrote the
// answer into the workspace in prose.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertAnswerUnreachable, assertNoSourcePointer } from "../benchmark/retrieval-checkout";
import type { AgentPort } from "../benchmark/retrieval-run";
import { arenaInventory, arenaStripContext, assertArenaArmContext, assertBuildable, type ArenaInventory } from "./arena-context";
import { assertProvisionAncestry, type BaseTreeCache } from "./arena-checkout";
import { buildArenaPrompt } from "./arena-prompts";
import { scorerFor, type ArenaScore } from "./arena-scoring";
import type { ArenaTask } from "./arena-tasks";
import { superviseArm } from "./arena-supervisor";
import type { WatchdogThresholds } from "./arena-watchdog";
import type { SupervisedChild } from "../benchmark/retrieval-supervision";

export type Arm = "context-on" | "context-off";

export interface ArenaArmResult {
  readonly taskId: string;
  readonly taskType: ArenaTask["type"];
  readonly arm: Arm;
  readonly harness: string;
  readonly model: string;
  readonly base: string;
  /** Which arm ran first for this (harness, task). Recorded so the order cannot hide. */
  readonly armOrder: Arm;
  readonly score: ArenaScore;
  readonly toolCalls: number;
  readonly contextTokens: number | null;
  readonly costUsd: number | null;
  readonly stepsToFirstGold: number | null;
  readonly wallClockMs: number;
  readonly inventory: ArenaInventory;
  readonly inventoryAfter: ArenaInventory;
}

export interface ArenaProvisioner {
  provision(treePath: string): Promise<{ provisionCommit: string }>;
  release(treePath: string): Promise<void>;
}

export interface LeakageCheck {
  (treePath: string, needles: readonly string[]): void;
}

export interface ArenaRunOptions {
  readonly repoRoot: string;
  readonly worktreesDir: string;
  readonly agent: AgentPort;
  readonly model: string;
  readonly cache: BaseTreeCache;
  readonly provisioner?: ArenaProvisioner;
  readonly checkLeakage?: LeakageCheck;
  /**
   * Where each arm's raw stream is kept, as `<task>-<harness>-<arm>.jsonl`.
   *
   * The tree is deleted after every arm and the adapters used to discard their
   * streams, so a surprising score could not be explained afterwards. Optional so
   * the tests' fake runs stay free of filesystem side effects.
   */
  readonly transcriptsDir?: string;
  /** The operator's real home, fenced off from every arm (K-014). Defaults to `homedir()`. */
  readonly operatorHome?: string;
  /**
   * Supervise the agent while it runs. Without it the adapter's own timeout is the
   * only bound — a wall clock with no silence detection, which the handoff called
   * tolerable for a six-arm smoke and not for 84 arms.
   */
  readonly watchdog?: {
    readonly thresholds: WatchdogThresholds;
    readonly logFile?: string;
    readonly pollMs?: number;
  };
  /** Gates and diff statistics for an `implement` task. Absent for `research`. */
  readonly evaluateImplementation?: (treePath: string) => Promise<{
    readonly gates: import("./arena-gates").GateVerdict;
    readonly changedSourceFiles: number;
    readonly diffText: string;
  }>;
}

/**
 * Which arm runs first, decided by the task and harness rather than by a clock.
 *
 * Deterministic so a resumed sweep reproduces the same order — a random order
 * would mean a re-run of one cell is not the same cell. Hashing rather than
 * alternating on an index because the index depends on how the task list happened
 * to be sorted, and the order would then correlate with task age.
 */
export function firstArmFor(harness: string, taskId: string): Arm {
  const digest = createHash("sha256")
    // The separator is a NUL, written as an escape rather than as the byte
    // itself. It WAS the byte, which made this file invisible to every text
    // search in the repository: ripgrep skips a file holding one, silently, so
    // a search for anything in here returned nothing and read as "not present".
    // Kept as a NUL rather than changed to a space so the digest — and with it
    // which arm runs first for a given task — is byte-for-byte what it was.
    .update([harness, taskId].join("\u0000"))
    .digest();
  const first = digest[0] ?? 0;
  return first % 2 === 0 ? "context-on" : "context-off";
}

/**
 * The transcript file (or its stderr) that names the source clone, if any.
 *
 * Both spellings of the path, as in `sourcePointersIn`. A transcript that was
 * never written — no transcriptsDir, or an adapter that died first — names nothing.
 */
export function transcriptNamingSource(transcriptFile: string | undefined, sourceRoot: string): string | undefined {
  if (transcriptFile === undefined) return undefined;
  let real = sourceRoot;
  try {
    real = realpathSync(sourceRoot);
  } catch {
    // A root that does not resolve is looked for as written.
  }
  const needles = [...new Set([sourceRoot, real])];
  for (const file of [transcriptFile, `${transcriptFile}.stderr`]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (needles.some((needle) => text.includes(needle))) return file;
  }
  return undefined;
}

/** What an arm may name in its transcript: its own tree, and nothing else the arena or the operator owns. */
export interface ArmFence {
  readonly ownTree: string;
  /** Everything the arena wrote — the base-tree cache, every arm's transcript, every other arm's tree. */
  readonly outRoot: string;
  /** The operator's real home. Its credentials are the operator's, not the arm's. */
  readonly operatorHome?: string;
  /** PATH entries. One under the home is a toolchain directory, and naming it is resolving a binary. */
  readonly pathEntries?: readonly string[];
}

const PATH_CHAR = /[A-Za-z0-9_.-]/;

function spellings(p: string): string[] {
  // The deepest ancestor that exists is resolved and the rest appended as written,
  // so a tree already deleted still gets its `/private/tmp` spelling.
  const tail: string[] = [];
  for (let head = p; ; ) {
    try {
      return [...new Set([p, path.join(realpathSync(head), ...tail)])];
    } catch {
      const up = path.dirname(head);
      if (up === head) return [p];
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

/**
 * The first place outside its tree an arm's transcript (or its stderr) names, if any (K-014).
 *
 * The source-clone check misses the rest of the machine. On 2026-09-11 a grok arm
 * ran `HOME=<operator home> gh api …/pulls/6435/files` — the operator's GitHub
 * login, the answer PR's file list — and listed the arena's own cache and other
 * arms' transcripts on the way. A mention is a path boundary match, so a longer
 * name that merely starts with a root is not one.
 */
export function transcriptReachingOutside(
  transcriptFile: string | undefined,
  fence: ArmFence,
): { file: string; where: string } | undefined {
  if (transcriptFile === undefined) return undefined;
  const outRoot = path.resolve(fence.outRoot);
  // A root of `/` would name every path there is; there is no fence to check.
  const roots = outRoot === path.parse(outRoot).root ? [] : spellings(outRoot);
  const allowed = spellings(path.resolve(fence.ownTree));
  if (fence.operatorHome !== undefined) {
    const homes = spellings(path.resolve(fence.operatorHome));
    roots.push(...homes);
    for (const entry of fence.pathEntries ?? []) {
      // The entry itself, never its parent: `~/.local/bin`'s parent holds keryx's auth.json.
      if (homes.some((home) => entry.startsWith(`${home}/`))) allowed.push(...spellings(entry));
    }
  }
  const endsAtBoundary = (text: string, end: number): boolean => {
    const next = text[end];
    if (next === undefined || !PATH_CHAR.test(next)) return true;
    // A path at the end of a sentence: `…/arms/<cell>. A developer is about to…`,
    // which is how claude's sub-agent prompt names the arm's own tree. Without
    // this the trailing period reads as part of a longer, foreign path and the
    // arm is refused for naming itself (seen on t1-71916287, 2026-09-12).
    return next === "." && !PATH_CHAR.test(text[end + 1] ?? "");
  };
  for (const file of [transcriptFile, `${transcriptFile}.stderr`]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const root of roots) {
      for (let at = text.indexOf(root); at !== -1; at = text.indexOf(root, at + 1)) {
        if (!endsAtBoundary(text, at + root.length)) continue;
        // `/tmp/x` inside `/private/tmp/x` is the tail of a longer path, and the
        // longer spelling is a root of its own that matches where that path starts.
        if (at > 0 && /[A-Za-z0-9_.\/-]/.test(text[at - 1] ?? "")) continue;
        if (allowed.some((ok) => text.startsWith(ok, at) && endsAtBoundary(text, at + ok.length))) continue;
        const where = text.slice(at).split(/["'\s\\`;|&)]/)[0] ?? root;
        // A display that clipped a path of the arm's own tree (claude's step
        // summaries: `…/arena-0296/a…`) cannot be told from one that did not.
        const clipped = /(?:…|\.\.\.)$/.exec(where);
        if (clipped !== null && allowed.some((ok) => ok.startsWith(where.slice(0, clipped.index)))) continue;
        return { file, where };
      }
    }
  }
  return undefined;
}

export async function runArenaArm(task: ArenaTask, arm: Arm, options: ArenaRunOptions): Promise<ArenaArmResult> {
  // The harness is in the path because one results file holds several, and two
  // legs sweeping the same task would otherwise check out into, and delete, each
  // other's tree.
  const treePath = path.join(options.worktreesDir, `${task.id}-${options.agent.harness}-${arm}`);
  await options.cache.materialize(task.base, treePath);

  let provisionCommit: string | undefined;
  try {
    if (arm === "context-off") {
      arenaStripContext(treePath);
    } else if (options.provisioner !== undefined) {
      const provisioned = await options.provisioner.provision(treePath);
      provisionCommit = provisioned.provisionCommit;
      // A workspace derived from later code can describe the change the task asks
      // about — the answer, delivered inside the context arm's own workspace.
      assertProvisionAncestry(options.repoRoot, provisionCommit, task.base);
    }

    // Before the agent: an arm that is not the arm it claims to be produces
    // numbers indistinguishable from results.
    assertArenaArmContext(treePath, arm);

    const inventory = arenaInventory(treePath, provisionCommit);
    assertBuildable(inventory, task.type, treePath);

    // Two different leaks. The commit that holds the answer must be unreachable
    // from the tree; and for a task whose answer is a description rather than a
    // diff, the provisioning step must not have written that description into the
    // workspace in prose.
    if (task.answerSha !== undefined) assertAnswerUnreachable(treePath, task.answerSha);
    if (arm === "context-on" && task.answerNeedles.length > 0) {
      options.checkLeakage?.(treePath, task.answerNeedles);
    }

    // And a third: the tree must not say where the full clone lives. The answer
    // being unreachable inside the tree was checked; a signpost to a repository
    // where it IS reachable was not, and an arm followed one.
    assertNoSourcePointer(treePath, options.repoRoot);

    const prompt = buildArenaPrompt(task);
    const transcriptFile =
      options.transcriptsDir === undefined
        ? undefined
        : path.join(options.transcriptsDir, `${task.id}-${options.agent.harness}-${arm}.jsonl`);
    const started = Date.now();
    const answer = await options.agent.run({
      cwd: treePath,
      prompt,
      model: options.model,
      gold: task.gold,
      ...(transcriptFile === undefined ? {} : { transcriptFile }),
      ...(options.watchdog === undefined
        ? {}
        : {
            supervise: (child: SupervisedChild) =>
              superviseArm(child, {
                thresholds: options.watchdog!.thresholds,
                worktreePath: treePath,
                cell: `${task.id}-${options.agent.harness}-${arm}`,
                ...(options.watchdog!.logFile === undefined ? {} : { logFile: options.watchdog!.logFile }),
                ...(options.watchdog!.pollMs === undefined ? {} : { pollMs: options.watchdog!.pollMs }),
              }),
          }),
    });
    const wallClockMs = Date.now() - started;

    // The tree can be sealed and an agent with a shell can still go looking. A
    // transcript that names the source clone is an arm that reached outside its
    // tree, and its answer is not a measurement of anything the arm was given.
    const escapedVia = transcriptNamingSource(transcriptFile, options.repoRoot);
    if (escapedVia !== undefined) {
      throw new Error(
        `the arm reached the source clone ${options.repoRoot} from outside its tree (named in ` +
          `${path.basename(escapedVia)}) — its answer cannot be scored`,
      );
    }
    // The rest of the machine is outside the tree too: the operator's home and
    // its credentials, and everything the arena wrote beside this arm.
    const reached = transcriptReachingOutside(transcriptFile, {
      ownTree: treePath,
      outRoot: path.dirname(options.worktreesDir),
      operatorHome: options.operatorHome ?? homedir(),
      pathEntries: (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0),
    });
    if (reached !== undefined) {
      throw new Error(
        `the arm reached ${reached.where} outside its tree (named in ${path.basename(reached.file)}) — ` +
          "its answer cannot be scored",
      );
    }

    const implementation =
      task.type === "implement" && options.evaluateImplementation !== undefined
        ? await options.evaluateImplementation(treePath)
        : undefined;

    const score = scorerFor(task).score({
      task,
      answerText: answer.text,
      treePath,
      ...(implementation === undefined
        ? {}
        : {
            gates: implementation.gates,
            changedSourceFiles: implementation.changedSourceFiles,
            diffText: implementation.diffText,
          }),
    });

    return {
      taskId: task.id,
      taskType: task.type,
      arm,
      harness: options.agent.harness,
      model: options.model,
      base: task.base,
      armOrder: firstArmFor(options.agent.harness, task.id),
      score,
      toolCalls: answer.toolCalls,
      contextTokens: answer.contextTokens,
      costUsd: answer.costUsd,
      stepsToFirstGold: answer.stepsToFirstGold,
      wallClockMs,
      inventory,
      inventoryAfter: arenaInventory(treePath, provisionCommit),
    };
  } finally {
    if (arm === "context-on" && options.provisioner !== undefined) {
      // Before the tree goes: `keryx init` registers the project user-globally,
      // and 78 throwaway trees would leave 78 dead registry entries pointing at
      // directories that no longer exist. The pilot's registry already carries
      // twenty such leftovers.
      await options.provisioner.release(treePath);
    }
    await rm(treePath, { recursive: true, force: true });
  }
}

/**
 * Both arms of one task, sequentially, in an order neither arm is guaranteed.
 *
 * Sequential for the pilot's reason — two agents at once contend for the same
 * repository and the flakiness would read as variance in the result. Alternating
 * for the arena's: the control arm must not be systematically second.
 */
export async function runArenaTask(task: ArenaTask, options: ArenaRunOptions): Promise<ArenaArmResult[]> {
  const first = firstArmFor(options.agent.harness, task.id);
  const second: Arm = first === "context-on" ? "context-off" : "context-on";
  const firstResult = await runArenaArm(task, first, options);
  const secondResult = await runArenaArm(task, second, options);
  return [firstResult, secondResult];
}
