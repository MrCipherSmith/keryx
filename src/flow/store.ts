import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isLockHeld, pathExists, writeFileAtomic } from "../lib/fs";
import type { AttemptEntry, FlowHistoryEvent, FlowState, FlowStatus, FlowTask } from "./types";

export function flowsRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "flows");
}

/** The lock every flow mutation takes, `complete()` included. */
export function flowLockPathFor(cwd: string, dir: string): string {
  return path.join(flowsRoot(cwd), `.flow-lock-${dir}`);
}

/**
 * True when a flow in `completing` has no live holder of its lock: the
 * completion that put it there is no longer running (flow 299, AC6). `flow
 * status` and the TUI's `/flows` view both show this as "interrupted" and name
 * `keryx flow recover`. Lives here, beside the lock path, so the TUI can ask
 * without loading the flow service.
 */
export async function isCompletionInterrupted(
  cwd: string,
  flow: { id: string; status: FlowStatus },
  dir?: string,
): Promise<boolean> {
  if (flow.status !== "completing") return false;
  const flowDir = dir ?? (await resolveFlowDir(cwd, flow.id));
  return !(await isLockHeld(flowLockPathFor(cwd, flowDir)));
}

/** The one line `flow status` and the TUI's `/flows` view show for an interrupted completion (flow 299, AC6). */
export function interruptedCompletionLine(id: string): string {
  return `interrupted: completion did not finish and nothing is running it — run \`keryx flow recover ${id} --reason "<why>"\``;
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

export type FlowWorkProjection = Readonly<{
  flowRef: { uri: string; snapshot: string; revision: string };
  completed: string[];
  next: string[];
  blocked: string[];
}>;

/**
 * Pure completed/next/blocked task-status projection derived from an
 * already-loaded, already-migrated `FlowState`. This is the single shared
 * formula behind both live flow-work projections in the codebase:
 * `src/sac/fwk-service.ts`'s `createLocalFwkReadService` (workspace-scoped,
 * loads via `WorkspaceService`) and `src/session/slate-course.ts`'s
 * `readCourse` (workspace-independent, loads via `readFlow`/`resolveFlowDir`
 * below). Callers own fetching the flow and applying `migrateFlow` — this
 * function never reads from disk and never mutates its input.
 */
export function deriveFlowWork(flow: FlowState, uri: string): FlowWorkProjection {
  return {
    flowRef: { uri, snapshot: flow.status, revision: flow.updatedAt },
    completed: flow.tasks.filter((task) => task.status === "done").map((task) => task.id),
    next: flow.tasks.filter((task) => task.status !== "done").map((task) => task.id),
    blocked: flow.status === "blocked" ? [flow.id] : [],
  };
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

const AC_LINE_PATTERN = /^(\s*)[-*]\s*(AC\d+)\s*:\s?(.*)$/i;
const HEADING_PATTERN = /^\s*#/;

type AcLine = { text: string; eol: "\r\n" | "\n" | "" };

/**
 * `\r\n` if the file uses it anywhere, `\n` otherwise. Used ONLY as the
 * convention for bytes that did not exist before this write (a brand-new
 * appended line, and — the one case an existing line's ending changes — the
 * line a new one is appended after, when that line had no trailing newline
 * at all because it used to be the end of the file). Every other existing
 * line keeps its own original ending untouched; see {@link splitAcLines}
 * (review finding #2, flow 293 T10 — a single detected-eol-for-the-whole-file,
 * the flow 293 T9 version's approach, rewrote every line of a mixed-ending
 * file to one ending, changing bytes nobody asked to change).
 */
function detectEol(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Split into (text, original-terminator) pairs, one per line, so a rewrite
 * can put every untouched line back with the EXACT bytes it had. The last
 * entry's `eol` is `""` when the file has no trailing newline.
 */
function splitAcLines(content: string): AcLine[] {
  if (content.length === 0) {
    return [];
  }
  const lines: AcLine[] = [];
  let index = 0;
  while (index < content.length) {
    const newlineIndex = content.indexOf("\n", index);
    if (newlineIndex === -1) {
      lines.push({ text: content.slice(index), eol: "" });
      break;
    }
    const hasCr = newlineIndex > index && content[newlineIndex - 1] === "\r";
    lines.push({
      text: hasCr ? content.slice(index, newlineIndex - 1) : content.slice(index, newlineIndex),
      eol: hasCr ? "\r\n" : "\n",
    });
    index = newlineIndex + 1;
  }
  return lines;
}

function renderAcLines(lines: readonly AcLine[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

/**
 * The end (exclusive) of the criterion block starting at `lines[start]`: its
 * `- ACn:` line plus every INDENTED, non-empty line that follows, stopping
 * at (not including) whichever comes first: the next `- ACn:`/`* ACn:` line,
 * a blank line, a Markdown heading, or a line that is no longer indented.
 *
 * Used for two different purposes, and only one of them ever writes: finding
 * where a NEW criterion is appended (after the last existing block, wherever
 * it ends — flow 293, AC1), and, in {@link writeAcCriterion}, detecting
 * whether the TARGET of a replace has any continuation lines at all, so it
 * can be refused rather than silently deleted or left orphaned (flow 293
 * T10, review finding #1 — see that function's doc comment for why a replace
 * never touches a multi-line block).
 *
 * `readAcCriteria`'s own scan (no indentation requirement) only ever matches
 * a block's first line too — a continuation line is prose, not `- ACn:`
 * text, so it never re-triggers that regex either. Same rule, two places:
 * neither counts a continuation line as its own criterion.
 */
function acBlockEnd(lines: readonly AcLine[], start: number): number {
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] as AcLine;
    if (line.text.trim() === "") break;
    if (HEADING_PATTERN.test(line.text)) break;
    if (AC_LINE_PATTERN.test(line.text)) break;
    if (!/^\s/.test(line.text)) break; // not indented -> not a continuation of the block above
    end += 1;
  }
  return end;
}

/**
 * Rewrite one criterion's text in `acceptance-criteria.md`, or append it as a
 * new line when no line for that criterion exists yet (flow 293, AC1).
 *
 * A replace touches EXACTLY the criterion's own `- ACn:` line — the format
 * `acceptance-criteria.md`'s own Rules section prescribes — and refuses if
 * that criterion has ANY following indented, non-blank line before the next
 * criterion, a blank line, or a heading (flow 293 T10, review finding #1).
 * The flow 293 T9 version instead swept those lines into the replace as a
 * "continuation", which sounds right for a criterion literally wrapped
 * across two lines and is wrong for everything else that shape also matches:
 * this repo has 1098 indented lines under criteria across 224 real
 * `acceptance-criteria.md` files — sub-bullet evidence notes, fenced code
 * blocks, nested detail — and every one of them would have been silently
 * deleted (or, for a line that was not text, silently corrupted) by a
 * `--criterion`/`--text` replace that happened to name that criterion.
 * There is no heuristic here that tells "this criterion wraps onto the next
 * line" apart from "unrelated indented content follows it" — both produce
 * the identical shape on disk — so this refuses ALL of them rather than
 * guessing, and says so by naming the criterion. `previousText` for a
 * (necessarily single-line) replaced criterion is just that line's text.
 *
 * Appending a criterion that does not exist yet is unaffected: it is always
 * a brand-new line, so it never has continuation lines of its own to lose.
 */
export async function writeAcCriterion(
  cwd: string,
  dir: string,
  criterion: string,
  text: string,
): Promise<{ previousText: string | undefined }> {
  const file = acPath(cwd, dir);
  const content = (await pathExists(file)) ? await readFile(file, "utf8") : "";
  const lines = splitAcLines(content);
  const rendered = `- ${criterion}: ${text}`;

  let previousText: string | undefined;
  let matchedIndex = -1;
  let lastBlockEnd = -1;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as AcLine;
    const match = line.text.match(AC_LINE_PATTERN);
    if (!match?.[2]) {
      index += 1;
      continue;
    }
    const end = acBlockEnd(lines, index);
    lastBlockEnd = end;
    if (match[2].toUpperCase() === criterion) {
      if (end > index + 1) {
        throw new Error(
          `${criterion} spans more than one line; edit acceptance-criteria.md directly and run ` +
            '`keryx flow ac update <id> --reason "..."`.',
        );
      }
      matchedIndex = index;
      previousText = (match[3] ?? "").trim();
    }
    index = end;
  }

  if (matchedIndex >= 0) {
    const existing = lines[matchedIndex] as AcLine;
    lines[matchedIndex] = { text: rendered, eol: existing.eol };
  } else if (lastBlockEnd >= 0) {
    const precedingIndex = lastBlockEnd - 1;
    const preceding = lines[precedingIndex] as AcLine;
    let newEol = preceding.eol;
    if (newEol === "") {
      // `preceding` had no trailing newline because it used to be the end of
      // the file. Give it the file's own convention so it does not merge
      // with the new line, and use that same convention for the new line —
      // there is no "ending it follows" to copy when none existed.
      const fallbackEol = detectEol(content);
      preceding.eol = fallbackEol;
      newEol = fallbackEol;
    }
    lines.splice(lastBlockEnd, 0, { text: rendered, eol: newEol });
  } else {
    lines.push({ text: rendered, eol: detectEol(content) });
  }
  await writeFileAtomic(file, renderAcLines(lines));
  return { previousText };
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
    // The observation is the mismatch; the cause is not observed here. An edit
    // outside `keryx flow ac` produces it, and so does a checksum sealed
    // against content that no longer exists (flow 002: file byte-identical to
    // its first commit, `acChecksum` unchanged since that commit, values still
    // differ). Both routes out are named, because only one of them is right
    // for each cause and `ac update` voids every prior confirmation.
    throw new Error(
      "Acceptance criteria do not match their recorded checksum. " +
        "If they were changed on purpose, use `keryx flow ac update <id> --reason \"...\"` " +
        "— that re-seals them and VOIDS every prior confirmation, because criteria that " +
        "changed have not been confirmed. If the file is unchanged and the checksum is " +
        "stale, use `keryx flow ac reseal <id> --reason \"...\"`, which keeps the " +
        "confirmations and refuses unless git shows the file unchanged since HEAD.",
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
