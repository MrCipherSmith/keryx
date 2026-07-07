import { makeFinding } from "../sources/helpers";
import { analyzeSourceFiles, type SourceFileAnalysis } from "../source-analysis";
import type { Finding, HealthConfig } from "../types";

// Turns the built-in cyclomatic complexity metric into actionable P2 findings:
// one finding per file whose functions exceed the configured threshold. This
// makes complexity hot-spots learnable by gdskills, not just a scope number.
export async function getComplexityFindings(
  cwd: string,
  sourceFiles: string[],
  config: HealthConfig,
  sourceAnalysis?: Map<string, SourceFileAnalysis>,
): Promise<Finding[]> {
  const threshold = config.metrics.complexityThreshold;
  const findings: Finding[] = [];
  const analysis = sourceAnalysis ?? await analyzeSourceFiles(cwd, sourceFiles);

  for (const [file, item] of analysis) {
    const functions = item.complexity;
    const max = Math.max(0, ...functions);
    const over = functions.filter((value) => value > threshold).length;
    if (over === 0) {
      continue;
    }
    findings.push(
      makeFinding({
        source: "complexity",
        severity: "warning",
        priority: "P2",
        category: "complexity",
        message: `${over} function(s) exceed cyclomatic complexity ${threshold} (max ${max})`,
        ruleKey: "complexity-threshold",
        file,
        line: null,
        suggestedAction:
          "Refactor the most complex functions to reduce branching and nesting.",
        command: "builtin: cyclomatic (token-based)",
        toolVersion: null,
        rawLog: null,
      }),
    );
  }

  return findings;
}
