import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_CONFIG_FILE_BYTES } from "../lib/config-dir";
import { withFileLock } from "../lib/fs";
import { queuePreservedWrapUp } from "../session/preservation";
import { replayPreservation, replayPreservationOutbox, replayProjectPreservationOutboxes } from "./preservation-replay";
import { localWorkspaceAuthorizationServer, WorkspaceService } from "./workspace-service";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(bound = true) {
  const cwd = await mkdtemp(path.join(tmpdir(), "replay-workspace-"));
  const dir = await mkdtemp(path.join(tmpdir(), "replay-session-"));
  dirs.push(cwd, dir);
  const service = new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } });
  await service.create({ request: undefined, requestCorrelationId: "preservation-test-create", id: "workspace-a", title: "Preservation" });
  const receipt = queuePreservedWrapUp(dir, JSON.stringify({ ...(bound ? { workspaceId: "workspace-a" } : {}), seeds: [], notes: { finding: { text: "durable finding" } } }));
  return { cwd, dir, snapshot: receipt.snapshot };
}
test("crash after creation replays without duplicates or acceptance", async () => {
  const input = await fixture();
  await expect(replayPreservation({ ...input, afterCreate: () => { throw new Error("simulated crash"); } })).rejects.toThrow("simulated crash");
  expect(await replayPreservation(input)).toBe("proposed");
  expect(await replayPreservation(input)).toBe("already-delivered");
  expect(await replayPreservationOutbox(input)).toEqual({ proposed: 0, deferred: 0, unbound: 0 });
  const proposals = path.join(input.cwd, ".metaproject", "workspaces", "workspace-a", "proposals");
  const files = (await readdir(proposals)).filter(name => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(proposals, files[0]!), "utf8")).status).toBe("proposed");
  expect(JSON.parse(await readFile(path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivered`), "utf8")).snapshot).toBe(input.snapshot);
});
test("fresh ACL denial retains outbox even after earlier delivery", async () => {
  const input = await fixture();
  await replayPreservation(input);
  const file = path.join(input.cwd, ".metaproject", "workspaces", "workspace-a", "workspace.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.members = [{ subject: "user:other-owner", role: "owner" }];
  await writeFile(file, JSON.stringify(manifest));
  await expect(replayPreservation(input)).rejects.toThrow();
  expect(await replayPreservationOutbox(input)).toEqual({ proposed: 0, deferred: 1, unbound: 0 });
  expect(await readFile(path.join(input.dir, "preservation", "outbox", `${input.snapshot}.json`), "utf8")).toContain("pending-review");
});
for (const denial of ["membership", "archived"] as const) {
  test(`first replay denied by ${denial} publishes no workspace evidence`, async () => {
    const input = await fixture();
    const workspace = path.join(input.cwd, ".metaproject", "workspaces", "workspace-a");
    const file = path.join(workspace, "workspace.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (denial === "membership") manifest.members = [{ subject: "user:other-owner", role: "owner" }];
    else manifest.status = "archived";
    await writeFile(file, JSON.stringify(manifest));
    expect(await replayPreservationOutbox(input)).toEqual({ proposed: 0, deferred: 1, unbound: 0 });
    await expect(readdir(path.join(workspace, "preserved-evidence"))).rejects.toThrow();
    await expect(readdir(path.join(workspace, "proposals"))).rejects.toThrow();
    await expect(readFile(path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivered`))).rejects.toThrow();
    expect(await readFile(path.join(input.dir, "preservation", "outbox", `${input.snapshot}.json`), "utf8")).toContain("pending-review");
  });
}

test("unbound evidence stays local without implicitly choosing workspace", async () => {
  const input = await fixture(false);
  expect(await replayPreservationOutbox(input)).toEqual({ proposed: 0, deferred: 0, unbound: 1 });
});
test("corrupt generation is deferred, not delivered", async () => {
  const input = await fixture();
  await writeFile(path.join(input.dir, "preservation", "generations", `${input.snapshot}.json`), "{}");
  expect(await replayPreservationOutbox(input)).toEqual({ proposed: 0, deferred: 1, unbound: 0 });
  await expect(readFile(path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivered`))).rejects.toThrow();
});

test("new session recovers previous project outboxes without following symlinks", async () => {
  const input = await fixture();
  const outside = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), "project-replay-"));
  dirs.push(root);
  const previous = path.join(root, "previous");
  const current = path.join(root, "current");
  await rename(input.dir, previous);
  await mkdir(current);
  await symlink(outside.dir, path.join(root, "foreign-session"), "dir");
  expect(await replayProjectPreservationOutboxes({ cwd: input.cwd, dir: current })).toEqual({ proposed: 1, deferred: 0, unbound: 0 });
  expect(await replayProjectPreservationOutboxes({ cwd: input.cwd, dir: current })).toEqual({ proposed: 0, deferred: 0, unbound: 0 });
  const proposals = await readdir(path.join(input.cwd, ".metaproject", "workspaces", "workspace-a", "proposals"));
  expect(proposals.filter(name => name.endsWith(".json"))).toHaveLength(1);
  expect(await readdir(path.join(outside.dir, "preservation", "outbox"))).toEqual([`${outside.snapshot}.json`]);
});

test("corrupt delivery marker is deferred after proposal validation", async () => {
  const input = await fixture();
  await replayPreservation(input);
  await writeFile(path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivered`), "{}");
  expect(await replayPreservationOutbox(input)).toEqual({ proposed: 0, deferred: 1, unbound: 0 });
});


