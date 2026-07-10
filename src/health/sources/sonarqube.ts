import { existsSync } from "node:fs";
import path from "node:path";
import { NoImportError, makeFinding } from "./helpers";
import type {
  Finding,
  HealthContext,
  Priority,
  RawSourceResult,
  SourceAdapter,
  SourceStatus,
} from "../types";

// SonarQube adapter. Sonar is import-oriented: CI exports the issues search
// result (GET /api/issues/search) to a JSON file that Code Health reads.
// Default config disables it; enable with `"sonarqube": { "mode": "import" }`.

const REPORT_FILES = ["sonar-issues.json", ".metaproject/data/health/sonar-issues.json"];

function reportPath(cwd: string): string | null {
  const fromEnv = process.env.SONAR_ISSUES_FILE;
  const candidates = fromEnv ? [fromEnv, ...REPORT_FILES] : REPORT_FILES;
  for (const rel of candidates) {
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    if (existsSync(abs)) {
      return abs;
    }
  }
  return null;
}

function severityToPriority(severity: string): Priority {
  switch (severity.toUpperCase()) {
    case "BLOCKER":
    case "CRITICAL":
      return "P0";
    case "MAJOR":
      return "P1";
    case "MINOR":
      return "P2";
    default:
      return "P3";
  }
}

export const sonarqubeAdapter: SourceAdapter = {
  id: "sonarqube",

  async detect(ctx: HealthContext): Promise<SourceStatus> {
    return reportPath(ctx.cwd) ? "available" : "skipped";
  },

  async run(): Promise<RawSourceResult> {
    throw new NoImportError(
      "sonarqube is import-only; export /api/issues/search to sonar-issues.json",
    );
  },

  async import(ctx: HealthContext): Promise<RawSourceResult> {
    const report = reportPath(ctx.cwd);
    if (!report) {
      throw new NoImportError("no sonar-issues.json found");
    }
    return {
      source: "sonarqube",
      command: null,
      toolVersion: null,
      exitCode: 0,
      rawPath: "",
      content: await Bun.file(report).text(),
      imported: true,
    };
  },

  parse(raw: RawSourceResult, ctx: HealthContext): Finding[] {
    let data: {
      issues?: Array<{
        rule?: string;
        severity?: string;
        message?: string;
        component?: string;
        line?: number;
        type?: string;
      }>;
    };
    try {
      data = JSON.parse(raw.content);
    } catch {
      return [];
    }

    const findings: Finding[] = [];
    for (const issue of data.issues ?? []) {
      const severity = issue.severity ?? "INFO";
      const file = issue.component
        ? relativizeComponent(issue.component, ctx.cwd)
        : null;
      findings.push(
        makeFinding({
          source: "sonarqube",
          severity: severity === "MINOR" || severity === "INFO" ? "warning" : "error",
          priority: severityToPriority(severity),
          category: (issue.type ?? "sonar").toLowerCase(),
          message: issue.message ?? issue.rule ?? "Sonar issue",
          ruleKey: issue.rule ?? "sonar",
          file,
          line: typeof issue.line === "number" ? issue.line : null,
          command: raw.command,
          toolVersion: raw.toolVersion,
          rawLog: raw.rawPath,
        }),
      );
    }
    return findings;
  },
};

// Sonar `component` is "<projectKey>:<path>"; keep the path part.
function relativizeComponent(component: string, cwd: string): string {
  const colon = component.indexOf(":");
  const value = colon >= 0 ? component.slice(colon + 1) : component;
  return path.isAbsolute(value) ? path.relative(cwd, value) : value;
}
