test("publishes initiating and current operator requests, excluding injected messages", async () => {
  const f = await fixture();
  const s = await buildCockpitSnapshot({ ...f, messages: [
    { role: "user", content: "Original goal" },
    { role: "assistant", content: "Working" },
    { role: "user", content: "Current request" },
    { role: "user", content: "Internal", injected: true },
  ] }, "t2");
  expect(s.request).toEqual({ initial: "Original goal", current: "Current request" });
  expect((await buildCockpitSnapshot(f, "t2")).request).toBeNull();
});
test("request text is bounded for the mod read limit", async () => {
  const f = await fixture();
  const s = await buildCockpitSnapshot({ ...f, messages: [{ role: "user", content: "x".repeat(20000) }] }, "t2");
  expect(s.request?.current.length).toBeLessThanOrEqual(8001);
});
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCockpitSnapshot, startCockpitBridge } from "./cockpit-bridge";
import { setExecutionPlan } from "./execution-plan";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cockpit-")); roots.push(root);
  const cwd = path.join(root, "project"), dir = path.join(root, "session-a");
  await mkdir(cwd, { recursive: true }); await mkdir(dir);
  const flowDir = path.join(cwd, ".metaproject/flows/001-demo"); await mkdir(flowDir, { recursive: true });
  const file = path.join(flowDir, "flow.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 2, id: "001", title: "Real task", status: "active", tasks: [{ id: "T1", title: "First", status: "todo" }] }));
  return { root, cwd, dir, sessionId: "session-a", file };
}
test("reads real project flows and modal plan without source mutations", async () => {
  const f = await fixture();
  await setExecutionPlan(f.dir, { expectedRevision: 0, items: [{ id: "s", title: "Live plan", status: "proposed" }] });
  const before = await readFile(f.file, "utf8"), s = await buildCockpitSnapshot(f, "t2");
  expect(s.projectPath).toBe(f.cwd); expect(s.sessionId).toBe("session-a");
  expect(s.flows[0]?.title).toBe("Real task"); expect(s.scope).toBe("project");
  expect(s.plan?.items[0]?.status).toBe("proposed"); expect(s.plan?.revision).toBe(1);
  expect(await readFile(f.file, "utf8")).toBe(before);
});
test("project publication excludes done flows but preserves an explicitly bound closed flow", async () => {
  const f = await fixture();
  const closed = JSON.parse(await readFile(f.file, "utf8"));
  closed.status = "done";
  await writeFile(f.file, JSON.stringify(closed));
  const openDir = path.join(f.cwd, ".metaproject/flows/002-open");
  await mkdir(openDir);
  await writeFile(path.join(openDir, "flow.json"), JSON.stringify({ ...closed, id: "002", status: "implemented" }));
  const project = await buildCockpitSnapshot(f, "t2");
  expect(project.flows.map(f => f.id)).toEqual(["002"]);
  await writeFile(path.join(f.dir, "slate.json"), JSON.stringify({ course: { flowRef: "001" } }));
  const bound = await buildCockpitSnapshot(f, "t2");
  expect(bound.scope).toBe("session");
  expect(bound.flows.map(f => f.id)).toEqual(["001"]);
});
test("explicit session binding narrows scope; broken binding never falls back", async () => {
  const f = await fixture();
  await writeFile(path.join(f.dir, "slate.json"), JSON.stringify({ course: { flowRef: "001" } }));
  expect((await buildCockpitSnapshot(f, "t2")).scope).toBe("session");
  await writeFile(path.join(f.dir, "slate.json"), JSON.stringify({ course: { flowRef: "999" } }));
  const s = await buildCockpitSnapshot(f, "t2"); expect(s.flows).toEqual([]); expect(s.issues.length).toBeGreaterThan(0);
});
test("corruption is explicit, absent plan is not a demo", async () => {
  const f = await fixture(); await writeFile(f.file, "broken");
  const s = await buildCockpitSnapshot(f, "t2"); expect(s.plan).toBeNull(); expect(s.issues.length).toBeGreaterThan(0);
});
test("publisher follows session switches and removes unbound and stopped snapshots", async () => {
  const f = await fixture(); let current: typeof f | undefined = f;
  const b = startCockpitBridge({ env: { HC_TERMINAL_ID: "t2", HERDR_APP_HOME: f.root }, getSession: () => current, intervalMs: 60000, onError: () => {} });
  const file = path.join(f.root, "data/keryx-cockpit/t2.json");
  try {
    expect(await b.refresh()).toEqual({ ok: true }); expect(JSON.parse(await readFile(file, "utf8")).sessionId).toBe("session-a");
    current = { ...f, sessionId: "session-b" }; await b.refresh(); expect(JSON.parse(await readFile(file, "utf8")).sessionId).toBe("session-b");
    current = undefined; await b.refresh(); expect(await Bun.file(file).exists()).toBe(false);
  } finally { await b.stop(); }
  expect(await Bun.file(file).exists()).toBe(false);
});

