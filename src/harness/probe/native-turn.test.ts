import { expect, test } from "bun:test";
import { probeReservationUsd } from "./native-turn";

test("unknown or invalid pricing cannot authorize a provider request", () => {
  expect(probeReservationUsd(undefined)).toBe(Infinity);
  expect(probeReservationUsd({ input: -1, output: 1 })).toBe(Infinity);
  expect(probeReservationUsd({ input: NaN, output: 1 })).toBe(Infinity);
});

test("reservation covers every bounded request, not just the first", () => {
  const amount = probeReservationUsd({ input: 2, output: 10 });
  expect(amount).toBeGreaterThan(4 * (65536 * 2 + 1024 * 10) / 1e6);
  expect(Number.isFinite(amount)).toBe(true);
  expect(probeReservationUsd({ input: 0, output: 0 })).toBeGreaterThan(0);
});
