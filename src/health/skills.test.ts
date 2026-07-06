import { test, expect } from "bun:test";
import { buildOwnership } from "./skills";

const registry = [
  { module: "wiki", name: "service", target: "src/wiki/service.ts" },
  { module: "wiki", name: "area", target: "src/wiki" },
  { module: "health", name: "concept", target: "code-review-flow" },
];

test("maps a file to the most specific owning skill", () => {
  const ownership = buildOwnership(registry);
  // file target beats the enclosing directory target
  expect(ownership.skillForFile("src/wiki/service.ts")).toBe("wiki/service");
  // directory target owns other files under it
  expect(ownership.skillForFile("src/wiki/index.ts")).toBe("wiki/area");
  // unowned file
  expect(ownership.skillForFile("src/health/run.ts")).toBe(null);
});

test("lists registered skills and resolves exact symbol/path targets", () => {
  const ownership = buildOwnership(registry);
  expect(ownership.skills).toEqual(["health/concept", "wiki/area", "wiki/service"]);
  expect(ownership.skillForFile("code-review-flow")).toBe("health/concept");
});

test("empty or malformed registry owns nothing", () => {
  expect(buildOwnership([]).skillForFile("src/x.ts")).toBe(null);
  expect(
    buildOwnership([{ module: "m" } as never]).skills,
  ).toEqual([]);
});