test("disabled outside Herdr; unsafe terminal IDs never touch the filesystem", async () => {
  const f = await fixture();
  for (const id of [undefined, "../escape", "remote:t2"]) {
    const b = startCockpitBridge({ env: { HC_TERMINAL_ID: id, HERDR_APP_HOME: f.root }, getSession: () => { throw new Error("must not read session"); } });
    expect(await b.refresh()).toEqual({ ok: true });
    await b.stop();
  }
  expect(await Bun.file(path.join(f.root, "data/keryx-cockpit/t2.json")).exists()).toBe(false);
});

test("snapshots are private, terminal-isolated, and old owners cannot remove a newer snapshot", async () => {
  const f = await fixture();
  const make = (id: string) => startCockpitBridge({ env: { HC_TERMINAL_ID: id, HERDR_APP_HOME: f.root }, getSession: () => f, intervalMs: 60000 });
  const a = make("t2"), other = make("t3");
  let replacement: ReturnType<typeof make> | undefined;
  const file = path.join(f.root, "data/keryx-cockpit/t2.json");
  try {
    await a.refresh(); await other.refresh();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    replacement = make("t2"); await replacement.refresh();
    await a.stop();
    expect(await Bun.file(file).exists()).toBe(true);
    expect(JSON.parse(await readFile(path.join(f.root, "data/keryx-cockpit/t3.json"), "utf8")).terminalId).toBe("t3");
  } finally { await a.stop(); await other.stop(); await replacement?.stop(); }
  expect(await Bun.file(file).exists()).toBe(false);
});

test("publication failures are observable and a subsequent refresh can recover", async () => {
  const f = await fixture(), errors: string[] = [];
  const blocked = path.join(f.root, "blocked"); await writeFile(blocked, "not a directory");
  const b = startCockpitBridge({ env: { HC_TERMINAL_ID: "t2", HERDR_APP_HOME: blocked }, getSession: () => f, intervalMs: 60000, onError: e => errors.push(e) });
  try {
    expect((await b.refresh()).ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    await rm(blocked); await mkdir(blocked);
    expect((await b.refresh()).ok).toBe(true);
  } finally { await b.stop(); }
});

test("stop wins over queued refreshes and cannot republish afterwards", async () => {
  const f = await fixture();
  const b = startCockpitBridge({ env: { HC_TERMINAL_ID: "t2", HERDR_APP_HOME: f.root }, getSession: () => f });
  await Promise.all([b.refresh(), b.stop(), b.refresh()]);
  expect(await Bun.file(path.join(f.root, "data/keryx-cockpit/t2.json")).exists()).toBe(false);
});

test("task details use documents, linked criteria and recorded results", async () => {
  const f = await fixture(), dir = path.dirname(f.file);
  const flow = JSON.parse(await readFile(f.file, "utf8"));
  Object.assign(flow.tasks[0], { acRefs: ["AC2"], dispositionReason: "Delivered regression", evidenceRefs: ["evidence/run.txt"] });
  await writeFile(f.file, JSON.stringify(flow));
  await writeFile(path.join(dir, "tasks.md"), "# Tasks\n## T1: First\nSpecific description\n## T10: Other\nDo not include\n");
  await writeFile(path.join(dir, "acceptance-criteria.md"), "- AC1: unrelated\n- AC2: expected behavior\n  with continuation\n");
  await mkdir(path.join(dir, "results"));
  await writeFile(path.join(dir, "results/T1.json"), JSON.stringify({ test_result: "12 passed", notes: "Recorded note" }));
  const task = (await buildCockpitSnapshot(f, "t2")).flows[0]!.tasks[0]!;
  expect(task.description).toBe("Specific description");
  expect(task.criteriaScope).toBe("task");
  expect(task.criteria).toContain("AC2: expected behavior\n  with continuation");
  expect(task.criteria).not.toContain("unrelated");
  expect(task.results).toContain("Delivered regression");
  expect(task.results).toContain("12 passed");
  expect(task.results).toContain("evidence/run.txt");
});
test("malformed results do not hide tasks", async () => {
  const f = await fixture(), dir = path.dirname(f.file);
  await mkdir(path.join(dir, "results"));
  await writeFile(path.join(dir, "results/T1.json"), "broken");
  const s = await buildCockpitSnapshot(f, "t2");
  expect(s.flows[0]!.tasks[0]!.description).toBeNull();
  expect(s.issues.some(s => s.includes("T1.json"))).toBe(true);
});
