// The per-instance memo under `createSecurityService`.
//
// It exists for a measured reason: `redact` used to reload the security config
// and the HMAC key on every call, which is invisible while every caller
// constructs a service per call and is not once `keryx serve` gave it a loop —
// 80µs of the 121µs each `assistant.delta` cost, ten thousand times a turn.
//
// The first version was `once ??= load()`, which caches the PROMISE. A promise
// that rejects is still a value, so one transient filesystem fault poisoned the
// instance for the rest of the turn while an uncached caller would simply have
// read the file again. These tests are the difference between those two.

import { describe, expect, test } from "bun:test";
import { memoizeResolved } from "./service";

describe("memoizeResolved", () => {
  test("a resolved value is loaded once and reused", () => {
    // The reason the memo exists at all. Without this the fix below could be
    // "call load() every time", which passes every other test here.
    let calls = 0;
    const memo = memoizeResolved(async () => {
      calls += 1;
      return "config";
    });

    return Promise.all([memo(), memo(), memo()]).then(async (values) => {
      expect(values).toEqual(["config", "config", "config"]);
      expect(await memo()).toBe("config");
      expect(calls).toBe(1);
    });
  });

  test("a rejection is NOT remembered — the next call retries and can succeed", async () => {
    // THE finding. One `EINTR` reading the HMAC key used to cost a 10,000-event
    // turn its entire redaction.
    let calls = 0;
    const memo = memoizeResolved(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("EINTR");
      }
      return "key";
    });

    await expect(memo()).rejects.toThrow("EINTR");
    // Not the cached rejection — a real second attempt, which succeeds.
    expect(await memo()).toBe("key");
    expect(calls).toBe(2);

    // And the success is now the memoised value, so the retry did not turn the
    // memo into a pass-through.
    expect(await memo()).toBe("key");
    expect(calls).toBe(2);
  });

  test("callers already awaiting a failing load all see that failure", async () => {
    // Correct rather than unfortunate: they asked at the same time, so they get
    // the same answer. What must not happen is the call AFTER them inheriting it.
    let calls = 0;
    const memo = memoizeResolved(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient");
      }
      return "value";
    });

    const settled = await Promise.allSettled([memo(), memo(), memo()]);
    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(calls).toBe(1);

    expect(await memo()).toBe("value");
    expect(calls).toBe(2);
  });

  test("a load that keeps failing keeps being attempted", async () => {
    // The other direction. A permanent fault must not be silently swallowed into
    // one report and then forgotten.
    let calls = 0;
    const memo = memoizeResolved(async () => {
      calls += 1;
      throw new Error("EACCES");
    });

    for (let i = 0; i < 3; i++) {
      await expect(memo()).rejects.toThrow("EACCES");
    }
    expect(calls).toBe(3);
  });
});
