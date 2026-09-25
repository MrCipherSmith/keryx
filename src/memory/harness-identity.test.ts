// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff".

import { expect, test } from "bun:test";
import path from "node:path";
import { MEMORY_HARNESS_IDS, isMemoryHarnessId, parseHarnessList } from "./harness-identity";

test("MEMORY_HARNESS_IDS equals the portable-bundle schema's harnessId enum", async () => {
  const schemaPath = path.join(
    import.meta.dir,
    "..",
    "..",
    "docs",
    "requirements",
    "keryx-agent-platform-expansion",
    "schemas",
    "portable-bundle.schema.json",
  );
  const schema = JSON.parse(await Bun.file(schemaPath).text()) as {
    $defs: { harnessId: { enum: string[] } };
  };
  expect(MEMORY_HARNESS_IDS as readonly string[]).toEqual(schema.$defs.harnessId.enum);
});

test("isMemoryHarnessId accepts only the closed set", () => {
  expect(isMemoryHarnessId("claude")).toBe(true);
  expect(isMemoryHarnessId("codex")).toBe(true);
  expect(isMemoryHarnessId("keryx-shell")).toBe(true);
  expect(isMemoryHarnessId("nonexistent-harness")).toBe(false);
  expect(isMemoryHarnessId("")).toBe(false);
});

test("parseHarnessList parses a valid comma list, tolerates invalid input to null", () => {
  expect(parseHarnessList("claude, codex")).toEqual(["claude", "codex"]);
  expect(parseHarnessList("claude")).toEqual(["claude"]);
  expect(parseHarnessList(null)).toBeNull();
  expect(parseHarnessList(undefined)).toBeNull();
  expect(parseHarnessList("")).toBeNull();
  expect(parseHarnessList("claude, not-a-harness")).toBeNull();
});
