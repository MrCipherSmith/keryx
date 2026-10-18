// `keryx skills references check|suggest` (flow 462): authoring help for the
// conditional-read declarations in `.metaproject/rules/project/references.json`.
// The router in skills.ts dispatches here; the analysis is gdskills/references-check.ts.

import { checkReferences, suggestReferences, type ReferencesCheckReport } from "../gdskills/references-check";

const USAGE = "Usage: keryx skills references check [--json] | keryx skills references suggest";

export function printReferencesHelp(): void {
  console.log(`keryx skills references

Authoring help for .metaproject/rules/project/references.json: the documents project rules
cite, and when a task must read them. Reads files only; nothing is written.

Usage:
  keryx skills references check [--json]
  keryx skills references suggest

  check    Errors (exit 1): a declared document that is missing, outside the project root or
           over the size limit; an anchor that matches no heading; an invalid file.
           Warnings: a description under 20 characters, a keyword under 4, a cited document with
           no declaration, a declaration no rule cites. A missing references.json is not an error.
  suggest  Prints a JSON skeleton for every cited document with no declaration: path, size in
           bytes, the document's headings as anchor candidates, an empty description and an
           empty condition. Fill it in and copy the entries into references.json yourself.
`);
}

export function renderReferencesReport(report: ReferencesCheckReport): string {
  const lines = ["# skills references check", ""];
  lines.push(report.present ? `${report.declared} declared` : "No references.json: nothing is declared.");
  for (const finding of report.findings) {
    lines.push(`- ${finding.severity.padEnd(7)} ${finding.path} [${finding.code}] ${finding.message}`);
  }
  lines.push("", `${report.errors} ${report.errors === 1 ? "error" : "errors"}, ${report.warnings} ${report.warnings === 1 ? "warning" : "warnings"}`);
  return lines.join("\n");
}

/** `keryx skills references <action>`. A check with errors, or a suggest that cannot read the declarations, exits 1. */
export async function referencesCommand(args: string[], projectRoot: string = process.cwd()): Promise<void> {
  const action = args[0];
  if (action === undefined || action === "--help" || action === "-h") {
    printReferencesHelp();
    return;
  }

  if (action === "check") {
    const report = await checkReferences(projectRoot);
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : renderReferencesReport(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (action === "suggest") {
    const result = await suggestReferences(projectRoot);
    if (!result.ok) {
      for (const message of result.errors) console.error(message);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result.suggestion, null, 2));
    return;
  }

  console.error(`Unknown skills references action: ${action}. ${USAGE}`);
  process.exitCode = 1;
}
