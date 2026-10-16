import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEvidenceStorage } from "./storage";
import { createEvidenceLifecycle } from "./lifecycle";

const source = { kind: "session-archive" as const, id: "session-1" };

test("a writer lease held by another process refuses revoke and clear without poisoning readers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-writer-process-"));
  const store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  const reader = lifecycle.beginReader(source);
  const release = path.join(root, "release-writer");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const storageModule = path.resolve(import.meta.dir, "storage.ts");
    child = Bun.spawn([process.execPath, "-e", `
      import { existsSync, writeSync } from "node:fs";
      import { openEvidenceStorage } from ${JSON.stringify(storageModule)};
      const store = openEvidenceStorage(${JSON.stringify(root)});
      store.withWriter(() => {
        writeSync(1, "HELD\\n");
        while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(5);
      });
      store.close();
    `], { stdout: "pipe", stderr: "pipe" });
    const stdout = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const ready = await stdout.read(); stdout.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("HELD");
    for (const action of [() => lifecycle.revokeAndDrain(source), () => lifecycle.clearDerived()]) {
      const before = store.read("ledger.json", 300000);
      await expect(action()).rejects.toThrow("evidence writer busy");
      expect(store.read("ledger.json", 300000)).toEqual(before);
      expect(reader.signal.aborted).toBe(false);
      expect(reader.deliver(() => "still eligible")).toBe("still eligible");
      const next = lifecycle.beginReader(source); next.close();
    }
    await writeFile(release, "");
    expect(await child.exited).toBe(0);
    reader.close();
    await lifecycle.revokeAndDrain(source);
    expect(() => lifecycle.beginReader(source)).toThrow();
  } finally {
    if (child) { child.kill(); await child.exited; }
    reader.close(); lifecycle.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
}, 30000);
