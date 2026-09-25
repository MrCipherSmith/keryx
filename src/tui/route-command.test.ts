import { expect, test } from "bun:test";
import { isRouteCommand } from "./route-command";

test("isRouteCommand: matches only the bare /route token", () => {
  expect(isRouteCommand("/route")).toBe(true);
  expect(isRouteCommand("/route on")).toBe(true);
  expect(isRouteCommand("  /route off  ")).toBe(true);
  expect(isRouteCommand("/routing")).toBe(false);
  expect(isRouteCommand("please /route this")).toBe(false);
});
