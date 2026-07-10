import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";

export type CommandResult = {
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number;
};

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".metaproject",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  "storybook-static",
  "public",
  "static",
  "generated",
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export async function runCommand(
  command: string[],
  cwd: string,
): Promise<CommandResult> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const combined = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
  return { stdout, stderr, combined, exitCode };
}

export function commandExists(bin: string): boolean {
  return Bun.which(bin) !== null;
}

export async function toolVersion(
  command: string[],
  cwd: string,
): Promise<string | null> {
  if (!commandExists(command[0] ?? "")) {
    return null;
  }
  try {
    const result = await runCommand(command, cwd);
    const line = result.combined.split("\n").find((l) => l.trim().length > 0);
    return line ? line.trim() : null;
  } catch {
    return null;
  }
}

export function dataRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "health");
}

export async function writeRaw(
  cwd: string,
  source: string,
  content: string,
  stamp: string,
): Promise<string> {
  const dir = path.join(dataRoot(cwd), "raw", source);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stamp}.log`);
  await writeFile(file, content, "utf8");
  return path.relative(cwd, file);
}

export async function listSourceFiles(cwd: string, ignorePaths: string[] = []): Promise<string[]> {
  const results: string[] = [];
  await walk(cwd, cwd, results);
  return results.filter((file) => !matchesAnyPattern(file, ignorePaths)).sort();
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") {
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
        // allow hidden dirs that are not ignored? keep it simple: skip hidden dirs.
      }
      continue;
    }
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await walk(root, abs, out);
    } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(path.relative(root, abs));
    }
  }
}

export async function countLoc(cwd: string, files: string[]): Promise<number> {
  let total = 0;
  for (const file of files) {
    const abs = path.join(cwd, file);
    if (!(await pathExists(abs))) {
      continue;
    }
    const content = await readFile(abs, "utf8");
    total += content.split("\n").length;
  }
  return total;
}

export function moduleOfFile(file: string): string | null {
  const parts = file.split("/");
  if (parts[0] === "src" && parts.length > 2) {
    return `src/${parts[1]}`;
  }
  if (parts.length > 1) {
    return parts[0] ?? null;
  }
  return null;
}

export function isSourceFile(file: string): boolean {
  return SOURCE_EXT.has(path.extname(file));
}

export function matchesAnyPattern(file: string, patterns: string[]): boolean {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return patterns.some((pattern) => matchesPattern(normalized, pattern));
}

function matchesPattern(file: string, pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("**/") && normalized.endsWith("/**")) {
    const segment = normalized.slice(3, -3);
    return file === segment || file.startsWith(`${segment}/`) || file.includes(`/${segment}/`);
  }
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (normalized.endsWith("*")) {
    return file.startsWith(normalized.slice(0, -1));
  }
  return file === normalized || file.startsWith(`${normalized}/`);
}
