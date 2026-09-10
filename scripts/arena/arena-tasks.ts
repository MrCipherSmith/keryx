// The arena's task records, loaded from frozen files rather than derived at run time.
//
// The pilot derives its tasks from git history on every run
// (`extractRetrievalTasks`). That is right for a sweep whose whole point is "take
// the last N pull requests", and wrong here: the arena's sample was drawn once,
// from a pre-registered rule, with a recorded seed, and must not silently change
// because history grew a commit. So T1 is read from the artifact
// `arena-freeze-tasks.ts` wrote, and T2 is a hand-written file.
//
// The two task types differ in more than their prompt, and the type is carried on
// the record rather than inferred, because three things branch on it: whether the
// arm needs installed dependencies, whether gates run, and how the cell is scored.

import { readFileSync } from "node:fs";
import type { RetrievalTask } from "../benchmark/retrieval-tasks";

export type ArenaTaskType = "research" | "implement";

export interface ArenaTask {
  readonly id: string;
  readonly type: ArenaTaskType;
  /** The commit an arm is checked out at. */
  readonly base: string;
  /**
   * The commit whose content must never be reachable from the arm, when there is
   * one. T1 has it — the pull request that answers the question. T2 does not: the
   * change has not been made, which is why it is the task.
   */
  readonly answerSha?: string;
  /** What the agent is asked. Byte-identical between arms, by construction. */
  readonly query: string;
  /** Files a correct answer names. Empty for `implement`, which is not scored by recall. */
  readonly gold: readonly string[];
  /** Strings whose presence in a context workspace means the answer leaked into it. */
  readonly answerNeedles: readonly string[];
}

/**
 * Read the frozen T1 sample.
 *
 * Refuses a file whose shape it does not recognise rather than coercing it. A
 * task list silently read as empty is a sweep that reports a verdict over zero
 * tasks, and `decide` would happily compute means of nothing.
 */
export function loadFrozenT1(file: string): ArenaTask[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    kind?: unknown;
    seed?: unknown;
    tasks?: unknown;
  };
  if (parsed.kind !== "arena-t1") {
    throw new Error(`${file} is not an arena-t1 artifact (kind=${String(parsed.kind)}) — refusing to guess its shape`);
  }
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error(`${file} carries no tasks — a sweep over zero tasks still produces a verdict, so this is fatal`);
  }
  return (parsed.tasks as RetrievalTask[]).map((task) => ({
    id: `t1-${task.id}`,
    type: "research" as const,
    base: task.parent,
    answerSha: task.sha,
    query: task.query,
    gold: task.gold,
    // The answer is a commit, and `assertAnswerUnreachable` already proves it is
    // absent from the tree. Content needles would add nothing a shallow fetch of
    // the parent has not already settled.
    answerNeedles: [],
  }));
}

/**
 * Read a hand-written task: YAML-ish front matter, then the prompt verbatim.
 *
 * Parsed with a deliberately small reader rather than a YAML dependency. The
 * fields are a handful of scalars and one string list, the file is ours, and a
 * parser that accepts more than the format permits is a way for a typo to become
 * a silently different task.
 */
export function parseTaskFile(contents: string, file: string): ArenaTask {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(contents);
  if (match === null) throw new Error(`${file} has no front matter delimited by --- lines`);
  const [, head, body] = match;
  if (head === undefined || body === undefined) throw new Error(`${file}: front matter did not parse`);

  const scalars: Record<string, string> = {};
  const needles: string[] = [];
  let inNeedles = false;

  for (const rawLine of head.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item !== null && inNeedles) {
      const value = item[1] ?? "";
      needles.push(value.replace(/^["']|["']$/g, ""));
      continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (pair === null) continue;
    const [, key, value] = pair;
    if (key === undefined) continue;
    if (key === "answerNeedles") {
      inNeedles = true;
      continue;
    }
    inNeedles = false;
    scalars[key] = (value ?? "").trim();
  }

  const required = (key: string): string => {
    const value = scalars[key];
    if (value === undefined || value.length === 0) throw new Error(`${file}: front matter is missing \`${key}\``);
    return value;
  };

  const type = required("type");
  if (type !== "research" && type !== "implement") {
    throw new Error(`${file}: type must be "research" or "implement", not ${JSON.stringify(type)}`);
  }

  const query = body.trim();
  if (query.length === 0) throw new Error(`${file}: the prompt body is empty`);

  return {
    id: required("id"),
    type,
    base: required("base"),
    query,
    gold: [],
    answerNeedles: needles,
  };
}

export function loadTaskFile(file: string): ArenaTask {
  return parseTaskFile(readFileSync(file, "utf8"), file);
}
