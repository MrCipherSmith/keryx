import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PairStore, armKeyId, pairKeyId, weightOf, type ArmKey, type PairKey } from "./pair-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-pair-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ARMS = ["with-keryx", "without-keryx"] as const;

const pairKey = (over: Partial<PairKey> = {}): PairKey => ({
  runId: "run-1",
  taskId: "t1",
  repetition: 1,
  protocolDigest: "digest-1",
  ...over,
});

const armKey = (arm: string, over: Partial<PairKey> = {}): ArmKey => ({ ...pairKey(over), arm });

/** A fresh handle on the same directory: what a restarted process sees. */
const restart = (): PairStore => new PairStore(dir, ARMS);

describe("keys", () => {
  test("an arm key is identified by all five of its fields", () => {
    const base = armKey("with-keryx");
    const ids = new Set([
      armKeyId(base),
      armKeyId({ ...base, runId: "run-2" }),
      armKeyId({ ...base, taskId: "t2" }),
      armKeyId({ ...base, repetition: 2 }),
      armKeyId({ ...base, arm: "without-keryx" }),
      armKeyId({ ...base, protocolDigest: "digest-2" }),
    ]);
    expect(ids.size).toBe(6);
  });

  test("field boundaries cannot be forged by embedding the separator in a value", () => {
    expect(armKeyId(armKey("with-keryx", { runId: "run-1|t1" }))).not.toBe(
      armKeyId(armKey("with-keryx", { runId: "run-1", taskId: "|t1" })),
    );
  });

  test("a pair key ignores the arm, so both arms of a pair land in the same pair", () => {
    expect(pairKeyId(pairKey())).toBe(pairKeyId({ ...pairKey() }));
  });
});

describe("PairStore, the ordinary path", () => {
  test("two completed arms seal exactly one pair", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    expect((await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } })).status).toBe("stored");
    expect((await store.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } })).status).toBe("stored");

    const state = await store.resume();
    expect(weightOf(state)).toBe(1);
    expect(state.pairs[0]!.arms).toEqual(["with-keryx", "without-keryx"]);
    expect(state.incomplete).toEqual([]);
    expect(state.quarantined).toEqual([]);
  });

  test("a pair with only one arm recorded is incomplete and carries no weight", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });

    const state = await store.resume();
    expect(weightOf(state)).toBe(0);
    expect(state.incomplete).toHaveLength(1);
    expect(state.missingness.incompletePairs).toBe(1);
  });

  test("sealing is idempotent: resuming ten times never adds a second pair", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    await store.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } });

    for (let i = 0; i < 10; i += 1) expect(weightOf(await store.resume())).toBe(1);
    expect(await readdir(path.join(dir, "pairs"))).toHaveLength(1);
  });

  test("distinct repetitions of the same task are distinct pairs", async () => {
    const store = restart();
    for (const repetition of [1, 2]) {
      await store.beginPair(pairKey({ repetition }));
      for (const arm of ARMS) {
        await store.recordArm({ key: armKey(arm, { repetition }), payload: { correct: repetition } });
      }
    }
    expect(weightOf(await store.resume())).toBe(2);
  });
});

describe("PairStore, an arm that was never intended", () => {
  // The proposal-lifecycle lesson: the record that a step BEGAN is what makes a
  // restart able to tell "never started" from "already done". An arm artifact
  // with no such record cannot be accounted for, so it gets no weight.
  test("recording an arm with no durable pair intent is rejected, not stored", async () => {
    const store = restart();
    const outcome = await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    expect(outcome.status).toBe("rejected");
    const state = await store.resume();
    expect(weightOf(state)).toBe(0);
    expect(state.quarantined.map((entry) => entry.reason)).toEqual(["unexpected-arm"]);
  });

  test("an arm outside the protocol roster is rejected", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    const outcome = await store.recordArm({ key: armKey("context-off"), payload: {} });
    expect(outcome.status).toBe("rejected");
    expect((await store.resume()).quarantined.map((entry) => entry.reason)).toEqual(["unexpected-arm"]);
  });
});

describe("PairStore, duplicates", () => {
  // A restart that re-runs an arm it had already finished must not double-count.
  // Identical data is collapsed to the one artifact already on disk.
  test("an identical duplicate collapses to one weight and is counted, not averaged", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    const again = await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    await store.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } });

    expect(again.status).toBe("duplicate-identical");
    const state = await store.resume();
    expect(weightOf(state)).toBe(1);
    expect(state.missingness.duplicatesCollapsed).toBe(1);
  });

  test("an identical duplicate does not rewrite the immutable artifact", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    const first = await store.readArm(armKey("with-keryx"));
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    const second = await store.readArm(armKey("with-keryx"));
    expect(second?.recordedAt).toBe(first!.recordedAt);
  });

  // "same key/different data — conflict". Not averaged, not last-write-wins, not
  // silently dropped: the pair is excluded and the exclusion is published.
  test("same key with different data is a conflict and the pair never seals", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    const conflict = await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 0 } });
    await store.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } });

    expect(conflict.status).toBe("conflict");
    const state = await store.resume();
    expect(weightOf(state)).toBe(0);
    expect(state.quarantined.map((entry) => entry.reason)).toContain("conflicting-duplicate");
    expect(state.missingness.reasons["conflicting-duplicate"]).toBe(1);
  });

  test("a conflict survives a restart: it is durable, not in-memory bookkeeping", async () => {
    const first = restart();
    await first.beginPair(pairKey());
    await first.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    await first.recordArm({ key: armKey("with-keryx"), payload: { correct: 0 } });

    const state = await restart().resume();
    expect(weightOf(state)).toBe(0);
    expect(state.quarantined.map((entry) => entry.reason)).toContain("conflicting-duplicate");
  });
});

