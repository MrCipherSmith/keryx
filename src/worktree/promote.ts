// `keryx worktree promote` (spec §5.2): move what a worktree learned out of it
// before it is removed. Two stores, both owner-driven:
//   - learning: the existing `promotePattern` (project accepted -> user candidate),
//     which insists on a terminal and a typed confirmation; nothing here relaxes that;
//   - memory: a copy of an uncommitted entry into the user memory root, under a file
//     lock, tagged with the source project and branch. Committing the entry to the
//     branch is the owner's ordinary commit, not this command.
// Without a terminal only `dryRun` works.

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withFileLock } from "../lib/file-lock";
import { LearningPromoteError, promotePattern } from "../learning/promote";
import { listPatterns, readPattern, type StoreEnvOptions } from "../learning/store";
import { memoryRootFor } from "../memory/store";
import { MEMORY_TYPES } from "../memory/types";
import { resolveWorktreeContext } from "./context";
import { runGit } from "./git";

export type PromoteStore = "memory" | "learning";
export const PROMOTE_STORES: readonly PromoteStore[] = ["memory", "learning"];

export interface UnpromotedMemory {
  /** Relative to the worktree root, e.g. `.metaproject/memory/lessons/x.md`. */
  path: string;
  state: "untracked" | "modified";
}

export interface UnpromotedLearning {
  id: string;
  domain: string;
}

export interface Unpromoted {
  memory: UnpromotedMemory[];
  learning: UnpromotedLearning[];
}

export interface PromoteOptions {
  cwd: string;
  stores?: readonly PromoteStore[];
  dryRun?: boolean;
  /** Whether a person can answer: stdin and stdout are terminals. Required for anything but `dryRun`. */
  interactive: boolean;
  /** Restrict to these learning ids / memory paths; default is everything listed. */
  entries?: readonly string[];
  /** Asks the owner to confirm one learning promotion; required when a learning entry will be promoted. */
  confirm?: (id: string) => Promise<boolean>;
  /** Overrides where the user area lives (tests); the same semantics as the learning store's. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => Date;
}

export interface PromoteReport {
  dryRun: boolean;
  candidates: Unpromoted;
  promoted: { memory: Array<{ path: string; destination: string }>; learning: string[] };
  /** Entries that were not moved, with the reason; a refused learning promotion is listed here, not thrown. */
  skipped: Array<{ store: PromoteStore; entry: string; reason: string }>;
}

const MEMORY_FOLDERS: ReadonlySet<string> = new Set(MEMORY_TYPES.map((entry) => entry.folder));
const MEMORY_LOCK_TIMEOUT_MS = 15_000;

function storeOptions(opts: { env?: NodeJS.ProcessEnv; homeDir?: string }): StoreEnvOptions {
  return {
    ...(opts.env !== undefined && { env: opts.env }),
    ...(opts.homeDir !== undefined && { homeDir: opts.homeDir }),
  };
}

/** `<folder>/<name>.md` under the memory root when `relative` (from the worktree root) is a typed memory entry. */
function memoryEntryParts(relative: string): { folder: string; name: string } | undefined {
  const prefix = ".metaproject/memory/";
  if (!relative.startsWith(prefix)) return undefined;
  const parts = relative.slice(prefix.length).split("/");
  if (parts.length !== 2) return undefined;
  const [folder, name] = parts as [string, string];
  if (!MEMORY_FOLDERS.has(folder) || !name.endsWith(".md") || name.startsWith(".")) return undefined;
  return { folder, name };
}

