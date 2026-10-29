// Flow 474 (review-engine-speedup R2): what `keryx review next` writes, and what it says about it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { waveEventsPath } from "../review/wave-events";
import { reviewCommand } from "./review";
import { printNextHelp } from "./review-next";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;
let root = "";
let pkg = "";
let logs: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-review-next-cmd-"));
  pkg = path.join(root, ".metaproject", "reviews", "r1");
  await mkdir(path.join(pkg, "raw"), { recursive: true });
  process.chdir(root);
  logs = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  process.exitCode = 0;
  await writeFile(path.join(root, "change.diff"), `diff --git a/src/m/a.ts b/src/m/a.ts\n--- a/src/m/a.ts\n+++ b/src/m/a.ts\n@@ -1,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;\n`, "utf8");
  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", "30000", "--package", pkg]);
  expect(process.exitCode).toBe(0);
  logs = [];
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = 0;
  process.chdir(ORIGINAL_CWD);
  await rm(root, { recursive: true, force: true });
});

/** Every file under the package with its size, mtime and content, so a change to any of them shows. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const info = await stat(full);
        out[path.relative(dir, full)] = `${info.size}:${info.mtimeMs}:${await readFile(full, "utf8")}`;
      }
    }
  };
  await walk(dir);
  return out;
}

test("only wave-events changes: without --apply the one file written is tool-calls/wave-events.jsonl", async () => {
  const before = await snapshot(pkg);
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic"]);
  expect(process.exitCode).toBe(0);
  const after = await snapshot(pkg);

  const changed = Object.keys(after).filter((file) => before[file] !== after[file]);
  expect(changed).toEqual([path.join("tool-calls", "wave-events.jsonl")]);
  expect(Object.keys(before).filter((file) => after[file] === undefined)).toEqual([]);
  expect((await readFile(waveEventsPath(pkg), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});

test("only wave-events changes: --help says so, and the read-only line no longer claims nothing was written", async () => {
  printNextHelp();
  const help = logs.join("\n");
  expect(help).toContain("appends an event to tool-calls/wave-events.jsonl");
  expect(help).toContain("the only file it writes without");
  logs = [];

  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic"]);
  expect(logs.join("\n")).not.toContain("read-only: nothing was written");
});
