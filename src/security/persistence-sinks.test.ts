import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prepareOutputForPersistence, type GuardResult } from "./guard";

const sinkFiles = [
  "src/memory/write.ts",
  "src/wiki/service.ts",
  "src/sac/wiki-owner-writer.ts",
  "src/gdskills/project-skills.ts",
  "src/metrics/lifecycle.ts",
  "src/testing/service.ts",
  "src/testing/coverage-map.ts",
];

const pass: GuardResult = { allowed: true, decision: { gate: "pass", action: "allow", findings: [] } };
const redacted: GuardResult = {
  allowed: true,
  redacted: "token=[REDACTED]",
  decision: { gate: "pass", action: "redact", findings: [] },
};

test("materializer preserves allowed output when no redaction is supplied", () => {
  expect(prepareOutputForPersistence(pass, "token=raw")).toEqual({ allowed: true, content: "token=raw" });
});

test("materializer uses the guard's redacted output and refuses blocked writes", () => {
  expect(prepareOutputForPersistence(redacted, "token=raw")).toEqual({ allowed: true, content: "token=[REDACTED]" });
  expect(prepareOutputForPersistence({ ...redacted, allowed: false, reason: "blocked" }, "token=raw")).toEqual({
    allowed: false,
    reason: "blocked",
  });
});

for (const sinkFile of sinkFiles) {
  test(`${sinkFile} materializes guarded output before persistence`, async () => {
    const source = await readFile(path.join(process.cwd(), sinkFile), "utf8");
    expect(source).toContain("prepareOutputForPersistence");
    expect(source).toContain("output.content");
  });

  test(`${sinkFile} blocks before its guarded write`, async () => {
    const source = await readFile(path.join(process.cwd(), sinkFile), "utf8");
    expect(source).toContain("output.reason");
    expect(source).toContain("output.allowed");
  });
}