async function unpromotedMemory(root: string): Promise<UnpromotedMemory[]> {
  const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".metaproject/memory"]);
  if (status.code !== 0) return [];
  const found: UnpromotedMemory[] = [];
  const tokens = status.stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    const file = token.slice(3);
    // A rename or copy carries its source path as the next token.
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") index += 1;
    if (code.includes("D") || memoryEntryParts(file) === undefined) continue;
    found.push({ path: file, state: code === "??" ? "untracked" : "modified" });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function unpromotedLearning(root: string, options: StoreEnvOptions): Promise<UnpromotedLearning[]> {
  let accepted;
  try {
    accepted = await listPatterns(root, { scope: "project", status: "accepted" }, options);
  } catch {
    return [];
  }
  const found: UnpromotedLearning[] = [];
  for (const record of accepted) {
    const user = await readPattern(root, record.id, "user", options).catch(() => undefined);
    if (user !== undefined && (user.status === "candidate" || user.status === "accepted")) continue;
    found.push({ id: record.id, domain: record.domain });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** What this worktree holds that the owner has not yet carried out of it. Reads only this worktree's own stores. */
export async function listUnpromoted(cwd: string, opts: { env?: NodeJS.ProcessEnv; homeDir?: string } = {}): Promise<Unpromoted> {
  const context = await resolveWorktreeContext(cwd);
  return {
    memory: await unpromotedMemory(context.root),
    learning: await unpromotedLearning(context.root, storeOptions(opts)),
  };
}

function isRegularFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function tagged(content: string, project: string, branch: string, date: string): string {
  const separator = content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}- Promoted from project ${project}, branch ${branch} on ${date}.\n`;
}

interface MemoryCopyInput {
  worktreeRoot: string;
  userRoot: string;
  entries: readonly UnpromotedMemory[];
  project: string;
  branch: string;
  date: string;
}

/** Copy entries into the user memory root under one lock; never overwrites an existing entry. */
function copyMemoryEntries(input: MemoryCopyInput): { promoted: Array<{ path: string; destination: string }>; skipped: Array<{ entry: string; reason: string }> } {
  const promoted: Array<{ path: string; destination: string }> = [];
  const skipped: Array<{ entry: string; reason: string }> = [];
  const lockPath = path.join(input.userRoot, ".promote.lock");
  const outcome = withFileLock(
    lockPath,
    () => {
      for (const entry of input.entries) {
        const parts = memoryEntryParts(entry.path);
        const source = path.join(input.worktreeRoot, entry.path);
        if (parts === undefined || !isRegularFile(source)) {
          skipped.push({ entry: entry.path, reason: "not a regular memory entry file" });
          continue;
        }
        const destination = path.join(input.userRoot, parts.folder, parts.name);
        mkdirSync(path.dirname(destination), { recursive: true });
        try {
          writeFileSync(destination, tagged(readFileSync(source, "utf8"), input.project, input.branch, input.date), { flag: "wx" });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
            skipped.push({ entry: entry.path, reason: "an entry with this name already exists in the user memory" });
            continue;
          }
          throw cause;
        }
        promoted.push({ path: entry.path, destination });
      }
      return true;
    },
    { timeoutMs: MEMORY_LOCK_TIMEOUT_MS },
  );
  if (outcome === null) {
    throw new Error(`could not take the user memory lock: ${lockPath}`);
  }
  return { promoted, skipped };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Show or carry this worktree's new local entries to the user area. `dryRun` only
 * lists. Anything else needs a person at a terminal; without one it refuses and
 * writes nothing.
 */
export async function promoteWorktree(opts: PromoteOptions): Promise<PromoteReport> {
  const dryRun = opts.dryRun === true;
  if (!dryRun && !opts.interactive) {
    throw new Error("promote needs an interactive terminal: run it in a terminal, or add --dry-run to only list the entries");
  }
  const stores = opts.stores === undefined || opts.stores.length === 0 ? PROMOTE_STORES : opts.stores;
  const context = await resolveWorktreeContext(opts.cwd);
  const options = storeOptions(opts);
  const wanted = (id: string): boolean => opts.entries === undefined || opts.entries.length === 0 || opts.entries.includes(id);

  const candidates: Unpromoted = {
    memory: stores.includes("memory") ? (await unpromotedMemory(context.root)).filter((entry) => wanted(entry.path)) : [],
    learning: stores.includes("learning") ? (await unpromotedLearning(context.root, options)).filter((entry) => wanted(entry.id)) : [],
  };
  const report: PromoteReport = { dryRun, candidates, promoted: { memory: [], learning: [] }, skipped: [] };
  if (dryRun) return report;

  if (candidates.memory.length > 0) {
    const branch = await runGit(context.root, ["branch", "--show-current"]);
    const copied = copyMemoryEntries({
      worktreeRoot: context.root,
      userRoot: memoryRootFor("user", context.root, opts.env ?? process.env, opts.homeDir),
      entries: candidates.memory,
      project: path.basename(context.mainRoot),
      branch: branch.stdout.trim() || "(detached)",
      date: (opts.now?.() ?? new Date()).toISOString().slice(0, 10),
    });
    report.promoted.memory = copied.promoted;
    report.skipped.push(...copied.skipped.map((item) => ({ store: "memory" as const, ...item })));
  }

  for (const { id } of candidates.learning) {
    const confirm = opts.confirm;
    if (confirm === undefined) {
      report.skipped.push({ store: "learning", entry: id, reason: "no confirmation available" });
      continue;
    }
    try {
      await promotePattern(context.root, id, {
        isTerminal: opts.interactive,
        confirm: () => confirm(id),
        ...(opts.now !== undefined && { now: opts.now() }),
        ...options,
      });
      report.promoted.learning.push(id);
    } catch (cause) {
      const reason = cause instanceof LearningPromoteError ? `${cause.reason}: ${cause.message}` : messageOf(cause);
      report.skipped.push({ store: "learning", entry: id, reason });
    }
  }
  return report;
}
