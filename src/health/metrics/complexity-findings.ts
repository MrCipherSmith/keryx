import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../lib/fs";
import { computeComplexity } from "./complexity";
import { makeFinding } from "../sources/helpers";
import type { Finding, HealthConfig } from "../types";

// Turns the built-in cyclomatic complexity metric into actionable P2 findings:
// one finding per file whose functions exceed the configured threshold. This
// makes complexity hot-spots learnable by gdskills, not just a scope number.
export async function getComplexityFindings(
  cwd: string,
  sourceFiles: string[],
  config: HealthConfig,
): Promise<Finding[]> {
  const threshold = config.metrics.complexityThreshold;
  const findings: Finding[] = [];

  for (const file of sourceFiles) {
    const abs = path.join(cwd, file);
    if (!(await pathExists(abs))) {
      continue;
    }
    const { functions, max } = computeComplexity(await readFile(abs, "utf8"));
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
