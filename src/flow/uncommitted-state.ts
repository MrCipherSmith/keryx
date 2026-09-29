import path from "node:path";
import { flowsRoot } from "./store";

/**
 * `keryx flow complete` writes the closing state (flow.json, journal.md,
 * reviews/) into the working copy AFTER the pull request merged, and nothing
 * commits it afterwards, so a tracked flow directory commonly stays dirty against
 * HEAD. This is the one-block note that says the directory has uncommitted
 * changes; it does not claim to know what wrote them.
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

/**
 * Every git call here is read-only against the index: `--no-optional-locks`
 * stops `git status` from opportunistically refreshing (and locking) the index,
 * so a note printed while another git process runs cannot collide with it.
 */
export const READ_ONLY_GIT_FLAGS = ["--no-optional-locks"] as const;

/** Bound on each git call; a hung git must not hang a command that already succeeded. */
export const GIT_TIMEOUT_MS = 5000;

const spawnGit: GitRunner = async (cwd, args) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  // A killed process (timeout) is a failure, whatever exit code it reports.
  return { code: proc.signalCode === null ? code : -1, out };
};

/** Matches a path inside a flow directory: the `.metaproject/flows/<dir>/` prefix, at the start or under the repo-root prefix of a subdirectory cwd. */
const FLOW_PATH = /(?:^|\/)\.metaproject\/flows\/([^/]+)\/(.+)$/;

/** Group a git listing by flow directory, once: dir -> paths relative to that directory. */
function groupByFlowDir(listing: string, porcelain: boolean): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const line of listing.split("\n")) {
    let file = porcelain ? (line.length < 4 ? "" : line.slice(3)) : line;
    const renamed = porcelain ? file.indexOf(" -> ") : -1;
    if (renamed !== -1) file = file.slice(renamed + 4);
    file = file.replace(/^"|"$/g, "");
    const match = FLOW_PATH.exec(file);
    if (match === null) continue;
    const [, dir, inside] = match;
    if (dir === undefined || inside === undefined) continue;
    const list = groups.get(dir);
    if (list === undefined) groups.set(dir, [inside]);
    else list.push(inside);
  }
  return groups;
}

interface Listings {
  tracked: Map<string, string[]>;
  status: Map<string, string[]>;
}

function noteFor(flowId: string, dir: string, listings: Listings): string | null {
  // Untracked-only: git tracks nothing in the directory, so there is no
  // committed state for the closing write to be uncommitted against.
  if ((listings.tracked.get(dir) ?? []).length === 0) return null;
  const seen = new Set<string>();
  for (const inside of listings.status.get(dir) ?? []) {
    const slash = inside.indexOf("/");
    seen.add(slash === -1 ? inside : `${inside.slice(0, slash)}/`);
  }
  const entries = [...seen];
  if (entries.length === 0) return null;
  const shown = entries.slice(0, UNCOMMITTED_LIST_CAP);
  const more = entries.length - shown.length;
  const list = `${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
  return (
    `flow ${flowId} has uncommitted changes in .metaproject/flows/${dir}: ${list} — ` +
    "a common cause is the closing state `flow complete` writes after the merge; commit it (nothing gates on this)"
  );
}

/** One `ls-files` and one `status`, both scoped to `scope`; null on any git failure. */
async function readGit(cwd: string, scope: string, git: GitRunner): Promise<Listings | null> {
  const tracked = await git(cwd, [...READ_ONLY_GIT_FLAGS, "ls-files", "--", scope]);
  if (tracked.code !== 0) return null;
  const empty: Listings = { tracked: new Map(), status: new Map() };
  if (tracked.out.trim().length === 0) return empty;
  const status = await git(cwd, [
    ...READ_ONLY_GIT_FLAGS,
    "-c",
    "core.quotepath=off",
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    scope,
  ]);
  if (status.code !== 0) return null;
  return { tracked: groupByFlowDir(tracked.out, false), status: groupByFlowDir(status.out, true) };
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
    return read === null ? null : noteFor(flowId, dir, read);
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
  if (flows.length === 0) return notes;
  try {
    const read = await readGit(cwd, flowsRoot(cwd), git);
    if (read === null) return notes;
    for (const flow of flows) {
      const text = noteFor(flow.id, flow.dir, read);
      if (text !== null) notes.set(flow.dir, text);
    }
  } catch {
    return new Map();
  }
  return notes;
}
