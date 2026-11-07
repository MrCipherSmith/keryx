import { expect, test } from "bun:test";
import { approvalFloor, FLOOR_CLASSES } from "./arbiter-floor";

const meta = { fingerprint: "f", destructive: false };

test("flow 486: both hc floors have a class, and an approval without one has none", () => {
  expect(FLOOR_CLASSES).toContain("hc-launch");
  expect(approvalFloor({ ...meta, hcLaunch: "claude" })).toBe("hc-launch");
  expect(approvalFloor({ ...meta, alwaysAsk: true })).toBe("always-ask");
  expect(approvalFloor(meta)).toBeUndefined();
});

test("flow 486: a harder floor keeps its own class over hc-launch", () => {
  expect(approvalFloor({ ...meta, destructive: true, hcLaunch: "claude" })).toBe("destructive");
  expect(approvalFloor({ ...meta, publishLease: true, hcLaunch: "claude" })).toBe("publish");
});
