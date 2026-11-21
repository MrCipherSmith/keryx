import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMemoryService } from "../memory/service";
import { createWorktree } from "./create";
import { createProjectFixture, everyPortFree, type ProjectFixture } from "./project-fixture";

let project: ProjectFixture;

beforeEach(async () => {
  project = await createProjectFixture();
});
afterEach(() => project.cleanup());

test("a memory entry committed on the branch is found after prepare, with no manual index step (AC6)", async () => {
  const created = await createWorktree({
    cwd: project.main,
    name: "wt-memory",
    base: "main",
    path: path.join(project.base, "wt-memory"),
    runInstall: project.runInstall,
    isPortFree: everyPortFree,
  });

  expect(created.prepare.indexes).toEqual([{ name: "memory", status: "built", entries: 1 }]);
  const indexFile = path.join(created.path, ".metaproject", "data", "memory", "index", "index.json");
  expect(existsSync(indexFile)).toBe(true);
  expect(JSON.parse(readFileSync(indexFile, "utf8")).entries.map((entry: { title: string }) => entry.title)).toEqual([project.committedMemoryTitle]);

  const found = await createMemoryService().search({ cwd: created.path, query: "readiness lesson" });
  expect(JSON.stringify(found.results)).toContain(project.committedMemoryTitle);
});

test("the index is built from the worktree's own files, not from the main checkout", async () => {
  // An uncommitted entry in the main checkout must not reach the worktree's index.
  await createMemoryService().create({ cwd: project.main, type: "lesson", slug: "main-only", title: "Main checkout only" });
  writeFileSync(path.join(project.main, ".metaproject", "memory", "lessons", "note.txt"), "not an entry\n");

  const created = await createWorktree({
    cwd: project.main,
    name: "wt-own",
    base: "main",
    path: path.join(project.base, "wt-own"),
    runInstall: project.runInstall,
    isPortFree: everyPortFree,
  });
  const indexFile = path.join(created.path, ".metaproject", "data", "memory", "index", "index.json");
  const titles = JSON.parse(readFileSync(indexFile, "utf8")).entries.map((entry: { title: string }) => entry.title);
  expect(titles).toEqual([project.committedMemoryTitle]);
  const found = await createMemoryService().search({ cwd: created.path, query: "Main checkout only" });
  expect(found.results.map((result) => result.entry.title)).not.toContain("Main checkout only");
});
