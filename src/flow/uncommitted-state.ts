import path from "node:path";
import { flowsRoot } from "./store";

/**
 * `keryx flow complete` writes the closing state (flow.json, journal.md,
 * reviews/) into the working copy AFTER the pull request merged, and nothing
 * commits it afterwards. A tracked flow directory therefore stays dirty against
 * HEAD. This is the one-block note that says so.
 *
 * Informational only: read-only git, no model, and it never changes an exit code
 * or a completion result. Every failure — no git, no repository, a git error —
 * is swallowed into `null`, because a missing note must never break a command
 * that already succeeded.
 */

/** How many changed entries the note lists before it says `+N more`. */
export const UNCOMMITTED_LIST_CAP = 5;

export interface GitRun {
  code: number;
  out: string;
}

/** Runs `git <args>` in `cwd`. Injectable so a test can simulate a git failure. */
export type GitRunner = (cwd: string, args: string[]) => Promise<GitRun>;

const spawnGit: GitRunner = async (cwd, args) => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out };
};

/** The paths in a git listing that sit inside the flow directory, relative to it. */
function insideDir(listing: string, dir: string, porcelain: boolean): string[] {
  const marker = `/${dir}/`;
  const found: string[] = [];
  for (const line of listing.split("\n")) {
    let file = porcelain ? (line.length < 4 ? "" : line.slice(3)) : line;
    const renamed = porcelain ? file.indexOf(" -> ") : -1;
    if (renamed !== -1) file = file.slice(renamed + 4);
    file = file.replace(/^"|"$/g, "");
    const at = file.indexOf(marker);
    if (at === -1) continue;
    const inside = file.slice(at + marker.length);
    if (inside.length > 0) found.push(inside);
  }
  return found;
}

function noteFor(flowId: string, dir: string, tracked: string, status: string): string | null {
  // Untracked-only: git tracks nothing in the directory, so there is no
  // committed state for the closing write to be uncommitted against.
  if (insideDir(tracked, dir, false).length === 0) return null;
  const seen = new Set<string>();
  for (const inside of insideDir(status, dir, true)) {
    const slash = inside.indexOf("/");
    seen.add(slash === -1 ? inside : `${inside.slice(0, slash)}/`);
  }
  const entries = [...seen];
  if (entries.length === 0) return null;
  const shown = entries.slice(0, UNCOMMITTED_LIST_CAP);
  const more = entries.length - shown.length;
  const list = `${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
  return (
    `flow ${flowId} has uncommitted state in .metaproject/flows/${dir}: ${list} — ` +
    "the closing state is written after the merge; commit it (nothing gates on this)"
  );
}

/** One `ls-files` and one `status`, both scoped to `scope`; null on any git failure. */
async function readGit(cwd: string, scope: string, git: GitRunner): Promise<{ tracked: string; status: string } | null> {
  const tracked = await git(cwd, ["ls-files", "--", scope]);
  if (tracked.code !== 0) return null;
  if (tracked.out.trim().length === 0) return { tracked: "", status: "" };
  const status = await git(cwd, [
    "-c",
    "core.quotepath=off",
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    scope,
  ]);
  if (status.code !== 0) return null;
  return { tracked: tracked.out, status: status.out };
}

/**
 * The note for a tracked flow directory that has uncommitted changes, or `null`.
 *
 * `null` for: a directory git tracks nothing in (newer flows stay local by the
 * repo's standing rule), a clean tracked directory, no git repository, and any
 * git failure.
 */
export async function uncommittedFlowStateNote(
  cwd: string,
  flowId: string,
  dir: string,
  git: GitRunner = spawnGit,
): Promise<string | null> {
  try {
    const read = await readGit(cwd, path.join(flowsRoot(cwd), dir), git);
    return read === null ? null : noteFor(flowId, dir, read.tracked, read.status);
  } catch {
    return null;
  }
}

/**
 * The same note for many flows with one `ls-files` and one `status` over the
 * whole flows directory — for a list view that would otherwise spawn git twice
 * per flow. Keyed by flow directory name; a flow with no note has no entry.
 */
export async function uncommittedFlowStateNotes(
  cwd: string,
  flows: readonly { id: string; dir: string }[],
  git: GitRunner = spawnGit,
): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  try {
    const read = await readGit(cwd, flowsRoot(cwd), git);
    if (read === null) return notes;
    for (const flow of flows) {
      const text = noteFor(flow.id, flow.dir, read.tracked, read.status);
      if (text !== null) notes.set(flow.dir, text);
    }
  } catch {
    return new Map();
  }
  return notes;
}
