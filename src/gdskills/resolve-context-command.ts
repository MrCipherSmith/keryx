import { optionValue, optionValues } from "../lib/args";
import { writeContained } from "../lib/contained-write";
import { type ContextFor, type ProjectContextResolution, recordLastResolve, resolveProjectContext } from "./context-resolver";

const USAGE =
  "Usage: keryx skills resolve-context --files <file>[,<file>...] --for implement|test|review [--task-type <type>] [--max-bytes <n>] [--out <path>] [--json]";

const FOR_VALUES: readonly ContextFor[] = ["implement", "test", "review"];

export function renderResolutionMarkdown(result: ProjectContextResolution): string {
  const lines = [
    `# skills resolve-context (${result.for})`,
    "",
    `Files: ${result.files.length === 0 ? "-" : result.files.join(", ")}`,
    `Budget: ${result.budget.usedBytes} of ${result.budget.limitBytes} bytes (${result.budget.limitSource})${result.budget.exceeded ? " — exceeded" : ""}`,
  ];
  for (const tier of ["must_read", "on_demand"] as const) {
    const group = result.entries.filter((entry) => entry.tier === tier);
    lines.push("", `## ${tier} (${group.length})`);
    for (const entry of group) {
      const flags = [entry.index ? "index" : "", entry.linked ? "linked" : "", entry.shadows ? `shadows ${entry.shadows}` : ""].filter(Boolean);
      lines.push(`- ${entry.path} — ${entry.source} ${entry.kind}, ${entry.reason}, ${entry.bytes} bytes, sha256 ${entry.sha256.slice(0, 12)}${flags.length > 0 ? ` (${flags.join("; ")})` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** `keryx skills resolve-context`. A successful resolve exits 0 whatever the budget says. */
export async function runResolveContextCommand(args: string[], projectRoot: string = process.cwd()): Promise<ProjectContextResolution> {
  const forValue = optionValue(args, "--for");
  if (forValue === undefined || !FOR_VALUES.includes(forValue as ContextFor)) throw new Error(`--for must be implement, test or review. ${USAGE}`);
  const files = optionValues(args, "--files")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (files.length === 0) throw new Error(`--files needs at least one file. ${USAGE}`);
  const rawMax = optionValue(args, "--max-bytes");
  const maxBytes = rawMax === undefined ? undefined : Number(rawMax);
  const taskType = optionValue(args, "--task-type");

  const result = await resolveProjectContext({
    projectRoot,
    files,
    for: forValue as ContextFor,
    ...(taskType !== undefined && taskType !== "" ? { taskType } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
  await recordLastResolve(projectRoot, result);

  const json = `${JSON.stringify(result, null, 2)}\n`;
  const outPath = optionValue(args, "--out");
  if (outPath !== undefined && outPath !== "") await writeContained(projectRoot, outPath, json);
  for (const warning of result.warnings) console.error(`warning: ${warning}`);
  if (args.includes("--json")) console.log(json.trimEnd());
  else {
    console.log(renderResolutionMarkdown(result).trimEnd());
    if (outPath !== undefined && outPath !== "") console.log(`\nResolved context written to ${outPath}`);
  }
  return result;
}
