// `review required --package <dir>` reads the package's own scope-A file list, blast-radius record and
// pr-context.md, so the operator does not have to pass them. An explicit flag still wins.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
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
  expect(depth.files).toEqual(["src/b.ts", "src/c.ts"]);
  expect(depth.changedLines).toBe(10);
});

test("a package that stored a line count gives a light round without --scope", async () => {
  await writeFile(path.join(fixture.packageDir, "scope-files.json"), JSON.stringify({ version: 1, files: ["src/a.ts"], changedLines: 12 }));
  logs.length = 0;
  await reviewCommand(["required", "--package", fixture.packageDir]);
  expect(logs.join("\n")).toContain("depth: light");
  const depth = JSON.parse(await Bun.file(path.join(fixture.packageDir, "round-depth.json")).text());
  expect(depth).toMatchObject({ depth: "light", changedLines: 12, files: ["src/a.ts"] });
});

test("a package with a file list but no line count stays full and says so", async () => {
  await writeFile(path.join(fixture.packageDir, "scope-files.json"), JSON.stringify({ version: 1, files: ["src/a.ts"] }));
  logs.length = 0;
  await reviewCommand(["required", "--package", fixture.packageDir]);
  const output = logs.join("\n");
  expect(output).toContain("depth: full");
  expect(output).toContain("no line count (");
  expect(output).toContain("--scope");
  expect(output).toContain("--diff-lines");
});

test("--depth light on a big package is not honoured", async () => {
  const files = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
  await writeFile(path.join(fixture.packageDir, "scope-files.json"), JSON.stringify({ version: 1, files, changedLines: 10 }));
  logs.length = 0;
  await reviewCommand(["required", "--depth", "light", "--package", fixture.packageDir]);
  expect(logs.join("\n")).toContain("depth: full (--depth light not honoured: 60 files exceeds 5)");
});

test("--package outside the project root is refused", async () => {
  await reviewCommand(["required", "--package", "/tmp/not-in-the-project"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("keryx review required --package");
});

// Flow 478: review-clean-code and review-style are off unless the round asks for them.
async function installRoles(names: string[]): Promise<void> {
  for (const name of names) {
    const dir = path.join(fixture.root, ".metaproject", "skills", "gdskills", "review", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`, "utf8");
  }
}

const READABILITY = ["review-clean-code", "review-style"];

test("R5: required leaves the readability roles out with the reason; --style brings them back and the package remembers", async () => {
  await installRoles(["review-logic", "review-architecture", ...READABILITY]);
  const plain = await requiredJson(["--package", fixture.packageDir]);
  expect(plain.required).not.toContain("review-clean-code");
  expect(plain.required).not.toContain("review-style");
  expect(plain.excluded.find((item) => item.reviewer === "review-style")?.reason).toContain("--style");

  const styled = await requiredJson(["--package", fixture.packageDir, "--style"]);
  expect(styled.required).toEqual(expect.arrayContaining(READABILITY));
  expect(JSON.parse(await Bun.file(path.join(fixture.packageDir, "round-roles.json")).text())).toEqual({ enabled: READABILITY });

  const later = await requiredJson(["--package", fixture.packageDir]);
  expect(later.required).toEqual(expect.arrayContaining(READABILITY));
});

test("R5: --all and --gating widen the depth, not the roster, and say so", async () => {
  await installRoles(["review-logic", "review-architecture", ...READABILITY]);
  for (const flag of ["--all", "--gating"]) {
    const result = (await requiredJson([flag])) as { required: string[]; warnings?: string[] };
    expect(result.required).not.toContain("review-clean-code");
    expect(result.warnings?.join("\n")).toContain(`${flag} does not bring back review-clean-code, review-style`);
  }
});

test("R5: --with-role turns on one role and nothing else", async () => {
  await installRoles(["review-logic", "review-architecture", ...READABILITY]);
  const result = await requiredJson(["--with-role", "review-style"]);
  expect(result.required).toContain("review-style");
  expect(result.required).not.toContain("review-clean-code");
});

test("R5: attach and ingest refuse --style and --with-role rather than ignoring them", async () => {
  for (const sub of ["attach", "ingest"]) {
    for (const flag of [["--style"], ["--with-role", "review-style"]]) {
      process.exitCode = 0;
      errors.length = 0;
      await reviewCommand([sub, "--target", "path", "--ref", "src", ...flag]);
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("belong to `keryx review start`");
    }
  }
});
