import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { skillsCommand } from "./skills";

// Flow 360 (F-011): `--only` is tested against `importProjectSkills` in
// `gdskills/import-skills.test.ts`. What only the COMMANDS do is tested here:
// read `--only` off argv (both spellings, repeated) and hand it to the
// importer. Dropped at either entry point, a tree import either is refused for
// want of a selection or — outside module `review` — imports the whole tree.

let root: string;
let overlay: string;
const startCwd = process.cwd();

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-import-only-")));
  overlay = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-import-only-src-")));
  await mkdir(path.join(root, ".metaproject", "data", "gdskills"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    `${JSON.stringify({ modules: { gdskills: {} } }, null, 2)}\n`,
    "utf8",
  );
  for (const name of ["review-house-api", "review-house-ui", "review-other", "helper"]) {
    await mkdir(path.join(overlay, "skills", name), { recursive: true });
    await writeFile(
      path.join(overlay, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: "Reviews src/** changes."\n---\n\n# ${name}\n`,
      "utf8",
    );
  }
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(startCwd);
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
  await rm(overlay, { recursive: true, force: true });
});

async function capture(run: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => {
    out.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    err.push(parts.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

async function installedIn(moduleName: string): Promise<string[]> {
  return (await readdir(path.join(root, ".metaproject", "project-skills", moduleName)).catch(() => [])).sort();
}

describe("keryx skills import --only", () => {
  test("imports the packages the globs select, in both spellings, and nothing else", async () => {
    const { out, err } = await capture(() =>
      skillsCommand(["import", "--from", overlay, "--module", "review", "--only", "review-house-a*", "--only=review-other", "--json"]),
    );
    expect(err).toBe("");
    const result = JSON.parse(out) as { only: string[]; imported: { name: string; status: string }[] };
    expect(result.only).toEqual(["review-house-a*", "review-other"]);
    expect(result.imported.map((row) => `${row.name}:${row.status}`)).toEqual([
      "review-house-api:imported",
      "review-other:imported",
    ]);
    expect(await installedIn("review")).toEqual(["review-house-api", "review-other"]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("an empty --only exits 1 and imports nothing — it used to import the whole tree", async () => {
    for (const only of [["--only", ""], ["--only="], ["--only"]]) {
      const { out, err } = await capture(() => skillsCommand(["import", "--from", overlay, "--module", "quality", ...only]));
      expect(out).toBe("");
      expect(err).toContain("keryx skills import: --only needs a glob");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    }
    expect(await installedIn("quality")).toEqual([]);
  });
});

describe("keryx review import --only", () => {
  test("imports the reviewers the globs select, in both spellings, and nothing else", async () => {
    const { out, err } = await capture(() =>
      reviewCommand(["import", "--from", overlay, "--only=review-house-*", "--only", "helper", "--json"]),
    );
    expect(err).toBe("");
    const result = JSON.parse(out) as {
      only: string[];
      imported: { name: string; status: string }[];
      inventory: { project: { name: string }[] };
    };
    expect(result.only).toEqual(["review-house-*", "helper"]);
    expect(result.imported.map((row) => `${row.name}:${row.status}`)).toEqual([
      "helper:imported",
      "review-house-api:imported",
      "review-house-ui:imported",
    ]);
    expect(result.inventory.project.map((reviewer) => reviewer.name)).toEqual(["helper", "review-house-api", "review-house-ui"]);
    expect(await installedIn("review")).toEqual(["helper", "review-house-api", "review-house-ui"]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("an empty --only exits 1 in this command's spelling and imports nothing", async () => {
    for (const only of [["--only", ""], ["--only="], ["--only"]]) {
      const { out, err } = await capture(() => reviewCommand(["import", "--from", overlay, ...only]));
      expect(out).toBe("");
      expect(err).toContain("keryx review import: --only needs a glob");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    }
    expect(await installedIn("review")).toEqual([]);
  });
});
