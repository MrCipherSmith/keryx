// Every git call in `src/worktree` goes through `runGit`. Keeping one seam lets
// a test wrap it and prove the module never mutates the owner's history or
// index, and `FORBIDDEN_GIT_SUBCOMMANDS` makes that guarantee structural: the
// helper itself refuses those subcommands.

import { withoutGitDiscoveryOverrides } from "../lib/git-env";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunGitOptions {
  env?: Record<string, string | undefined>;
}

/** Subcommands this module must never run: they change the owner's index, stash or history. */
export const FORBIDDEN_GIT_SUBCOMMANDS: readonly string[] = ["stash", "add", "commit", "push"];

// Global options that take a separate value argument.
const GLOBAL_OPTIONS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** The git subcommand of `args`, skipping global options such as `-c k=v` and `-C dir`. */
export function gitSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return undefined;
}

export async function runGit(cwd: string, args: readonly string[], opts: RunGitOptions = {}): Promise<GitResult> {
  const subcommand = gitSubcommand(args);
  if (subcommand !== undefined && FORBIDDEN_GIT_SUBCOMMANDS.includes(subcommand)) {
    throw new Error(`git ${subcommand} is forbidden in src/worktree`);
  }
  const env = withoutGitDiscoveryOverrides({ ...process.env, ...opts.env });
  const proc = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** The absolute git directory of `cwd`'s checkout: `<common>/worktrees/<name>` for a linked worktree. Throws outside a repository. */
export async function gitDirOf(cwd: string): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "--absolute-git-dir"]);
  const out = result.stdout.trim();
  if (result.code !== 0 || out.length === 0) {
    throw new Error(`not a git repository: ${cwd}`);
  }
  return out;
}
