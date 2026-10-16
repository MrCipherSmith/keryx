import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEvidenceStorage } from "./storage";
import { createEvidenceLifecycle } from "./lifecycle";

test("crashed foreign reader releases its pin; interrupted clear recovers without resurrecting generations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-process-"));
  const store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    store.withWriter(() => {
      store.writeAtomic("CURRENT", Buffer.from("old-pointer"));
      store.writeAtomic(`gen-${"a".repeat(64)}.json`, Buffer.from("old-excerpts"));
    });
    const storageModule = path.resolve(import.meta.dir, "storage.ts");
    const lifecycleModule = path.resolve(import.meta.dir, "lifecycle.ts");
    child = Bun.spawn([process.execPath, "-e", `
      import { openEvidenceStorage } from ${JSON.stringify(storageModule)};
      import { createEvidenceLifecycle } from ${JSON.stringify(lifecycleModule)};
      const store = openEvidenceStorage(${JSON.stringify(root)});
      const lifecycle = createEvidenceLifecycle(store);
      lifecycle.beginReader({ kind: "session-archive", id: "foreign" });
      console.log("PINNED");
      setInterval(() => {}, 1000);
    `], { stdout: "pipe", stderr: "pipe" });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("PINNED");
    await expect(lifecycle.clearDerived(100)).rejects.toThrow("timed out");
    expect(store.read("CURRENT", 4096)).toBeUndefined();
    expect(store.read(`gen-${"a".repeat(64)}.json`, 4096)).toBeDefined();
    expect(() => lifecycle.beginReader({ kind: "session-archive", id: "new" })).toThrow();
    child.kill("SIGKILL"); await child.exited;
    const reopenedStore = openEvidenceStorage(root), reopened = createEvidenceLifecycle(reopenedStore);
    try {
      await reopened.clearDerived();
      expect(reopenedStore.read(`gen-${"a".repeat(64)}.json`, 4096)).toBeUndefined();
      const fresh = reopened.beginReader({ kind: "session-archive", id: "new" }); fresh.close();
    } finally { reopened.close(); reopenedStore.close(); }
  } finally {
    if (child) { child.kill(); await child.exited; }
    lifecycle.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
}, 30000);
