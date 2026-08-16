import { expect, test } from "bun:test";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { courseFromSlate, readCourse } from "./slate-course";
import type { Slate } from "./slate";

const stamp = "2026-08-16T00:00:00.000Z";

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-slate-course-"));
}

async function writeFlow(cwd: string, dirName: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "flows", dirName);
  await mkdir(dir, { recursive: true });
  const flow = {
    schemaVersion: 2,
    id: dirName.slice(0, 3),
    slug: dirName.slice(4),
    title: "Test flow",
    status: "in-progress",
    createdAt: stamp,
    updatedAt: stamp,
    source: { type: "description", ref: null },
    acChecksum: null,
    acConfirmed: {},
    pr: { url: null },
    tasks: [
      { id: "T1", title: "First", kind: "context", status: "done" },
      { id: "T2", title: "Second", kind: "implement", status: "todo" },
    ],
    history: [],
    ...overrides,
  };
  await writeFile(path.join(dir, "flow.json"), JSON.stringify(flow), "utf8");
}

test("readCourse returns unbound when flowRef is undefined, without touching the filesystem", async () => {
  const cwd = await tempCwd();
  const course = await readCourse(cwd, undefined);
  expect(course).toEqual({ state: "unbound" });
});

test("readCourse resolves a valid flowRef into a live projection with completed/next/blocked derived from the flow's tasks", async () => {
  const cwd = await tempCwd();
  await writeFlow(cwd, "001-example-flow");
  const course = await readCourse(cwd, "001");
  expect(course.state).toBe("bound");
  if (course.state !== "bound") return;
  expect(course.flowRef).toEqual({ uri: "001", snapshot: "in-progress", revision: stamp });
  expect(course.completed).toEqual(["T1"]);
  expect(course.next).toEqual(["T2"]);
  expect(course.blocked).toEqual([]);
});

test("readCourse marks blocked flows in the blocked array", async () => {
  const cwd = await tempCwd();
  await writeFlow(cwd, "002-blocked-flow", { status: "blocked" });
  const course = await readCourse(cwd, "002");
  expect(course.state).toBe("bound");
  if (course.state !== "bound") return;
  expect(course.blocked).toEqual(["002"]);
});

test("readCourse yields deterministic unbound for a flowRef that never existed, never a throw", async () => {
  const cwd = await tempCwd();
  await expect(readCourse(cwd, "999")).resolves.toEqual({ state: "unbound" });
});

test("readCourse yields deterministic unbound for a flow deleted after the ref was captured, never a throw", async () => {
  const cwd = await tempCwd();
  await writeFlow(cwd, "003-deleted-flow");
  await unlink(path.join(cwd, ".metaproject", "flows", "003-deleted-flow", "flow.json"));
  await expect(readCourse(cwd, "003")).resolves.toEqual({ state: "unbound" });
});

test("readCourse yields deterministic unbound for malformed flow.json, never a throw", async () => {
  const cwd = await tempCwd();
  const dir = path.join(cwd, ".metaproject", "flows", "004-malformed-flow");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "flow.json"), "{ this is not valid json", "utf8");
  await expect(readCourse(cwd, "004")).resolves.toEqual({ state: "unbound" });
});

test.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
  "readCourse yields deterministic unbound for a permission-denied flow.json, never a throw",
  async () => {
    const cwd = await tempCwd();
    await writeFlow(cwd, "005-locked-flow");
    const flowPath = path.join(cwd, ".metaproject", "flows", "005-locked-flow", "flow.json");
    await Bun.$`chmod 000 ${flowPath}`.quiet();
    try {
      await expect(readCourse(cwd, "005")).resolves.toEqual({ state: "unbound" });
    } finally {
      await Bun.$`chmod 644 ${flowPath}`.quiet();
    }
  },
);

test("readCourse never caches: a second call after the flow file changes reflects the new state", async () => {
  const cwd = await tempCwd();
  await writeFlow(cwd, "006-live-flow");
  const first = await readCourse(cwd, "006");
  expect(first.state).toBe("bound");
  if (first.state !== "bound") return;
  expect(first.completed).toEqual(["T1"]);

  await writeFlow(cwd, "006-live-flow", {
    tasks: [
      { id: "T1", title: "First", kind: "context", status: "done" },
      { id: "T2", title: "Second", kind: "implement", status: "done" },
    ],
  });
  const second = await readCourse(cwd, "006");
  expect(second.state).toBe("bound");
  if (second.state !== "bound") return;
  expect(second.completed).toEqual(["T1", "T2"]);
  expect(second.next).toEqual([]);
});

test("courseFromSlate reads course.flowRef off the given Slate and delegates to readCourse", async () => {
  const cwd = await tempCwd();
  await writeFlow(cwd, "007-slate-bound-flow");
  const slate: Slate = { anchors: { root: cwd, touched: [] }, course: { flowRef: "007" }, seeds: [] };
  const course = await courseFromSlate(cwd, slate);
  expect(course.state).toBe("bound");
});

test("courseFromSlate returns unbound when the Slate has no course.flowRef set", async () => {
  const cwd = await tempCwd();
  const slate: Slate = { anchors: { root: cwd, touched: [] }, course: {}, seeds: [] };
  await expect(courseFromSlate(cwd, slate)).resolves.toEqual({ state: "unbound" });
});

test("courseFromSlate returns unbound when the Slate itself is undefined", async () => {
  const cwd = await tempCwd();
  await expect(courseFromSlate(cwd, undefined)).resolves.toEqual({ state: "unbound" });
});
