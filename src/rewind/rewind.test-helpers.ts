import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";

export interface TestProject {
  root: string;
  rewindDir: string;
}

export function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: withoutGitDiscoveryOverrides(process.env), encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export function write(root: string, rel: string, content: string | Uint8Array): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function read(root: string, rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

export function exists(root: string, rel: string): boolean {
  return existsSync(path.join(root, rel));
}

/** A committed temp git repository with a few tracked files, plus a session-side rewind dir outside it. */
export function makeProject(): TestProject {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-rewind-")));
  const root = path.join(base, "project");
  mkdirSync(root, { recursive: true });
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Test"]);
  write(root, "a.txt", "alpha\n");
  write(root, "src/b.ts", "export const b = 1;\n");
  write(root, ".gitignore", "ignored.log\nbuild/\n");
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "init"]);
  return { root, rewindDir: path.join(base, "session", "rewind") };
}

function walk(dir: string, prefix: string, into: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, rel, into);
    else if (entry.isFile() && statSync(full).size < 1_000_000) into[rel] = readFileSync(full).toString("base64");
  }
}

/** Bytes of everything in the project's own `.git` that a snapshot or restore must never change. */
export function projectGitFingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  walk(path.join(root, ".git"), ".git", out);
  return out;
}
