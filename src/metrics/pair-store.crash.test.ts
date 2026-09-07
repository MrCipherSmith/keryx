// The AC7 resume clause proved with a real interruption rather than a simulated
// one: a separate process writes the pair intent and the first arm, and is then
// SIGKILLed before the second arm is ever written. SIGKILL is uncatchable, so no
// cleanup, no flush and no finally block runs — what survives is exactly what was
// already durable on disk, which is the only thing the resume path is allowed to
// depend on.

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PairStore, weightOf, type ArmKey, type PairKey } from "./pair-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-pair-crash-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ARMS = ["with-keryx", "without-keryx"] as const;
const KEY: PairKey = { runId: "run-1", taskId: "t1", repetition: 1, protocolDigest: "digest-1" };
const armKey = (arm: string): ArmKey => ({ ...KEY, arm });

const MODULE = path.join(import.meta.dir, "pair-store.ts");

/**
 * Start a child that begins the pair, writes the first arm, signals it is
 * mid-pair, and then hangs. Returns once the signal is on disk.
 */
async function startMidPairChild(storeDir: string): Promise<{ kill: () => Promise<number> }> {
  const marker = path.join(dir, "mid-pair.marker");
  const script = path.join(dir, "child.ts");
  await writeFile(
    script,
    `
import { PairStore } from ${JSON.stringify(MODULE)};
const store = new PairStore(${JSON.stringify(storeDir)}, ${JSON.stringify(ARMS)});
const key = ${JSON.stringify(KEY)};
await store.beginPair(key);
await store.recordArm({ key: { ...key, arm: "with-keryx" }, payload: { correct: 1 } });
await Bun.write(${JSON.stringify(marker)}, "mid-pair");
await new Promise(() => {});
`,
    "utf8",
  );

  const proc = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 30_000;
  while (!(await Bun.file(marker).exists())) {
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error("child never reached the mid-pair state");
    }
    await Bun.sleep(20);
  }
  return {
    kill: async () => {
      proc.kill("SIGKILL");
      return await proc.exited;
    },
  };
}

describe("crash, resume, resume", () => {
  test("a process killed between arm writes leaves exactly one weight after recovery, and no more", async () => {
    const child = await startMidPairChild(dir);
    await child.kill();

    // 1. Immediately after the crash: one arm on disk, the pair began and did
    //    not finish. No weight, and the run is not silently scored as a zero.
    const afterCrash = await new PairStore(dir, ARMS).resume();
    expect(weightOf(afterCrash)).toBe(0);
    expect(afterCrash.incomplete).toHaveLength(1);
    expect(afterCrash.missingness.incompletePairs).toBe(1);
    expect(await readdir(path.join(dir, "arms"))).toHaveLength(1);

    // 2. The recovering runner re-declares the intent and re-runs both arms,
    //    because it does not know which one finished. The already-finished arm
    //    is collapsed, not counted twice.
    const recovering = new PairStore(dir, ARMS);
    await recovering.beginPair(KEY);
    expect((await recovering.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } })).status).toBe(
      "duplicate-identical",
    );
    expect((await recovering.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } })).status).toBe("stored");

    const firstResume = await recovering.resume();
    expect(weightOf(firstResume)).toBe(1);
    expect(firstResume.missingness.duplicatesCollapsed).toBe(1);

    // 3. A second resume, from a fresh process handle, adds nothing.
    expect(weightOf(await new PairStore(dir, ARMS).resume())).toBe(1);

    // 4. And a third.
    const thirdResume = await new PairStore(dir, ARMS).resume();
    expect(weightOf(thirdResume)).toBe(1);
    expect(await readdir(path.join(dir, "pairs"))).toHaveLength(1);
    expect(thirdResume.quarantined).toEqual([]);
  }, 60_000);

  test("a second crash in the same pair still yields one weight", async () => {
    await (await startMidPairChild(dir)).kill();
    expect(weightOf(await new PairStore(dir, ARMS).resume())).toBe(0);

    // The recovering process is itself killed at the same point.
    await (await startMidPairChild(dir)).kill();
    expect(weightOf(await new PairStore(dir, ARMS).resume())).toBe(0);

    const recovering = new PairStore(dir, ARMS);
    await recovering.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } });
    expect(weightOf(await recovering.resume())).toBe(1);
    expect(weightOf(await new PairStore(dir, ARMS).resume())).toBe(1);
    expect(await readdir(path.join(dir, "arms"))).toHaveLength(2);
  }, 90_000);

  test("a killed write leaves no partial artifact a resume would read", async () => {
    const child = await startMidPairChild(dir);
    await child.kill();
    const armFiles = await readdir(path.join(dir, "arms"));
    // writeFileAtomic stages under a dotted `.tmp` name and renames; nothing
    // half-written can ever appear as an artifact.
    expect(armFiles.every((file) => file.endsWith(".json") && !file.startsWith("."))).toBe(true);
    const state = await new PairStore(dir, ARMS).resume();
    expect(state.quarantined).toEqual([]);
  }, 60_000);
});
