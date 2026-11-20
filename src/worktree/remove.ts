// `keryx worktree remove` (spec §6, §5.2): warn about entries the worktree holds
// that were never carried out, refuse a dirty or unpromoted worktree without
// `--force`, free its ports, and let git remove it.

import { realpath } from "node:fs/promises";
import path from "node:path";
import { assertGitRevision } from "../lib/git-revision";
import { readCheckout } from "./checkout";
import { resolveWorktreeContext } from "./context";
import { runGit } from "./git";
import { releasePorts } from "./ports";
import { listUnpromoted, type Unpromoted } from "./promote";

export interface RemoveOptions {
  cwd: string;
  /** The worktree's directory name, its branch, or its path. */
  name: string;
  keepBranch?: boolean;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface RemoveResult {
  path: string;
  branch?: string;
  branchDeleted: boolean;
  /** Why the branch was left in place, when it was. */
  branchKept?: string;
  portsReleased: boolean;
}

/** A refusal that carries what blocked it, so a CLI can list it. */
export class WorktreeRemoveRefusal extends Error {
  constructor(
    readonly reason: "unpromoted" | "dirty",
    message: string,
    readonly unpromoted?: Unpromoted,
  ) {
    super(message);
    this.name = "WorktreeRemoveRefusal";
  }
}

interface ListedWorktree {
  path: string;
  branch?: string;
}

async function canonical(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target));
}

async function listWorktrees(cwd: string): Promise<ListedWorktree[]> {
  const listed = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) {
    throw new Error(`git worktree list failed: ${listed.stderr.trim()}`);
  }
  const found: ListedWorktree[] = [];
  for (const block of listed.stdout.split("\n\n")) {
    let entry: ListedWorktree | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) entry = { path: line.slice("worktree ".length) };
      else if (line.startsWith("branch refs/heads/") && entry !== undefined) entry.branch = line.slice("branch refs/heads/".length);
    }
    if (entry !== undefined) found.push(entry);
  }
  return found;
}

function describeUnpromoted(unpromoted: Unpromoted): string {
  const lines = [
    ...unpromoted.memory.map((entry) => `  memory   ${entry.path} (${entry.state})`),
    ...unpromoted.learning.map((entry) => `  learning ${entry.id} (${entry.domain})`),
  ];
  return lines.join("\n");
}

export async function removeWorktree(opts: RemoveOptions): Promise<RemoveResult> {
  const force = opts.force === true;
  const context = await resolveWorktreeContext(opts.cwd);
  const [main, ...linked] = await listWorktrees(context.root);
  if (main === undefined) throw new Error("git lists no worktrees here");

  const wanted = await canonical(path.resolve(opts.cwd, opts.name));
  const matches: ListedWorktree[] = [];
  for (const candidate of linked) {
    if (path.basename(candidate.path) === opts.name || candidate.branch === opts.name || (await canonical(candidate.path)) === wanted) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) {
    if ((await canonical(main.path)) === wanted || path.basename(main.path) === opts.name) {
      throw new Error("refusing to remove the main checkout");
    }
    throw new Error(`no linked worktree named "${opts.name}" (see git worktree list)`);
  }
  if (matches.length > 1) {
    throw new Error(`"${opts.name}" matches ${matches.length} worktrees; pass the full path`);
  }
  const target = matches[0] as ListedWorktree;
  const targetRoot = await canonical(target.path);

  if (context.root === targetRoot) {
    throw new Error("refusing to remove the worktree this command runs in: run it from another checkout");
  }

  const unpromoted = await listUnpromoted(targetRoot, opts);
  if (!force && (unpromoted.memory.length > 0 || unpromoted.learning.length > 0)) {
    throw new WorktreeRemoveRefusal(
      "unpromoted",
      `${path.basename(targetRoot)} holds entries that exist nowhere else:\n${describeUnpromoted(unpromoted)}\n` +
        "Promote them (keryx worktree promote), commit them, or pass --force to discard them.",
      unpromoted,
    );
  }
  const dirty = await runGit(targetRoot, ["status", "--porcelain"]);
  if (!force && (dirty.code !== 0 || dirty.stdout.trim().length > 0)) {
    throw new WorktreeRemoveRefusal("dirty", `${path.basename(targetRoot)} has uncommitted changes; commit them or pass --force`);
  }

  const checkout = await readCheckout(targetRoot);
  const removed = await runGit(context.mainRoot, ["worktree", "remove", ...(force ? ["--force"] : []), "--", target.path]);
  if (removed.code !== 0) {
    throw new Error(`git worktree remove failed: ${removed.stderr.trim() || removed.stdout.trim()}`);
  }

  let portsReleased = false;
  if (checkout !== undefined) {
    await releasePorts(context.commonDir, checkout.checkoutId);
    portsReleased = true;
  }

  const result: RemoveResult = { path: targetRoot, branchDeleted: false, portsReleased };
  if (target.branch !== undefined) {
    result.branch = target.branch;
    if (opts.keepBranch === true) {
      result.branchKept = "--keep-branch";
    } else {
      // `-d` refuses an unmerged branch; only an explicit --force reaches `-D`.
      const deleted = await runGit(context.mainRoot, ["branch", force ? "-D" : "-d", "--", assertGitRevision(target.branch)]);
      if (deleted.code === 0) {
        result.branchDeleted = true;
      } else {
        result.branchKept = deleted.stderr.trim().split("\n")[0] || "git could not delete the branch";
      }
    }
  }
  return result;
}
