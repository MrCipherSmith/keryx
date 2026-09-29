import { mkdirSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";

export const REWIND_MAX_FILE_BYTES = 5 * 1024 * 1024;

const SHADOW_EXCLUDES = [".git", "node_modules/", ".metaproject/data/"];

export interface ShadowRepo {
  gitDir: string;
  workTree: string;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function shadowRepo(rewindDir: string, workTree: string): ShadowRepo {
  return { gitDir: path.join(rewindDir, "shadow.git"), workTree };
}

/** Explicit GIT_DIR/GIT_WORK_TREE, every other inherited GIT_* dropped, no hooks, no global config. */
function shadowEnv(repo: ShadowRepo): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(withoutGitDiscoveryOverrides(process.env))) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env.GIT_DIR = repo.gitDir;
  env.GIT_WORK_TREE = repo.workTree;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

const HARDENING = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];

export async function git(repo: ShadowRepo, args: readonly string[], options: { stdin?: string } = {}): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...HARDENING, ...args], {
    cwd: repo.workTree,
    env: shadowEnv(repo),
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined && proc.stdin !== undefined && typeof proc.stdin !== "number") {
    proc.stdin.write(options.stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

export async function gitOk(repo: ShadowRepo, args: readonly string[], options: { stdin?: string } = {}): Promise<string> {
  const result = await git(repo, args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
  }
  return result.stdout;
}

export function splitNul(text: string): string[] {
  return text.split("\0").filter((entry) => entry.length > 0);
}

export async function initShadow(repo: ShadowRepo): Promise<void> {
  mkdirSync(repo.gitDir, { recursive: true });
  await gitOk(repo, ["init", "--quiet"]);
  mkdirSync(path.join(repo.gitDir, "info"), { recursive: true });
  await writeFileAtomic(path.join(repo.gitDir, "info", "exclude"), `${SHADOW_EXCLUDES.join("\n")}\n`);
}