describe("PairStore, orphans", () => {
  // An arm artifact nobody ever intended — dropped in, or whose intent was lost.
  // It is quarantined rather than deleted, because "invalid task не исчезает
  // бесследно": the exclusion has to be visible and counted.
  test("an arm with no intent on disk is quarantined with zero weight, not dropped", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    await store.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } });
    await rm(path.join(dir, "intents", `${pairKeyId(pairKey())}.json`));

    const state = await restart().resume();
    expect(weightOf(state)).toBe(0);
    expect(state.quarantined.map((entry) => entry.reason)).toEqual(["orphan-unpaired", "orphan-unpaired"]);
    expect(state.missingness.quarantinedArms).toBe(2);
  });

  test("finalize turns a still-incomplete pair into a counted exclusion", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });

    const state = await store.finalize();
    expect(weightOf(state)).toBe(0);
    expect(state.quarantined.map((entry) => entry.reason)).toEqual(["incomplete-arm"]);
    expect(state.missingness.reasons["incomplete-arm"]).toBe(1);
  });

  test("finalize does not touch a pair that sealed", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    await store.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } });
    const state = await store.finalize();
    expect(weightOf(state)).toBe(1);
    expect(state.quarantined).toEqual([]);
  });
});

describe("PairStore, resume validates every field", () => {
  test("an arm file whose stored key does not match its own filename is quarantined", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    await store.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } });

    const tampered = path.join(dir, "arms", `${armKeyId(armKey("with-keryx"))}.json`);
    await writeFile(
      tampered,
      JSON.stringify({
        key: { ...armKey("with-keryx"), taskId: "t-other" },
        payload: { correct: 1 },
        payloadDigest: "whatever",
        recordedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const state = await restart().resume();
    expect(weightOf(state)).toBe(0);
    expect(state.quarantined.map((entry) => entry.reason)).toContain("key-mismatch");
  });

  test("an unparseable arm file is quarantined, never read as an empty result", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    await writeFile(path.join(dir, "arms", `${armKeyId(armKey("with-keryx"))}.json`), "{not json", "utf8");

    const state = await restart().resume();
    expect(weightOf(state)).toBe(0);
    expect(state.quarantined.map((entry) => entry.reason)).toContain("key-mismatch");
  });

  test("a sealed pair whose arm digests no longer match its artifacts is quarantined", async () => {
    const store = restart();
    await store.beginPair(pairKey());
    await store.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    await store.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } });
    expect(weightOf(await store.resume())).toBe(1);

    const sealed = path.join(dir, "pairs", `${pairKeyId(pairKey())}.json`);
    const record = JSON.parse(await Bun.file(sealed).text()) as { armDigests: Record<string, string> };
    record.armDigests["with-keryx"] = "0".repeat(64);
    await writeFile(sealed, JSON.stringify(record), "utf8");

    const state = await restart().resume();
    expect(weightOf(state)).toBe(0);
    expect(state.quarantined.map((entry) => entry.reason)).toContain("key-mismatch");
  });
});

describe("PairStore, crash then resume then resume", () => {
  // The AC7 clause, driven through the API. The real-interruption version of the
  // same sequence lives in pair-store.crash.test.ts.
  test("a crash between arm writes still yields exactly one weight, and resuming again does not add another", async () => {
    const crashed = restart();
    await crashed.beginPair(pairKey());
    await crashed.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    // ... process dies here, before the second arm is written.

    const afterCrash = await restart().resume();
    expect(weightOf(afterCrash)).toBe(0);
    expect(afterCrash.incomplete).toHaveLength(1);

    const resumed = restart();
    await resumed.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } });
    expect(weightOf(await resumed.resume())).toBe(1);

    expect(weightOf(await restart().resume())).toBe(1);
    expect(weightOf(await restart().resume())).toBe(1);
  });

  // The naive restart: the runner does not know which arms it finished, so it
  // re-runs both. Without the durable intent this is where double-counting lives.
  test("a restart that re-runs both arms produces one pair, not two", async () => {
    const crashed = restart();
    await crashed.beginPair(pairKey());
    await crashed.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });

    const resumed = restart();
    await resumed.beginPair(pairKey());
    await resumed.recordArm({ key: armKey("with-keryx"), payload: { correct: 1 } });
    await resumed.recordArm({ key: armKey("without-keryx"), payload: { correct: 0 } });

    const state = await resumed.resume();
    expect(weightOf(state)).toBe(1);
    expect(state.missingness.duplicatesCollapsed).toBe(1);
    expect(weightOf(await restart().resume())).toBe(1);
  });
});