test("abort after proposal creation leaves marker pending and retry is idempotent", async () => {
  const input = await fixture();
  const controller = new AbortController();
  await expect(replayPreservation({ ...input, signal: controller.signal, afterCreate: () => controller.abort() })).rejects.toThrow();
  await expect(readFile(path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivered`))).rejects.toThrow();
  expect(await replayPreservation(input)).toBe("proposed");
  const proposals = await readdir(path.join(input.cwd, ".metaproject", "workspaces", "workspace-a", "proposals"));
  expect(proposals.filter(name => name.endsWith(".json"))).toHaveLength(1);
});

test("already aborted replay commits neither evidence nor proposal", async () => {
  const input = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(replayPreservation({ ...input, signal: controller.signal })).rejects.toThrow();
  await expect(readdir(path.join(input.cwd, ".metaproject", "workspaces", "workspace-a", "preserved-evidence"))).rejects.toThrow();
});

test("expired startup budget leaves recoverable pending intent", async () => {
  const input = await fixture();
  const result = await replayProjectPreservationOutboxes({ ...input, deadline: Date.now() - 1 });
  expect(result.proposed).toBe(0);
  await expect(readFile(path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivered`))).rejects.toThrow();
  expect(await replayPreservation(input)).toBe("proposed");
});


