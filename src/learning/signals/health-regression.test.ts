import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { healthRegressionSignal } from "./health-regression";

function withProjectRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-learning-health-regression-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writeReport(root: string, stamp: string, generatedAt: string, findings: unknown[]): void {
  const dir = path.join(root, ".metaproject", "data", "health", "history");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify({ schemaVersion: 3, generatedAt, findings }, null, 2));
}

const FINDING = {
  message: "Missing test coverage for the payment module",
  suggestedAction: "Add unit tests covering the refund path",
  scope: { skill: "module/payments" },
};

describe("healthRegressionSignal", () => {
  test("a finding repeating across >=2 reports for the same scope.skill yields a candidate", async () => {
    await withProjectRoot(async (root) => {
      writeReport(root, "2026-09-01T00-00-00-000Z", "2026-09-01T00:00:00.000Z", [FINDING]);
      writeReport(root, "2026-09-08T00-00-00-000Z", "2026-09-08T00:00:00.000Z", [FINDING]);

      const drafts = await healthRegressionSignal(root, []);
      expect(drafts.length).toBe(1);
      expect(drafts[0]?.extractor).toBe("health-regression");
      expect(drafts[0]?.evidence.length).toBe(2);
      expect(drafts[0]?.trigger).toContain("module/payments");
    });
  });

  test("a single occurrence does not yield a candidate", async () => {
    await withProjectRoot(async (root) => {
      writeReport(root, "2026-09-01T00-00-00-000Z", "2026-09-01T00:00:00.000Z", [FINDING]);
      expect(await healthRegressionSignal(root, [])).toEqual([]);
    });
  });

  test("no history directory means no candidates", async () => {
    await withProjectRoot(async (root) => {
      expect(await healthRegressionSignal(root, [])).toEqual([]);
    });
  });
});
