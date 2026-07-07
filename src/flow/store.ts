import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import type { FlowState } from "./types";

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

export async function nextFlowId(cwd: string): Promise<string> {
  const dirs = await listFlowDirs(cwd);
  const max = dirs.reduce((acc, dir) => {
    const num = Number(dir.slice(0, 3));
    return Number.isNaN(num) ? acc : Math.max(acc, num);
  }, 0);
  return String(max + 1).padStart(3, "0");
}

// Accepts "001", a full dir name, or a slug; returns the flow directory name.
export async function resolveFlowDir(cwd: string, id: string): Promise<string> {
  const dirs = await listFlowDirs(cwd);
  const match =
    dirs.find((dir) => dir === id) ??
    dirs.find((dir) => dir.startsWith(`${id.padStart(3, "0")}-`)) ??
    dirs.find((dir) => dir.slice(15) === id || dir.endsWith(`-${id}`));
  if (!match) {
    throw new Error(`Flow not found: ${id}. Run: gd-metapro flow list`);
  }
  return match;
}

export async function readFlow(cwd: string, dir: string): Promise<FlowState> {
  const file = path.join(flowsRoot(cwd), dir, "flow.json");
  if (!(await pathExists(file))) {
    throw new Error(`flow.json missing in ${dir}`);
  }
  return JSON.parse(await readFile(file, "utf8")) as FlowState;
}

export async function writeFlow(
  cwd: string,
  dir: string,
  flow: FlowState,
): Promise<void> {
  const file = path.join(flowsRoot(cwd), dir, "flow.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
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
        "Use `gd-metapro flow ac update <id> --reason \"...\"` to change them.",
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
