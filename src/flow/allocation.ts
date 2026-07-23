import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { flowsRoot, slugify } from "./store";

// Flow id allocation is scoped to a CLONE, not a working copy.
//
// `nextFlowId` used to be `max(local flow dirs) + 1`, and the init lock lived in
// `.metaproject/flows`. Both are per working copy, so two linked worktrees each
// saw the same high-water mark and minted the same number; the collision only
// surfaced when the branches merged (this is how 002, 084 and 103 were
// duplicated). The git *common* directory is shared by every linked worktree of
// one clone, so the lock and a small append-only ledger live there instead.
//
// The ledger also remembers numbers that are no longer on disk (renumbered
// away), so a freed number is never handed out twice.

export type AllocationScope = {
  /** Lock every `flow init` of this project against this path. */
  lockPath: string;
  /** Append-only record of handed-out ids; null outside a git checkout. */
  ledgerPath: string | null;
  /** Project path inside the repo ("root" for a single-project repo). */
  project: string;
};

export type AllocationRecord = {
  id: string;
  dir: string;
  at: string;
  /** Project path relative to the repo root — one repo can hold several. */
  project: string;
  /** Set when the id was vacated by `flow renumber`; never reused. */
  retired?: boolean;
};

// `git rev-parse --git-common-dir` is the one path shared by all worktrees of a
// clone. Absent git (or a non-repository directory) we keep the old behaviour.
async function gitCommonDir(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0 || output.length === 0) {
      return null;
    }
    return path.isAbsolute(output) ? output : path.resolve(cwd, output);
  } catch {
    return null; // git not installed / not executable
  }
}

async function gitToplevel(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

// One repository can contain several metaprojects (monorepo). Key the ledger
// and the lock by the project's path inside the repo so their id spaces stay
// independent.
function projectKey(toplevel: string | null, cwd: string): string {
  if (!toplevel) {
    return "root";
  }
  const relative = path.relative(toplevel, cwd);
  return relative === "" ? "root" : slugify(relative);
}

export async function resolveAllocationScope(cwd: string): Promise<AllocationScope> {
  const commonDir = await gitCommonDir(cwd);
  if (!commonDir) {
    // Fallback: exactly the pre-existing per-working-copy behaviour.
    return {
      lockPath: path.join(flowsRoot(cwd), ".flow-init.lock"),
      ledgerPath: null,
      project: "root",
    };
  }
  const key = projectKey(await gitToplevel(cwd), cwd);
  const dir = path.join(commonDir, "keryx", "flow-ids");
  return {
    lockPath: path.join(dir, `${key}.lock`),
    ledgerPath: path.join(dir, `${key}.jsonl`),
    project: key,
  };
}

export async function readAllocationLedger(scope: AllocationScope): Promise<AllocationRecord[]> {
  if (!scope.ledgerPath || !(await pathExists(scope.ledgerPath))) {
    return [];
  }
  const content = await readFile(scope.ledgerPath, "utf8");
  const records: AllocationRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as AllocationRecord;
      if (typeof parsed.id === "string") {
        records.push(parsed);
      }
    } catch {
      // A torn line cannot make us hand out a duplicate: unreadable records are
      // skipped, and the on-disk listing is still consulted.
    }
  }
  return records;
}

/** Numbers this clone has already handed out, on disk or not. */
export async function reservedIds(scope: AllocationScope): Promise<number[]> {
  const records = await readAllocationLedger(scope);
  return records.map((record) => Number(record.id)).filter((value) => !Number.isNaN(value));
}

export async function recordAllocation(
  scope: AllocationScope,
  record: AllocationRecord,
): Promise<void> {
  if (!scope.ledgerPath) {
    return;
  }
  await mkdir(path.dirname(scope.ledgerPath), { recursive: true });
  await appendFile(scope.ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
}
