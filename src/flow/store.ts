import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../lib/fs";
import type { AttemptEntry, FlowHistoryEvent, FlowState, FlowTask } from "./types";

export function flowsRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "flows");
}

export async function listFlowDirs(cwd: string): Promise<string[]> {
  const root = flowsRoot(cwd);
  if (!(await pathExists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{3}-/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function flowIdOf(dir: string): string {
  return dir.slice(0, 3);
}

/** Ids that appear more than once — every bare-id reference to them is ambiguous. */
export function duplicateFlowIds(ids: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return duplicates;
}

/** Flow dirs grouped by their numeric id; groups of >1 are collisions. */
export function groupFlowDirsById(dirs: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const dir of dirs) {
    const id = flowIdOf(dir);
    groups.set(id, [...(groups.get(id) ?? []), dir]);
  }
  return groups;
}

// `reserved` carries ids handed out by this clone that are not (or no longer)
// visible in the local listing — see allocation.ts. Without it the high-water
// mark is per working copy, which is what let parallel worktrees collide.
export async function nextFlowId(cwd: string, reserved: number[] = []): Promise<string> {
  const dirs = await listFlowDirs(cwd);
  const local = dirs.map((dir) => Number(flowIdOf(dir)));
  const max = [...local, ...reserved].reduce(
    (acc, num) => (Number.isNaN(num) ? acc : Math.max(acc, num)),
    0,
  );
  return String(max + 1).padStart(3, "0");
}

// Accepts "001", a full dir name, or a slug; returns the flow directory name.
// A bare id that matches several flows is NEVER resolved to the first match:
// acting on a guessed package is how harness evidence and AC confirmations end
// up in the wrong flow. The caller must disambiguate or repair the collision.
export async function resolveFlowDir(cwd: string, id: string): Promise<string> {
  const dirs = await listFlowDirs(cwd);
  const exact = dirs.find((dir) => dir === id);
  if (exact) {
    return exact;
  }
  const byId = dirs.filter((dir) => dir.startsWith(`${id.padStart(3, "0")}-`));
  assertUnambiguous(id, byId);
  if (byId[0]) {
    return byId[0];
  }
  const bySlug = dirs.filter((dir) => dir.slice(15) === id || dir.endsWith(`-${id}`));
  assertUnambiguous(id, bySlug);
  if (bySlug[0]) {
    return bySlug[0];
  }
  throw new Error(`Flow not found: ${id}. Run: keryx flow list`);
}

function assertUnambiguous(id: string, candidates: string[]): void {
  if (candidates.length < 2) {
    return;
  }
  throw new Error(
    `Flow reference "${id}" is ambiguous — ${candidates.length} flows match it:\n` +
      candidates.map((dir) => `  - ${dir}`).join("\n") +
      "\nUse the full directory name, or repair the collision with: " +
      'keryx flow renumber <dir> --to <id> --reason "<why>"',
  );
}

export async function readFlow(cwd: string, dir: string): Promise<FlowState> {
  const file = path.join(flowsRoot(cwd), dir, "flow.json");
  if (!(await pathExists(file))) {
    throw new Error(`flow.json missing in ${dir}`);
  }
  const parsed = JSON.parse(await readFile(file, "utf8")) as FlowState;
  // Read-time normalization: v1 flows are migrated to v2 IN-MEMORY only. No file
  // is written here (byte-identical on disk until the next mutation). See TM-01
  // §4.1/§4.3. Never call writeFlow from a read path.
  return migrateFlow(parsed);
}

// Deterministic schemaVersion 1 -> 2 migration (TM-01 §4.2). Applied on read.
// v2 flows pass through unchanged; a future/unknown version throws.
export function migrateFlow(flow: FlowState): FlowState {
  if (flow.schemaVersion === 2) {
    return flow;
  }
  if (flow.schemaVersion !== 1) {
    throw new Error(
      `Unsupported flow schemaVersion ${flow.schemaVersion}: this keryx build supports schemaVersion 1 and 2.`,
    );
  }
  return {
    ...flow,
    schemaVersion: 2,
    tasks: flow.tasks.map((task) => migrateTask(task, flow.createdAt, flow.history ?? [])),
  };
}

// Earliest history event whose `detail` names this task ("<taskId>: ..."), else
// the flow's createdAt (TM-01 §4.2 "attempt inferral from flow.history").
function inferTaskTimestamp(
  taskId: string,
  createdAt: string,
  history: FlowHistoryEvent[],
): string {
  const prefix = `${taskId}: `;
  let earliest: string | undefined;
  for (const event of history) {
    if (event.detail?.startsWith(prefix) && (!earliest || event.at < earliest)) {
      earliest = event.at;
    }
  }
  return earliest ?? createdAt;
}

function migrateTask(task: FlowTask, createdAt: string, history: FlowHistoryEvent[]): FlowTask {
  // Preserve any already-present fields; only fill deterministic defaults.
  const migrated: FlowTask = { ...task };

  if (migrated.dependsOn === undefined) {
    migrated.dependsOn = [];
  }
  if (migrated.attempts === undefined) {
    if (task.status === "todo") {
      migrated.attempts = { count: 0, log: [] };
    } else {
      const at = inferTaskTimestamp(task.id, createdAt, history);
      const outcome: AttemptEntry["outcome"] = task.status === "done" ? "completed" : "started";
      migrated.attempts = { count: 1, log: [{ at, outcome }] };
    }
  }
  // Disposition is only meaningful once status is "done"; infer "completed" for
  // migrated done tasks (v1 "done" semantics). Leave the key ABSENT otherwise.
  if (migrated.disposition === undefined && task.status === "done") {
    migrated.disposition = "completed";
  }
  if (migrated.acRefs === undefined) {
    migrated.acRefs = [];
  }
  if (migrated.evidenceRefs === undefined) {
    migrated.evidenceRefs = [];
  }
  if (migrated.budget === undefined) {
    migrated.budget = {};
  }
  // runLink left absent (set only by Task Manager when a run is dispatched).
  return migrated;
}

export async function writeFlow(
  cwd: string,
  dir: string,
  flow: FlowState,
): Promise<void> {
  const file = path.join(flowsRoot(cwd), dir, "flow.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(flow, null, 2)}\n`);
}

export async function appendJournal(
  cwd: string,
  dir: string,
  at: string,
  line: string,
): Promise<void> {
  const file = path.join(flowsRoot(cwd), dir, "journal.md");
  await appendFile(file, `- ${at} - ${line}\n`, "utf8");
}

// --- Acceptance criteria (spec section 7) ---

export function acPath(cwd: string, dir: string): string {
  return path.join(flowsRoot(cwd), dir, "acceptance-criteria.md");
}

export async function readAcCriteria(
  cwd: string,
  dir: string,
): Promise<string[]> {
  const file = acPath(cwd, dir);
  if (!(await pathExists(file))) {
    return [];
  }
  const content = await readFile(file, "utf8");
  const ids: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*[-*]\s*(AC\d+):/i);
    if (match?.[1]) {
      ids.push(match[1].toUpperCase());
    }
  }
  return ids;
}

export async function acChecksum(cwd: string, dir: string): Promise<string> {
  const content = await readFile(acPath(cwd, dir), "utf8");
  const normalized = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

export async function assertAcIntact(
  cwd: string,
  dir: string,
  flow: FlowState,
): Promise<void> {
  if (!flow.acChecksum) {
    return; // not frozen yet
  }
  const current = await acChecksum(cwd, dir);
  if (current !== flow.acChecksum) {
    throw new Error(
      "Acceptance criteria were modified outside the task-manager module. " +
        "Use `keryx flow ac update <id> --reason \"...\"` to change them.",
    );
  }
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "flow"
  );
}