test("cancelled replay waiting for delivery lock never starts delivery after unlock", async () => {
  const input = await fixture();
  const lock = path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivery.lock`);
  let unlock!: () => void;
  let held!: () => void;
  const acquired = new Promise<void>(resolve => { held = resolve; });
  const holder = withFileLock(lock, async () => { held(); await new Promise<void>(resolve => { unlock = resolve; }); });
  await acquired;
  const controller = new AbortController();
  const replay = replayPreservation({ ...input, signal: controller.signal });
  const rejected = replay.then(() => undefined, error => error as unknown);
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  try {
    expect(await rejected).toBeInstanceOf(Error);
    expect(await readdir(path.join(input.dir, "preservation", "outbox"))).toContain(`${input.snapshot}.delivery.lock`);
  } finally { unlock(); await holder; }
  await expect(readdir(path.join(input.cwd, ".metaproject", "workspaces", "workspace-a", "preserved-evidence"))).rejects.toThrow();
  expect(await readdir(path.join(input.dir, "preservation", "outbox"))).toEqual([`${input.snapshot}.json`]);
  expect(await replayPreservation(input)).toBe("proposed");
});

for (const boundary of ["workspace", "proposal"] as const) {
  test(`cancelled replay at ${boundary} lock cannot commit after unlock`, async () => {
    const input = await fixture();
    const storage = path.join(input.cwd, ".metaproject", "workspaces");
    const proposals = path.join(storage, "workspace-a", "proposals");
    await mkdir(proposals, { recursive: true });
    const workspaceLock = path.join(storage, ".workspace-a.lock");
    const lock = boundary === "workspace" ? workspaceLock
      : path.join(proposals, `p-${input.snapshot.slice(0, 62)}.json.lock`);
    let unlock!: () => void;
    let held!: () => void;
    const acquired = new Promise<void>(resolve => { held = resolve; });
    const holder = withFileLock(lock, async () => {
      held(); await new Promise<void>(resolve => { unlock = resolve; });
    });
    await acquired;
    const controller = new AbortController();
    const replay = replayPreservation({ ...input, signal: controller.signal });
    const rejected = replay.then(() => undefined, error => error as unknown);
    try {
      // Workspace contention precedes evidence publication. For proposal
      // contention, also observe that replay holds the outer workspace lock.
      const deadline = Date.now() + 2000;
      let reached = false;
      while (Date.now() < deadline) {
        try {
          if (boundary === "workspace") {
            await readdir(path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivery.lock`));
          } else {
            await readdir(path.join(storage, "workspace-a", "preserved-evidence", input.snapshot));
          }
          if (boundary === "proposal") await readdir(workspaceLock);
          reached = true; break;
        } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
      }
      expect(reached).toBe(true);
      controller.abort();
      expect(await rejected).toBeInstanceOf(Error);
    } finally { controller.abort(); unlock(); await holder; await rejected; }
    expect((await readdir(proposals)).filter(name => name.endsWith(".json"))).toEqual([]);
    await expect(readFile(path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivered`))).rejects.toThrow();
    expect(await replayPreservation(input)).toBe("proposed");
    expect((await readdir(proposals)).filter(name => name.endsWith(".json"))).toHaveLength(1);
  });
}

test("maxItems=1 advances beyond delivered receipts", async () => {
  const input = await fixture();
  const other = queuePreservedWrapUp(input.dir, JSON.stringify({ workspaceId: "workspace-a", seeds: [], notes: { finding: { text: "second finding" } } }));
  const [first, second] = [input.snapshot, other.snapshot].sort();
  await replayPreservation({ ...input, snapshot: first! });
  expect(await replayPreservationOutbox({ ...input, maxItems: 1 })).toEqual({ proposed: 1, deferred: 0, unbound: 0 });
  expect(await replayPreservation({ ...input, snapshot: second! })).toBe("already-delivered");
});
test("bounded retry advances past corrupt evidence", async () => {
  const input = await fixture();
  const other = queuePreservedWrapUp(input.dir, JSON.stringify({ workspaceId: "workspace-a", seeds: [], notes: { finding: { text: "second finding" } } }));
  const [first, second] = [input.snapshot, other.snapshot].sort();
  await writeFile(path.join(input.dir, "preservation", "generations", `${first}.json`), "{}");
  expect(await replayPreservationOutbox({ ...input, maxItems: 1 })).toEqual({ proposed: 0, deferred: 1, unbound: 0 });
  expect(await replayPreservationOutbox({ ...input, maxItems: 1 })).toEqual({ proposed: 1, deferred: 0, unbound: 0 });
  expect(await replayPreservation({ ...input, snapshot: second! })).toBe("already-delivered");
});
test("project cursor reaches beyond the 32-directory startup bound", async () => {
  const input = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), "fair-project-replay-")); dirs.push(root);
  for (let n = 0; n < 33; n++) await mkdir(path.join(root, `a-${n.toString().padStart(2, "0")}`));
  const previous = path.join(root, "z-previous"); await rename(input.dir, previous);
  const current = path.join(root, "a-00");
  expect((await replayProjectPreservationOutboxes({ cwd: input.cwd, dir: current })).proposed).toBe(0);
  expect((await replayProjectPreservationOutboxes({ cwd: input.cwd, dir: current })).proposed).toBe(1);
  expect(await replayPreservation({ ...input, dir: previous })).toBe("already-delivered");
});

test("unusable project and session cursors cannot prevent evidence recovery", async () => {
  const input = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), "unusable-replay-cursor-")); dirs.push(root);
  const dir = path.join(root, "session"); await rename(input.dir, dir);
  await mkdir(path.join(root, ".preservation-replay-cursor"));
  await mkdir(path.join(dir, "preservation", "outbox", "SCAN_CURSOR"));
  expect((await replayProjectPreservationOutboxes({ cwd: input.cwd, dir })).proposed).toBe(1);
  expect(await replayPreservation({ ...input, dir })).toBe("already-delivered");
});


test("oversized delivery marker stays deferred and is never overwritten", async () => {
  const input = await fixture();
  await replayPreservation(input);
  const marker = path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivered`);
  const oversized = "x".repeat(MAX_CONFIG_FILE_BYTES + 1);
  await writeFile(marker, oversized);
  expect(await replayPreservationOutbox(input)).toEqual({ proposed: 0, deferred: 1, unbound: 0 });
  expect(await readFile(marker, "utf8")).toBe(oversized);
});

test("nonregular delivery marker stays deferred without blocking replay", async () => {
  const input = await fixture();
  await replayPreservation(input);
  const marker = path.join(input.dir, "preservation", "outbox", `${input.snapshot}.delivered`);
  await rm(marker);
  await mkdir(marker);
  expect(await replayPreservationOutbox(input)).toEqual({ proposed: 0, deferred: 1, unbound: 0 });
  expect(await readdir(marker)).toEqual([]);
});
