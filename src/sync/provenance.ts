import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathExists } from "../lib/fs";

// Build provenance: each derived artifact (graph, wiki, memory, …) records the
// git commit it was last built from, so a later `keryx sync` can compute exactly
// what changed (added / modified / deleted) since and update incrementally.
// Local git only; a non-git project degrades to "no provenance" (full rebuild).

export interface Provenance {
  commit: string;
  branch: string;
  builtAt: string;
}

// Modules that carry build provenance.
export const SYNCED_MODULES = ["gdgraph", "gdwiki", "memory"] as const;
export type SyncedModule = (typeof SYNCED_MODULES)[number];

export function provenancePath(cwd: string, module: string): string {
  return path.join(cwd, ".metaproject", "data", module, ".provenance.json");
}

// Run a git command, returning trimmed stdout or null on any failure.
export function gitCmd(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    } catch {
      resolve(null);
    }
  });
}

export async function gitHead(cwd: string): Promise<{ commit: string; branch: string } | null> {
  const commit = await gitCmd(cwd, ["rev-parse", "HEAD"]);
  if (!commit) return null;
  const branch = (await gitCmd(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "HEAD";
  return { commit, branch };
}

// Stamp `<module>` with the current HEAD. No-op (silent) outside a git repo.
export async function recordProvenance(cwd: string, module: string, at: string): Promise<void> {
  const head = await gitHead(cwd);
  if (!head) return;
  const file = provenancePath(cwd, module);
  await mkdir(path.dirname(file), { recursive: true });
  const provenance: Provenance = { commit: head.commit, branch: head.branch, builtAt: at };
  await writeFile(file, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
}

export async function readProvenance(cwd: string, module: string): Promise<Provenance | null> {
  const file = provenancePath(cwd, module);
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as Provenance).commit === "string") {
      return parsed as Provenance;
    }
  } catch {
    // malformed ⇒ treat as absent
  }
  return null;
}
