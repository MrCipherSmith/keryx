import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodeHealthService } from "../health/service";
import type { HealthReport } from "../health/types";
import { withCwd } from "../lib/test-cwd";
import { healthCommand } from "./health";

test("the stored-report health service rejects incomplete even without strict-warn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-service-incomplete-"));
  try {
    await writeLatest(root, incompleteReport());

    const gate = await createCodeHealthService().gate({ cwd: root });

    expect(String(gate.status)).toBe("incomplete");
    expect(gate.exitCode).toBe(1);
    expect(gate.reasons.join("\n")).toMatch(/eslint/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict health run prints INCOMPLETE and exits nonzero when a selected required source is skipped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-cli-incomplete-"));
  const captured: string[] = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "health.config.json"), "{}\n", "utf8");
    await writeFile(path.join(root, "index.ts"), "export const synthetic = true;\n", "utf8");
    console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
    process.exitCode = undefined;

    await withCwd(root, () => healthCommand(["run", "--strict", "--source", "eslint", "--json"]));

    const report = JSON.parse(captured.join("\n")) as HealthReport;
    expect(String(report.gate.status)).toBe("incomplete");
    expect(Number(process.exitCode)).toBe(1);
    expect(report.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "eslint", required: true, status: "skipped" }),
      ]),
    );
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode ?? 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("stored warning exits zero normally and nonzero under strict-warn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-service-warning-"));
  try {
    const report = incompleteReport();
    report.gate = { status: "warn", reasons: ["WARN: synthetic warning"], coverage: "complete" };
    await writeLatest(root, report);
    const service = createCodeHealthService();

    expect((await service.gate({ cwd: root })).exitCode).toBe(0);
    expect((await service.gate({ cwd: root, strictWarn: true })).exitCode).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeLatest(root: string, report: HealthReport): Promise<void> {
  const artifacts = path.join(root, ".metaproject", "data", "health", "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(root, ".metaproject", "health.config.json"), "{}\n", "utf8");
  await writeFile(path.join(artifacts, "latest.json"), `${JSON.stringify(report)}\n`, "utf8");
}

function incompleteReport(): HealthReport {
  return {
    schemaVersion: 2,
    generatedAt: "2026-09-06T00:00:00.000Z",
    scope: "project",
    strict: true,
    gitRef: null,
    gate: {
      status: "incomplete",
      reasons: ["INCOMPLETE: required source skipped: eslint"],
      coverage: "incomplete",
    },
    sources: [
      {
        source: "eslint",
        status: "skipped",
        mode: "auto",
        required: true,
        imported: false,
        command: null,
        toolVersion: null,
        findings: 0,
      },
    ],
    metrics: [],
    findings: [],
  } as unknown as HealthReport;
}
