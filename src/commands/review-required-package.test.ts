// `review required --package <dir>` reads the package's own scope-A file list, blast-radius record and
// pr-context.md, so the operator does not have to pass them. An explicit flag still wins.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createLayersFixture, type LayersFixture } from "../review/layers.test-helpers";
import { reviewCommand } from "./review";

let fixture: LayersFixture;
let previousCwd: string;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  fixture = await createLayersFixture();
  previousCwd = process.cwd();
  process.chdir(fixture.root);
  logs = [];
  errors = [];
  spyOn(console, "log").mockImplementation((...parts: unknown[]) => void logs.push(parts.join(" ")));
  spyOn(console, "error").mockImplementation((...parts: unknown[]) => void errors.push(parts.join(" ")));
  process.exitCode = 0;
});
afterEach(async () => {
  process.chdir(previousCwd);
  process.exitCode = 0;
  (console.log as unknown as { mockRestore(): void }).mockRestore();
  (console.error as unknown as { mockRestore(): void }).mockRestore();
  await fixture.cleanup();
});

async function requiredJson(args: string[]): Promise<{ required: string[]; excluded: Array<{ reviewer: string; reason: string }>; filesKnown: boolean }> {
  logs.length = 0;
  await reviewCommand(["required", "--json", ...args]);
  return JSON.parse(logs.join("\n"));
}

test("--mode diff takes the scope-A file list from the package's scope-files.json", async () => {
  await writeFile(path.join(fixture.packageDir, "scope-files.json"), JSON.stringify({ version: 1, files: ["src/a.ts"] }));
  const result = await requiredJson(["--mode", "diff", "--operator-quote", "just the diff", "--package", fixture.packageDir]);
  expect(process.exitCode).toBe(0);
  expect(result.filesKnown).toBe(true);
});

test("--mode diff with neither --scope nor a package file list is still refused", async () => {
  await reviewCommand(["required", "--mode", "diff", "--operator-quote", "just the diff", "--package", fixture.packageDir]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("scope-A file list");
});

test("the package's pr-context.md and blast-radius.json count without --pr-context / --blast-radius", async () => {
  const bare = await requiredJson(["--package", fixture.packageDir]);
  expect(bare.excluded.some((item) => item.reason.includes("pr-context.md"))).toBe(true);
  expect(bare.excluded.some((item) => item.reason.includes("blast"))).toBe(true);

  await writeFile(path.join(fixture.packageDir, "pr-context.md"), "# PR\n");
  await writeFile(path.join(fixture.packageDir, "blast-radius.json"), JSON.stringify({ files: [], changedFiles: ["src/a.ts"] }));
  const filled = await requiredJson(["--package", fixture.packageDir]);
  expect(filled.excluded.some((item) => item.reason.includes("pr-context.md"))).toBe(false);
  expect(filled.excluded.some((item) => item.reason.includes("blast"))).toBe(false);
  expect(filled.required.length).toBeGreaterThan(bare.required.length);
});

test("an explicit --scope wins over the package's scope-files.json", async () => {
  await writeFile(path.join(fixture.packageDir, "scope-files.json"), JSON.stringify({ version: 1, files: ["src/a.ts"] }));
  const scopeFile = path.join(fixture.root, "scope.json");
  await writeFile(scopeFile, JSON.stringify({ files: ["src/b.ts", "src/c.ts"], counts: { changedLinesRetained: 10 }, drops: [] }));
  await reviewCommand(["required", "--package", fixture.packageDir, "--scope", scopeFile]);
  const depth = JSON.parse(await Bun.file(path.join(fixture.packageDir, "round-depth.json")).text());
  expect(depth.files).toBe(2);
});
