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

// AFC-22/AFC-W05 (flow 236, phase 4, T7): "a git failure yields unknown" only
// holds if a git failure is itself distinguishable from a git *success*. The
// previous `gitCmd` collapsed three different events into one `null` answer:
//   1. the process could not be started at all (spawn error — git missing,
//      permission denied, a `cwd` that does not exist);
//   2. the process started and exited non-zero (git RAN and refused — a
//      corrupt repo, a bad revision, "fatal: not a git repository"; note
//      some commands, e.g. `cat-file -e`, use a non-zero exit as their own
//      legitimate negative *answer*, not a failure — that distinction is the
//      caller's to make, which is exactly why it needs the raw exit code);
//   3. the process ran, exited zero, and produced no stdout — a legitimate
//      result for several commands (`git log` over a range with zero
//      matching commits, `git status --porcelain` on a clean tree).
// Every caller that only ever saw `string | null` necessarily read (1) and
// (2) as the same fact, and — wherever it used a truthy check like `if
// (!result)` — case (3) as well. `gitCmdResult` is the separated primitive;
// `gitCmd` below is now a thin, byte-identical-behavior wrapper over it, kept
// so every existing caller (`gdgraph/staleness.ts`, `sync/diff.ts`,
// `commands/wiki.ts`, …) is unaffected. New or updated callers that need to
// tell "could not run" apart from "ran and refused" apart from "ran and said
// nothing" should call `gitCmdResult` directly instead of adding another
// ad hoc null check.
export type GitCmdResult =
  | { kind: "ok"; stdout: string }
  | { kind: "spawn-error"; message: string }
  | { kind: "exit-error"; code: number | null; stderr: string };

export function gitCmdResult(cwd: string, args: string[]): Promise<GitCmdResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        err += String(chunk);
      });
      child.on("error", (error) => {
        resolve({ kind: "spawn-error", message: error instanceof Error ? error.message : String(error) });
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ kind: "ok", stdout: out.trim() });
        } else {
          resolve({ kind: "exit-error", code, stderr: err.trim() });
        }
      });
    } catch (error) {
      resolve({ kind: "spawn-error", message: error instanceof Error ? error.message : String(error) });
    }
  });
}

// Run a git command, returning trimmed stdout or null on any failure.
//
// Back-compat surface, deliberately unchanged: `null` still means "spawn
// error OR non-zero exit", and a genuinely empty successful result still
// comes back as `""` (not `null`) exactly as before — verified against
// `gitCmdResult` directly in `provenance.test.ts` so this stays true.
export async function gitCmd(cwd: string, args: string[]): Promise<string | null> {
  const result = await gitCmdResult(cwd, args);
  return result.kind === "ok" ? result.stdout : null;
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
