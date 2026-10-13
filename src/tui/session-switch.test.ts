import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLeasedSession, switchPreservedSession } from "../session/lease";
import { createTuiLeaseHolder } from "./tui-session-lease";
import { SessionSwitchOwner, assertSessionSwitchActive } from "./session-switch";
const roots: string[] = [];
const leases: Array<{ release(): void }> = [];
afterEach(() => { for (const lease of leases.splice(0)) lease.release(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "tui-switch-")); roots.push(root);
  const cwd = path.join(root, "project"); mkdirSync(cwd);
  const dataDir = path.join(root, "data");
  const open = () => { const value = openLeasedSession({ cwd, dataDir }); leases.push(value.lease); return value; };
  const first = open(); const holder = createTuiLeaseHolder(); holder.hold(first.lease);
  return { open, first, holder };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
test("shutdown waits for delayed outgoing preservation, retains outgoing lease and rejects queued switches", async () => {
  const { open, first, holder } = setup(); const owner = new SessionSwitchOwner();
  const started = deferred(); const finish = deferred(); let target: ReturnType<typeof open> | undefined; let adopted = false; let queued = false;
  const switching = owner.run(async signal => {
    try {
      const next = await switchPreservedSession(holder.current, () => { target = open(); return target; }, async () => {
        started.resolve(); await finish.promise; assertSessionSwitchActive(signal, holder.canPersist());
      });
      holder.hold(next.lease); adopted = true;
    } catch (error) { expect(signal.aborted).toBe(true); expect(error).toBeDefined(); }
  });
  await started.promise;
  const queue = owner.run(async () => { queued = true; });
  let stopped = false; const stopping = owner.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false); expect(first.lease.released).toBe(false);
  finish.resolve(); await Promise.all([switching, queue, stopping]);
  expect(adopted).toBe(false); expect(queued).toBe(false); expect(target?.lease.released).toBe(true);
  expect(holder.current).toBe(first.lease); expect(first.lease.released).toBe(false);
  holder.release();
});
test("pending picker is cancelled on shutdown; late result cannot open or focus", async () => {
  const owner = new SessionSwitchOwner(); const started = deferred(); let pick!: (id?: string) => void;
  let opened = false; let focused = false;
  const switching = owner.run(async signal => {
    const id = await new Promise<string | undefined>(resolve => {
      pick = resolve; signal.addEventListener("abort", () => resolve(undefined), { once: true }); started.resolve();
    });
    if (signal.aborted || id === undefined) return;
    focused = true; opened = true;
  });
  await started.promise; await owner.stop(); pick("late-target"); await switching;
  expect(opened).toBe(false); expect(focused).toBe(false);
});
test("successful resume preserves outgoing before release and adoption", async () => {
  const { open, first, holder } = setup(); const owner = new SessionSwitchOwner(); const events: string[] = [];
  await owner.run(async signal => {
    const next = await switchPreservedSession(holder.current, open, async () => {
      expect(first.lease.released).toBe(false); events.push("checkpoint", "slate"); assertSessionSwitchActive(signal, holder.canPersist());
    });
    expect(first.lease.released).toBe(true); events.push("release"); holder.hold(next.lease); events.push("adopt");
  });
  expect(events).toEqual(["checkpoint", "slate", "release", "adopt"]); holder.release();
});
test("failed outgoing preservation retains outgoing and releases target", async () => {
  const { open, first, holder } = setup(); let target: ReturnType<typeof open> | undefined;
  await expect(switchPreservedSession(holder.current, () => { target = open(); return target; }, async () => { throw new Error("disk failed"); })).rejects.toThrow("disk failed");
  expect(holder.current).toBe(first.lease); expect(first.lease.released).toBe(false); expect(target?.lease.released).toBe(true); holder.release();
});
test("lost ownership is refused before opening any target", async () => {
  const owner = new SessionSwitchOwner(); let opened = false;
  await expect(owner.run(async signal => { assertSessionSwitchActive(signal, false); opened = true; })).rejects.toThrow("ownership lost");
  expect(opened).toBe(false);
});
