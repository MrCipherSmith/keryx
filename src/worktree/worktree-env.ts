// `keryx worktree env` and `keryx worktree exec` (spec §6): hand the worktree's
// allocated ports to a shell or to one command, without a shell in between.

import { readWorktreeEnv } from "./ports";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuote(value: string): string {
  if (SAFE_VALUE.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** `export NAME=value` lines for `eval "$(keryx worktree env)"`; values are single-quoted unless plainly safe. */
export function formatExports(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) throw new Error(`not a valid environment variable name: ${name}`);
    lines.push(`export ${name}=${shellQuote(value)}\n`);
  }
  return lines.join("");
}

export interface ExecInWorktreeOptions {
  cwd: string;
  argv: readonly string[];
  /** Extra variables, applied after the process environment and `worktree.env`. */
  env?: Record<string, string>;
}

/** Run `argv` (no shell) in `cwd` with the process environment plus the worktree's ports; returns its exit code. */
export async function execInWorktree(opts: ExecInWorktreeOptions): Promise<number> {
  if (opts.argv.length === 0) throw new Error("no command given");
  const overlay = await readWorktreeEnv(opts.cwd);
  const proc = Bun.spawn([...opts.argv], {
    cwd: opts.cwd,
    env: { ...process.env, ...overlay, ...opts.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}
