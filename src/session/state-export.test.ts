import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildStateSnapshot, startStateExport, type StateExportSession } from "./state-export";
import { startShellStateExports } from "./shell-state-exports";
import { setExecutionPlan } from "./execution-plan";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "state-export-")); roots.push(root);
  const cwd = path.join(root, "project"), dir = path.join(root, "session");
  await mkdir(cwd); await mkdir(dir);
  const session: StateExportSession = { cwd, dir, sessionId: "session-a", messages: [{ role: "user", content: "Current goal" }] };
  return { root, session, file: path.join(root, "consumer", "state.json") };
}
test("neutral schema preserves canonical request and plan without Herdr identity", async () => {
  const f = await fixture();
  await setExecutionPlan(f.session.dir, { expectedRevision: 0, items: [{ id: "a", title: "Work", status: "pending" }] });
  const s = await buildStateSnapshot(f.session);
  expect(s.version).toBe(1); expect(s.sessionId).toBe("session-a");
  expect(s.request?.current).toBe("Current goal"); expect(s.plan?.revision).toBe(1);
  expect(s).not.toHaveProperty("terminalId");
});
test("generic publication: private snapshots, heartbeat, switch, unbind and stop", async () => {
  const f = await fixture(); let current: StateExportSession | undefined = f.session;
  const b = startStateExport({ file: f.file, getSession: () => current, intervalMs: 60000 });
  try {
    expect(await b.refresh()).toEqual({ ok: true });
    const first = JSON.parse(await readFile(f.file, "utf8"));
    expect(first.sessionId).toBe("session-a"); expect(first.ownerId).toBeString();
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    await Bun.sleep(15); await b.refresh();
    const second = JSON.parse(await readFile(f.file, "utf8"));
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
    expect(second.ownerId).toBe(first.ownerId);
    current = { ...f.session, sessionId: "session-b" }; await b.refresh();
    expect(JSON.parse(await readFile(f.file, "utf8")).sessionId).toBe("session-b");
    current = undefined; await b.refresh(); expect(await Bun.file(f.file).exists()).toBe(false);
  } finally { await b.stop(); }
  await b.refresh(); expect(await Bun.file(f.file).exists()).toBe(false);
});
test("older publisher cannot delete replacement; size errors are observable and recoverable", async () => {
  const f = await fixture(), errors: string[] = [];
  const old = startStateExport({ file: f.file, getSession: () => f.session, intervalMs: 60000 });
  const newer = startStateExport({ file: f.file, getSession: () => f.session, intervalMs: 60000 });
  try { await old.refresh(); await newer.refresh(); await old.stop(); expect(await Bun.file(f.file).exists()).toBe(true); }
  finally { await old.stop(); await newer.stop(); }
  let current: StateExportSession = { ...f.session, messages: [{ role: "user", content: "x".repeat(2000) }] };
  const bounded = startStateExport({ file: f.file, getSession: () => current, maxBytes: 1000, onError: e => errors.push(e), intervalMs: 60000 });
  try {
    expect((await bounded.refresh()).ok).toBe(false); expect(errors.length).toBeGreaterThan(0);
    expect(await Bun.file(f.file).exists()).toBe(false);
    current = f.session; expect(await bounded.refresh()).toEqual({ ok: true });
  } finally { await bounded.stop(); }
});
test("broken Herdr destination does not block neutral consumer", async () => {
  const f = await fixture(), blocked = path.join(f.root, "blocked"), errors: string[] = [];
  await writeFile(blocked, "not a directory");
  const b = startShellStateExports({ env: { KERYX_STATE_EXPORT_FILE: f.file, HC_TERMINAL_ID: "t2", HERDR_APP_HOME: blocked }, getSession: () => f.session, intervalMs: 60000, onError: e => errors.push(e) });
  try {
    expect((await b.refresh()).ok).toBe(false);
    expect(JSON.parse(await readFile(f.file, "utf8")).sessionId).toBe("session-a"); expect(errors.length).toBeGreaterThan(0);
  } finally { await b.stop(); }
});
test("Shell opt-in works outside Herdr and both consumers preserve compatible data", async () => {
  const f = await fixture();
  const plain = startShellStateExports({ env: { KERYX_STATE_EXPORT_FILE: f.file }, getSession: () => f.session, intervalMs: 60000 });
  try { await plain.refresh(); expect(JSON.parse(await readFile(f.file, "utf8"))).not.toHaveProperty("terminalId"); }
  finally { await plain.stop(); }
  const both = startShellStateExports({ env: { KERYX_STATE_EXPORT_FILE: f.file, HC_TERMINAL_ID: "t2", HERDR_APP_HOME: f.root }, getSession: () => f.session, intervalMs: 60000 });
  try {
    expect(await both.refresh()).toEqual({ ok: true });
    const neutral = JSON.parse(await readFile(f.file, "utf8"));
    const herdr = JSON.parse(await readFile(path.join(f.root, "data/keryx-cockpit/t2.json"), "utf8"));
    expect(herdr.terminalId).toBe("t2"); expect(herdr.version).toBe(neutral.version);
    for (const key of ["sessionId", "projectPath", "request", "plan", "flows", "scope", "issues"]) expect(herdr[key]).toEqual(neutral[key]);
  } finally { await both.stop(); }
});
test("no implicit export; invalid relative path reports error without reading session", async () => {
  let reads = 0;
  const disabled = startShellStateExports({ env: {}, getSession: () => { reads++; return undefined; } });
  await disabled.refresh(); await disabled.stop(); expect(reads).toBe(0);
  const errors: string[] = [];
  const bad = startShellStateExports({ env: { KERYX_STATE_EXPORT_FILE: "relative.json" }, getSession: () => { reads++; return undefined; }, onError: e => errors.push(e) });
  try { expect((await bad.refresh()).ok).toBe(false); expect(errors.length).toBeGreaterThan(0); expect(reads).toBe(0); }
  finally { await bad.stop(); }
});
