import { runCommand, toolVersion } from "../util";
import { NoImportError, makeFinding, resolveBin } from "./helpers";
import type {
  Finding,
  HealthContext,
  Priority,
  RawSourceResult,
  SourceAdapter,
  SourceStatus,
} from "../types";

function auditSeverityToPriority(severity: string): Priority {
  switch (severity) {
    case "critical":
    case "high":
      return "P0";
    case "moderate":
      return "P1";
    default:
      return "P2";
  }
}

export const dependencyAuditAdapter: SourceAdapter = {
  id: "dependencyAudit",

  async detect(ctx: HealthContext): Promise<SourceStatus> {
    return resolveBin(ctx.cwd, "bun") || resolveBin(ctx.cwd, "npm")
      ? "available"
      : "missing";
  },

  async run(ctx: HealthContext): Promise<RawSourceResult> {
    const bun = resolveBin(ctx.cwd, "bun");
    const command = bun
      ? [bun, "audit", "--json"]
      : [resolveBin(ctx.cwd, "npm") ?? "npm", "audit", "--json"];
    const result = await runCommand(command, ctx.cwd);
    return {
      source: "dependencyAudit",
      command: command.join(" "),
      toolVersion: await toolVersion([command[0] ?? "bun", "--version"], ctx.cwd),
      exitCode: result.exitCode,
      rawPath: "",
      content: result.stdout || result.combined,
      imported: false,
    };
  },

  async import(): Promise<RawSourceResult> {
    throw new NoImportError("dependency audit has no import format in v1");
  },

  parse(raw: RawSourceResult): Finding[] {
    let data: {
      vulnerabilities?: Record<
        string,
        { severity?: string; via?: unknown; title?: string }
      >;
      advisories?: Record<
        string,
        { severity?: string; module_name?: string; title?: string }
      >;
    };
    try {
      data = JSON.parse(raw.content);
    } catch {
      return [];
    }

    const findings: Finding[] = [];

    for (const [name, vuln] of Object.entries(data.vulnerabilities ?? {})) {
      const severity = vuln.severity ?? "low";
      findings.push(
        makeFinding({
          source: "dependencyAudit",
          severity: severity === "low" ? "warning" : "error",
          priority: auditSeverityToPriority(severity),
          category: "dependency",
          message: `${severity} vulnerability in ${name}`,
          ruleKey: `audit-${name}`,
          file: "package.json",
          line: null,
          symbol: name,
          suggestedAction: "Update or replace the vulnerable dependency.",
          command: raw.command,
          toolVersion: raw.toolVersion,
          rawLog: raw.rawPath,
        }),
      );
    }

    for (const [id, adv] of Object.entries(data.advisories ?? {})) {
      const severity = adv.severity ?? "low";
      findings.push(
        makeFinding({
          source: "dependencyAudit",
          severity: severity === "low" ? "warning" : "error",
          priority: auditSeverityToPriority(severity),
          category: "dependency",
          message: `${severity}: ${adv.title ?? id} (${adv.module_name ?? "?"})`,
          ruleKey: `advisory-${id}`,
          file: "package.json",
          line: null,
          symbol: adv.module_name ?? null,
          suggestedAction: "Update or replace the vulnerable dependency.",
          command: raw.command,
          toolVersion: raw.toolVersion,
          rawLog: raw.rawPath,
        }),
      );
    }

    return findings;
  },
};
