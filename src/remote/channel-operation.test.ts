import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelOperationFence } from "./channel-operation";
import { disconnectChannelRecord } from "./channel-record";

test("operation ownership and revision must still match", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "channel-operation-"));
  try {
    const fence = new ChannelOperationFence(dir);
    const opened = fence.begin(null);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(fence.begin(null).ok).toBe(false);
    expect(fence.check("another-operation", null).ok).toBe(false);
    expect(fence.check(opened.operationId, null).ok).toBe(true);
    expect((await disconnectChannelRecord(null, dir)).ok).toBe(true);
    expect(fence.check(opened.operationId, null).ok).toBe(false);
    expect(fence.finish("another-operation")).toBe(false);
    expect(fence.finish(opened.operationId)).toBe(true);
    expect(fence.begin(1).ok).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
