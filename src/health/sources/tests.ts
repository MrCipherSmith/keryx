import { runCommand, toolVersion } from "../util";
import { NoImportError, makeFinding, resolveBin } from "./helpers";
import { loadCompatibleTestingReport, loadTestingReport } from "../../testing/service";
import type { TestingReport } from "../../testing/types";
import type {
  Finding,
  HealthContext,
  RawSourceResult,
  SourceAdapter,
  SourceStatus,
} from "../types";

function hasTestFiles(ctx: HealthContext): boolean {
  return ctx.sourceFiles.some((file) => /\.(test|spec)\.[tj]sx?$/.test(file));
}

export const testsAdapter: SourceAdapter = {
  id: "tests",

  async detect(ctx: HealthContext): Promise<SourceStatus> {
    if (await compatibleReportForHealth(ctx)) {
      return "available";
    }
    if (!hasTestFiles(ctx)) {
      return "skipped";
    }
    return resolveBin(ctx.cwd, "bun") ? "available" : "missing";
  },

  async run(ctx: HealthContext): Promise<RawSourceResult> {
    const bin = resolveBin(ctx.cwd, "bun") ?? "bun";
    const command = [bin, "test"];
    const result = await runCommand(command, ctx.cwd);
    return {
      source: "tests",
      command: command.join(" "),
      toolVersion: await toolVersion([bin, "--version"], ctx.cwd),
      exitCode: result.exitCode,
      rawPath: "",
      content: result.combined,
      imported: false,
    };
  },

  async import(ctx: HealthContext): Promise<RawSourceResult> {
    const report = await compatibleReportForHealth(ctx);
    if (!report) {
      throw new NoImportError("compatible testing report not found");
    }
    return {
      source: "tests",
      command: report.command,
      toolVersion: report.runner,
      exitCode: report.exitCode,
      rawPath: report.rawLogPath ?? "",
      content: JSON.stringify(report, null, 2),
      imported: true,
    };
  },

  parse(raw: RawSourceResult): Finding[] {
    if (raw.imported) {
      return parseTestingReport(raw);
    }

    const findings: Finding[] = [];
    for (const line of raw.content.split("\n")) {
      const match = line.match(/\(fail\)\s+(.*)$/);
      if (!match) {
        continue;
      }
      const label = (match[1] ?? "").trim();
      const file = label.match(/([\w./-]+\.(?:test|spec)\.[tj]sx?)/)?.[1] ?? null;
      findings.push(
        makeFinding({
          source: "tests",
          severity: "error",
          priority: "P0",
          category: "test",
          message: `Failing test: ${label}`,
          ruleKey: label,
          file,
          line: null,
          suggestedAction: "Fix or update the failing test.",
          command: raw.command,
          toolVersion: raw.toolVersion,
          rawLog: raw.rawPath,
        }),
      );
    }

    // Fallback: non-zero exit with no parseable failures.
    if (findings.length === 0 && (raw.exitCode ?? 0) !== 0) {
      findings.push(
        makeFinding({
          source: "tests",
          severity: "error",
          priority: "P0",
          category: "test",
          message: "Test run failed (non-zero exit).",
          ruleKey: "tests-failed",
          file: null,
          line: null,
          command: raw.command,
          toolVersion: raw.toolVersion,
          rawLog: raw.rawPath,
        }),
      );
    }
    return findings;
  },
};

function parseTestingReport(raw: RawSourceResult): Finding[] {
  let report: TestingReport;
  try {
    report = JSON.parse(raw.content) as TestingReport;
  } catch {
    return [];
  }

  const findings = report.failures.map((failure) =>
    makeFinding({
      source: "tests",
      severity: "error",
      priority: "P0",
      category: "test",
      message: failure.message,
      ruleKey: failure.name,
      file: failure.file,
      line: null,
      suggestedAction: "Fix or update the failing test.",
      command: report.command,
      toolVersion: report.runner,
      rawLog: report.rawLogPath,
    }),
  );
  if (findings.length === 0 && report.status !== "pass" && report.status !== "skipped") {
    findings.push(
      makeFinding({
        source: "tests",
        severity: "error",
        priority: "P0",
        category: "test",
        message: `Test run ${report.status} without parseable failures.`,
        ruleKey: "tests-failed",
        file: null,
        line: null,
        command: report.command,
        toolVersion: report.runner,
        rawLog: report.rawLogPath,
      }),
    );
  }
  return findings;
}

async function compatibleReportForHealth(ctx: HealthContext): Promise<TestingReport | null> {
  if (ctx.scopeSelector.kind === "changed") {
    return loadCompatibleTestingReport(ctx.cwd, {
      scope: "changed",
      since: ctx.scopeSelector.since,
    });
  }
  if (ctx.scopeSelector.kind === "project") {
    return loadCompatibleTestingReport(ctx.cwd, { scope: "project" });
  }
  return loadTestingReport(ctx.cwd);
}
