import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand, toolVersion } from "../util";
import { NoImportError, makeFinding, resolveBin } from "./helpers";
import type {
  Finding,
  HealthContext,
  RawSourceResult,
  SourceAdapter,
  SourceStatus,
} from "../types";

const CONFIG_FILES = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
];

function hasConfig(cwd: string): boolean {
  return CONFIG_FILES.some((file) => existsSync(path.join(cwd, file)));
}

export const eslintAdapter: SourceAdapter = {
  id: "eslint",

  async detect(ctx: HealthContext): Promise<SourceStatus> {
    if (!hasConfig(ctx.cwd)) {
      return "skipped";
    }
    return resolveBin(ctx.cwd, "eslint") ? "available" : "missing";
  },

  async run(ctx: HealthContext): Promise<RawSourceResult> {
    const bin = resolveBin(ctx.cwd, "eslint") ?? "eslint";
    const command = [bin, ".", "--format", "json"];
    const result = await runCommand(command, ctx.cwd);
    return {
      source: "eslint",
      command: `${command.join(" ")}`,
      toolVersion: await toolVersion([bin, "--version"], ctx.cwd),
      exitCode: result.exitCode,
      rawPath: "",
      content: result.stdout || result.combined,
      imported: false,
    };
  },

  async import(ctx: HealthContext): Promise<RawSourceResult> {
    const report = path.join(ctx.cwd, "eslint-report.json");
    if (!existsSync(report)) {
      throw new NoImportError("no eslint-report.json");
    }
    const content = await Bun.file(report).text();
    return {
      source: "eslint",
      command: null,
      toolVersion: null,
      exitCode: 0,
      rawPath: "",
      content,
      imported: true,
    };
  },

  parse(raw: RawSourceResult, ctx: HealthContext): Finding[] {
    let data: Array<{
      filePath: string;
      messages: Array<{
        ruleId: string | null;
        severity: number;
        message: string;
        line: number;
      }>;
    }>;
    try {
      data = JSON.parse(raw.content);
    } catch {
      return [];
    }
    if (!Array.isArray(data)) {
      return [];
    }

    const findings: Finding[] = [];
    for (const file of data) {
      const relative = path.isAbsolute(file.filePath)
        ? path.relative(ctx.cwd, file.filePath)
        : file.filePath;
      for (const message of file.messages ?? []) {
        const isError = message.severity === 2;
        findings.push(
          makeFinding({
            source: "eslint",
            severity: isError ? "error" : "warning",
            priority: isError ? "P1" : "P2",
            category: "lint",
            message: message.message,
            ruleKey: message.ruleId ?? "eslint",
            file: relative,
            line: message.line ?? null,
            command: raw.command,
            toolVersion: raw.toolVersion,
            rawLog: raw.rawPath,
          }),
        );
      }
    }
    return findings;
  },
};
