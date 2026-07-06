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

function hasTsconfig(cwd: string): boolean {
  return existsSync(path.join(cwd, "tsconfig.json"));
}

export const typescriptAdapter: SourceAdapter = {
  id: "typescript",

  async detect(ctx: HealthContext): Promise<SourceStatus> {
    if (!hasTsconfig(ctx.cwd)) {
      return "skipped";
    }
    return resolveBin(ctx.cwd, "tsc") ? "available" : "missing";
  },

  async run(ctx: HealthContext): Promise<RawSourceResult> {
    const bin = resolveBin(ctx.cwd, "tsc") ?? "tsc";
    const command = [bin, "--noEmit", "--pretty", "false"];
    const result = await runCommand(command, ctx.cwd);
    return {
      source: "typescript",
      command: command.join(" "),
      toolVersion: await toolVersion([bin, "--version"], ctx.cwd),
      exitCode: result.exitCode,
      rawPath: "",
      content: result.combined,
      imported: false,
    };
  },

  async import(): Promise<RawSourceResult> {
    throw new NoImportError("typescript has no import format");
  },

  parse(raw: RawSourceResult): Finding[] {
    const findings: Finding[] = [];
    const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
    for (const line of raw.content.split("\n")) {
      const match = line.match(pattern);
      if (!match) {
        continue;
      }
      const [, file, lineNo, , level, code, message] = match;
      const isError = level === "error";
      findings.push(
        makeFinding({
          source: "typescript",
          severity: isError ? "error" : "warning",
          priority: isError ? "P0" : "P2",
          category: "type",
          message: `${code}: ${message}`,
          ruleKey: code ?? "ts",
          file: file ?? null,
          line: lineNo ? Number(lineNo) : null,
          command: raw.command,
          toolVersion: raw.toolVersion,
          rawLog: raw.rawPath,
        }),
      );
    }
    return findings;
  },
};
