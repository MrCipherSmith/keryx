import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";

export const REWIND_MAX_FILE_BYTES = 5 * 1024 * 1024;

const SHADOW_EXCLUDES = [".git", "node_modules/", ".metaproject/data/"];

export interface ShadowRepo {
  gitDir: string;
  workTree: string;
  native?: ShadowNativeBoundary;
}
export interface ShadowGitRequest { repo: { gitDir: string; workTree: string }; args: readonly string[]; stdin?: string; signal: AbortSignal; readOnly: boolean }
export interface ShadowNativeBoundary {
  runGit(request: ShadowGitRequest): Promise<GitResult>;
  signal(): AbortSignal;
  assertOwnership(): void;
  validatePaths(paths: readonly string[], signal: AbortSignal): Promise<void>;
  currentPaths(): readonly string[];
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

export async function git(repo: ShadowRepo, args: readonly string[], options: { stdin?: string; signal?: AbortSignal } = {}): Promise<GitResult> {
  const signal = options.signal ?? repo.native?.signal();
  signal?.throwIfAborted();
  if (repo.native !== undefined) {
    repo.native.assertOwnership();
    if (!safeShadowArguments(args)) throw new Error("unsupported-shadow-operation");
    if (args[0] === "cat-file" && args[1] === "--batch") {
      if (options.stdin === undefined || Buffer.byteLength(options.stdin) > 256 * 1024 || !/^(?:[a-f0-9]{40}\n){1,5000}$/.test(options.stdin)) throw new Error("unsupported-shadow-input");
    } else if (args[0] === "update-index" || args[0] === "checkout-index") {
      const input = options.stdin;
      if (input === undefined || Buffer.byteLength(input) > 1024 * 1024 || !input.endsWith("\0")) throw new Error("unsupported-shadow-input");
      const paths = input.slice(0, -1).split("\0");
      if (paths.length > 5000 || new Set(paths).size !== paths.length) throw new Error("unsupported-shadow-input");
      for (const relative of paths) assertNativeShadowPath(repo.workTree, relative);
      await repo.native.validatePaths(paths, signal!);
    } else if (options.stdin !== undefined) throw new Error("unsupported-shadow-input");
    const result = await repo.native.runGit({ repo: { gitDir: repo.gitDir, workTree: repo.workTree }, args: Object.freeze([...args]),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }), signal: signal!, readOnly: args[0] === "ls-tree" || args[0] === "cat-file" });
    signal!.throwIfAborted();
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 6 * 1024 * 1024) throw new Error("shadow-output-quota");
    return result;
  }
  const proc = Bun.spawn(["git", ...HARDENING, ...args], {
    cwd: repo.workTree,
    env: shadowEnv(repo),
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(signal === undefined ? {} : { signal }),
    timeout: 30_000,
    maxBuffer: 6 * 1024 * 1024,
  });
  if (options.stdin !== undefined && proc.stdin !== undefined && typeof proc.stdin !== "number") {
    proc.stdin.write(options.stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

export async function gitOk(repo: ShadowRepo, args: readonly string[], options: { stdin?: string; signal?: AbortSignal } = {}): Promise<string> {
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
  repo.native?.assertOwnership(); repo.native?.signal().throwIfAborted();
  mkdirSync(repo.gitDir, { recursive: true });
  await gitOk(repo, ["init", "--quiet"]);
  mkdirSync(path.join(repo.gitDir, "info"), { recursive: true });
  await writeFileAtomic(path.join(repo.gitDir, "info", "exclude"), `${SHADOW_EXCLUDES.join("\n")}\n`);
}
/** Source-owned fixed commands only. No caller options, executable, pathspec, config or environment arguments. */
export function safeShadowArguments(args: readonly string[]): boolean {
  const oid = (value: string | undefined) => value !== undefined && /^[a-f0-9]{40}$/.test(value);
  const joined = args.join(" ");
  if (["init --quiet", "ls-files -z -o -m -d --exclude-standard", "update-index --add --remove --replace -z --stdin", "write-tree", "checkout-index -f -z --stdin", "prune --expire=now"].includes(joined)) return true;
  if (args[0] === "update-ref") return args.length === 3 && ((/^refs\/rewind\/[1-9]\d*$/.test(args[1] ?? "") && oid(args[2])) || (args[1] === "-d" && /^refs\/rewind\/[1-9]\d*$/.test(args[2] ?? "")));
  if (args[0] === "read-tree") return args.length === 2 && oid(args[1]);
  if (args[0] === "ls-tree") return args.length === 5 && args.slice(1, 4).join(" ") === "-r -z -l" && oid(args[4]);
  if (args[0] === "cat-file") return (args.length === 3 && args[1] === "blob" && oid(args[2])) || (args.length === 2 && args[1] === "--batch");
  return args.length === 7 && args[0] === "diff-tree" && args[1] === "-r" && args[2] === "-z" && ["--name-only", "--name-status"].includes(args[3] ?? "") && args[4] === "--no-renames" && oid(args[5]) && oid(args[6]);
}

export function assertNativeShadowPath(root: string, rel: string): void {
  if (!rel || rel.includes("\\") || /[\r\n\0]/.test(rel) || path.posix.isAbsolute(rel) || rel.split("/").some(part => !part || part === "." || part === "..") || rel === ".git" || [".git/", "node_modules/", ".metaproject/data/"].some(prefix => rel.startsWith(prefix))) throw new Error("unsupported-snapshot");
  let current = realpathSync(root);
  for (const [index, part] of rel.split("/").entries()) {
    if (existsSync(path.join(current, ".gitattributes"))) throw new Error("unsupported-snapshot-attributes");
    current = path.join(current, part);
    try { const stat = lstatSync(current); if (stat.isSymbolicLink() || (index < rel.split("/").length - 1 && !stat.isDirectory())) throw new Error("unsupported-snapshot"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
