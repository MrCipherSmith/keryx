import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runLearnProbe } from "./learn-probe";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function invoke(args: string[]) {
 const root = await mkdtemp(path.join(tmpdir(), "probe-cli-")); roots.push(root);
 const stdout: string[] = []; const stderr: string[] = [];
 const code = await runLearnProbe(args, { root, isTerminal: false, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
 expect(await readdir(root)).toEqual([]);
 return { code, stdout, stderr };
}
for (const args of [[], ["bad/id", "--task", "task"], ["pattern", "--task", "task", "--runs", "0"], ["pattern", "--task", "task", "--runs", "1.5"], ["pattern", "--task", "task", "--force"], ["pattern", "--task", "task", "--dry-run=true"]]) {
 test(`invalid args: ${args.join(" ")}`, async () => {
  const r = await invoke([...args, "--json"]); expect(r.code).toBe(2); expect(r.stdout).toHaveLength(1);
  expect(JSON.parse(r.stdout[0]!)).toEqual({ schemaVersion: 1, refusal: "probe-invalid-arguments" });
 });
}
for (const budget of [undefined, "0", "-1", "NaN", "Infinity"]) {
 test(`budget ${budget} refuses`, async () => {
  const r = await invoke(["pattern", "--task", "task", "--json", ...(budget === undefined ? [] : ["--max-usd", budget])]);
  expect(r.code).toBe(2); expect(JSON.parse(r.stdout[0]!)).toEqual({ schemaVersion: 1, refusal: "probe-no-budget" });
 });
}
test("dry run rejects invalid supplied budget", async () => {
 const r = await invoke(["pattern", "--task", "task", "--dry-run", "--max-usd", "0", "--json"]);
 expect(r.code).toBe(2); expect(JSON.parse(r.stdout[0]!)).toEqual({ schemaVersion: 1, refusal: "probe-no-budget" });
});
test("missing task set refuses without writes", async () => {
 const r = await invoke(["pattern", "--task", "task", "--dry-run", "--json"]);
 expect(r.code).toBe(2); expect(JSON.parse(r.stdout[0]!)).toEqual({ schemaVersion: 1, refusal: "probe-bad-task-set" });
});
test("help is write free", async () => { const r = await invoke(["--help"]); expect(r.code).toBe(0); expect(r.stdout.join("\n")).toContain("--max-usd"); });
test("CLI probe help lists every flag without entering the command", () => {
 const result = Bun.spawnSync([process.execPath, "./src/cli.ts", "learn", "probe", "--help"], {
  cwd: process.cwd(), env: process.env,
 });
 expect(result.exitCode).toBe(0);
 const text = new TextDecoder().decode(result.stdout);
 for (const flag of ["--task", "--task-set", "--runs", "--model", "--provider", "--max-usd", "--dry-run", "--json"]) {
  expect(text).toContain(flag);
 }
 expect(new TextDecoder().decode(result.stderr)).toBe("");
});
