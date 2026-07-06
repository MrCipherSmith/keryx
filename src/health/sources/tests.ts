import { runCommand, toolVersion } from "../util";
import { NoImportError, makeFinding, resolveBin } from "./helpers";
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

  async import(): Promise<RawSourceResult> {
    throw new NoImportError("tests import not supported in v1");
  },

  parse(raw: RawSourceResult): Finding[] {
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
