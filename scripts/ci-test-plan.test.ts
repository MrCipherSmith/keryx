import { expect, test } from "bun:test";
import { CORE_SHARDS, coreTestFilters, testFilesForPart, verifyTestInventory } from "./ci-test-plan";

test("CI partitions cover every selected test file exactly once", () => {
  const files = [
    "src/commands/run.test.ts",
    "src/cli.test.ts",
    "scripts/version.test.ts",
    "scripts/verify.spec.mts",
    "src/commands/handler_test.cts",
    "src/tui/terminal.test.tsx",
    "fixtures/example/basic_spec.jsx",
    "src/config.test.json",
    "node_modules/dependency/cache.test.ts",
    "src/.cache/hidden.test.ts",
    "apps/desktop/src/render.test.tsx",
  ];
  const filters = coreTestFilters("bun test src/cli src/commands/ scripts/");
  const ignores = ["apps/desktop/**"];
  const core = Array.from({ length: CORE_SHARDS }, (_, index) =>
    testFilesForPart(files, filters, ignores, String(index + 1))).flat().sort();
  const remaining = testFilesForPart(files, filters, ignores, "remaining");
  expect(core).toEqual([
    "scripts/verify.spec.mts",
    "scripts/version.test.ts",
    "src/cli.test.ts",
    "src/commands/handler_test.cts",
    "src/commands/run.test.ts",
  ]);
  expect(remaining).toEqual(["fixtures/example/basic_spec.jsx", "src/tui/terminal.test.tsx"]);
  expect([...core, ...remaining].sort()).toEqual(testFilesForPart(files, filters, ignores, "all"));
});

test("CI refuses unsupported core filter syntax and unknown partitions", () => {
  expect(() => coreTestFilters("bun test")).toThrow("plain Bun path filters");
  expect(() => coreTestFilters("bun test --timeout 5000")).toThrow("plain Bun path filters");
  expect(() => testFilesForPart([], [], [], "5")).toThrow("Unknown CI test partition");
});

test("CI requires the reported test files to match the complete plan", () => {
  const planned = ["src/cli.test.ts", "src/auth.test.ts"];
  expect(verifyTestInventory(planned, {
    version: 1,
    files: { "./src/cli.test.ts": 5, "src/auth.test.ts": 12 },
  }, "1")).toBe(2);

  expect(() => verifyTestInventory(planned, {
    version: 1,
    files: { "./src/cli.test.ts": 5, "src/extra.test.ts": 12 },
  }, "1")).toThrow("Missing: src/auth.test.ts. Extra: src/extra.test.ts.");
  expect(() => verifyTestInventory(planned, { version: 1, files: [] }, "1")).toThrow("Unexpected Bun timings format");
});
