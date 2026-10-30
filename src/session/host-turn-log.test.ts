import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnObservationLog, utf8Bounded } from "./host-turn-log";

test("native progress retention is byte bounded, marks truncation once and preserves terminal evidence separately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-native-turn-log-"));
  try {
    const log = createTurnObservationLog(dir, "run/unsafe-path", 256);
    for (let i = 0; i < 20; i++) log.append({ kind: "progress", text: "😀".repeat(30) });
    log.append({ kind: "terminal", outcome: "unknown", reason: "owned-runtime-stop-unconfirmed" });
    const progress = await readFile(log.progressPath, "utf8");
    expect((await stat(log.progressPath)).size).toBeLessThanOrEqual(256);
    expect(progress.split("native-log-retention-truncated").length).toBe(2);
    expect(await readFile(log.evidencePath, "utf8")).toContain("owned-runtime-stop-unconfirmed");
    expect(log.progressPath.startsWith(`${dir}/`)).toBe(true);
    expect(Buffer.byteLength(utf8Bounded("😀".repeat(10), 7))).toBeLessThanOrEqual(7);
    expect(utf8Bounded("😀".repeat(10), 7)).toBe("😀");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
