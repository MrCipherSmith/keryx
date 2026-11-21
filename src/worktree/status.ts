// `keryx worktree status` (spec §6): the label, ports, dependency state, env file
// names, prepare state and unpromoted entries of the checkout at `cwd`. Names
// only: no env file content, no entry bodies.

import { lstat } from "node:fs/promises";
import path from "node:path";
import { readCheckout, type Checkout } from "./checkout";
import { loadWorktreeConfig } from "./config";
import { resolveWorktreeContext } from "./context";
import { readDepsRecords, type DepsRecord } from "./deps";
import { runGit } from "./git";
import { listUnpromoted, type Unpromoted } from "./promote";
import { readPrepareState, type PrepareState } from "./prepare";
import { readWorktreeEnv } from "./ports";

export interface WorktreeStatus {
  root: string;
  /** True for the main checkout, which has no label, ports or prepare state. */
  main: boolean;
  branch?: string;
  checkout?: Checkout;
  ports: Record<string, string>;
  deps: DepsRecord[];
  /** Configured env file names that exist in this checkout. */
  envFiles: string[];
  prepare?: PrepareState;
  unpromoted: Unpromoted;
  /** Set when the project's worktree configuration could not be read. */
  configError?: string;
}

export async function worktreeStatus(cwd: string, opts: { env?: NodeJS.ProcessEnv; homeDir?: string } = {}): Promise<WorktreeStatus> {
  const context = await resolveWorktreeContext(cwd);
  const branch = (await runGit(context.root, ["branch", "--show-current"])).stdout.trim();
  const status: WorktreeStatus = {
    root: context.root,
    main: context.isMain,
    ...(branch.length > 0 && { branch }),
    ports: {},
    deps: [],
    envFiles: [],
    unpromoted: { memory: [], learning: [] },
  };
  if (context.isMain) return status;

  const checkout = await readCheckout(context.root);
  if (checkout !== undefined) status.checkout = checkout;
  status.ports = await readWorktreeEnv(context.root);
  status.deps = await readDepsRecords(context.root);
  const prepare = await readPrepareState(context.gitDir);
  if (prepare !== undefined) status.prepare = prepare;
  status.unpromoted = await listUnpromoted(context.root, opts);

  try {
    const config = await loadWorktreeConfig(context.mainRoot);
    for (const file of config.envFiles) {
      if (await lstat(path.join(context.root, file)).then((stat) => stat.isFile(), () => false)) status.envFiles.push(file);
    }
  } catch (cause) {
    status.configError = cause instanceof Error ? cause.message : String(cause);
  }
  return status;
}
