import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLastResolve, type ProjectContextResolution } from "./context-resolver";
import { runResolveContextCommand } from "./resolve-context-command";

const roots: string[] = [];
let out: string[] = [];
let err: string[] = [];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
const originalExitCode = process.exitCode;

beforeEach(() => {
  out = [];
  err = [];
  logSpy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => void out.push(parts.join(" ")));
  errSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => void err.push(parts.join(" ")));
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = originalExitCode;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(ruleBytes = 100): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-resolve-context-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject", "rules", "project"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), "{}\n", "utf8");
  const head = "---\ndescription: styling\nglobs: src/**\nalwaysApply: false\n---\n";
  await writeFile(path.join(root, ".metaproject/rules/project/styling.mdc"), head + "x".repeat(ruleBytes - head.length), "utf8");
  return root;
}

test("--json prints the resolution and records it as the last resolve", async () => {
  const root = await project();
  await runResolveContextCommand(["--files", "src/a.ts,src/b.ts", "--for", "implement", "--json"], root);
  const result = JSON.parse(out.join("\n")) as ProjectContextResolution;
  expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
  expect(result.entries.map((entry) => entry.path)).toEqual([".metaproject/rules/project/styling.mdc"]);
  expect((await readLastResolve(root))?.result).toEqual(result);
  expect(err).toEqual([]);
  expect(process.exitCode).toBe(originalExitCode);
});

test("--out writes the same JSON to a file inside the project and prints where", async () => {
  const root = await project();
  await runResolveContextCommand(["--files=src/a.ts", "--for=test", "--out", ".metaproject/data/resolved.json"], root);
  const written = JSON.parse(await readFile(path.join(root, ".metaproject/data/resolved.json"), "utf8")) as ProjectContextResolution;
  expect(written.for).toBe("test");
  expect(out.join("\n")).toContain(".metaproject/data/resolved.json");
});

test("--out outside the project is refused and nothing is written", async () => {
  const root = await project();
  await expect(runResolveContextCommand(["--files", "src/a.ts", "--for", "implement", "--out", "../escape.json"], root)).rejects.toThrow();
});

test("a rule over the cap prints one stderr warning, marks exceeded and still exits 0", async () => {
  const root = await project(5000);
  await runResolveContextCommand(["--files", "src/a.ts", "--for", "implement", "--max-bytes", "4096", "--json"], root);
  const result = JSON.parse(out.join("\n")) as ProjectContextResolution;
  expect(result.budget).toMatchObject({ exceeded: true, limitBytes: 4096, limitSource: "flag" });
  expect(result.entries[0]?.tier).toBe("on_demand");
  expect(err).toHaveLength(1);
  expect(err[0]).toContain("gdskills.projectContext.maxBytes");
  expect(process.exitCode).toBe(originalExitCode);
});

test("a non-numeric --max-bytes falls back with a warning naming the flag", async () => {
  const root = await project();
  await runResolveContextCommand(["--files", "src/a.ts", "--for", "implement", "--max-bytes", "lots", "--json"], root);
  expect(err.join("\n")).toContain("--max-bytes");
  expect((JSON.parse(out.join("\n")) as ProjectContextResolution).budget.limitSource).toBe("default");
});

test("the readable form lists must_read before on_demand entries", async () => {
  const root = await project();
  await runResolveContextCommand(["--files", "src/a.ts", "--for", "implement"], root);
  const text = out.join("\n");
  expect(text).toContain("must_read");
  expect(text).toContain(".metaproject/rules/project/styling.mdc");
});

test("a missing or unknown --for, or no --files, is a usage error", async () => {
  const root = await project();
  await expect(runResolveContextCommand(["--files", "src/a.ts"], root)).rejects.toThrow(/--for/);
  await expect(runResolveContextCommand(["--files", "src/a.ts", "--for", "deploy"], root)).rejects.toThrow(/--for/);
  await expect(runResolveContextCommand(["--for", "implement"], root)).rejects.toThrow(/--files/);
});
