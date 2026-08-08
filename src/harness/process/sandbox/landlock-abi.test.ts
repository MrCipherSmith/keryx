import { describe, expect, test } from "bun:test";
import { LANDLOCK_ABI_UNAVAILABLE, cacheLandlockAbi } from "./landlock-abi";
import type { LandlockAbiReader } from "./landlock-abi";

describe("AC5: cacheLandlockAbi is a mechanism-free, single-call seam", () => {
  test("the injected reader is called exactly once, however often the ABI is asked for", () => {
    let calls = 0;
    const read: LandlockAbiReader = () => {
      calls += 1;
      return 4;
    };
    const abi = cacheLandlockAbi(read);
    expect([abi(), abi(), abi()]).toEqual([4, 4, 4]);
    expect(calls).toBe(1);
  });

  test("a cached zero is still cached — absence is an answer, not a miss", () => {
    let calls = 0;
    const abi = cacheLandlockAbi(() => {
      calls += 1;
      return LANDLOCK_ABI_UNAVAILABLE;
    });
    expect(abi()).toBe(0);
    expect(abi()).toBe(0);
    expect(calls).toBe(1);
  });

  test("a throwing reader is called once and re-throws the same error", () => {
    let calls = 0;
    const boom = new Error("ffi symbol landlock_create_ruleset not found");
    const abi = cacheLandlockAbi(() => {
      calls += 1;
      throw boom;
    });
    expect(() => abi()).toThrow(boom);
    expect(() => abi()).toThrow(boom);
    expect(calls).toBe(1);
  });

  test("a mechanism failure is not converted into LANDLOCK_ABI_UNAVAILABLE", () => {
    // "the mechanism broke" and "this kernel has no Landlock" are different
    // facts; `sandbox status` has to be able to tell them apart, and collapsing
    // the first into the second is the same unverified-conclusion defect the
    // package exists to remove. The policy decision belongs to detect.ts.
    const abi = cacheLandlockAbi(() => {
      throw new Error("nope");
    });
    expect(() => abi()).toThrow("nope");
  });

  test("each cache is independent, so no test can leak an ABI into another", () => {
    const one = cacheLandlockAbi(() => 1);
    const four = cacheLandlockAbi(() => 4);
    expect(one()).toBe(1);
    expect(four()).toBe(4);
    expect(one()).toBe(1);
  });

  test("the module exposes no mechanism of its own", async () => {
    // The spike on `bun:ffi` (specification §4.2) may conclude that a compiled
    // helper is required. Anything here that assumed a mechanism would have to
    // be rewritten when it does, so the seam holds only the interface.
    const module = await import("./landlock-abi");
    expect(Object.keys(module).sort()).toEqual(["LANDLOCK_ABI_UNAVAILABLE", "cacheLandlockAbi"]);
  });
});
