import { expect, test } from "bun:test";
import * as containmentModule from "./run-containment";

type ResolveContainmentPort = (port: number | undefined) => number;

function resolver(): ResolveContainmentPort {
  const candidate = (containmentModule as Record<string, unknown>).resolveContainmentPort;
  expect(candidate).toBeFunction();
  return candidate as ResolveContainmentPort;
}

test("containment accepts the concrete port returned by the bound local listener", () => {
  expect(resolver()(43123)).toBe(43123);
});

test("containment refuses an absent listener port instead of choosing an unsafe default", () => {
  expect(() => resolver()(undefined)).toThrow(/containment.*port|bound.*port|listener.*port/i);
});
