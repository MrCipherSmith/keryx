// flow 462: how the TUI shows the project's conditional references: the `refs`
// segment of the `ProjectCtx` sidebar line and the References tab of the
// `/projectctx` modal. Pure functions over `ProjectContextStatus`; the states are
// docs/requirements/keryx-conditional-reads/TUI-states.md.
//
// A declared reference is told apart from a cited contract by its `condition`:
// only declared references carry one (reference-entries.ts).

import type { ContextEntry } from "../gdskills/context-resolver";
import type { ProjectContextStatus } from "../gdskills/project-context-status";
import { REFERENCES_SUGGEST_COMMAND, type ReferencesFinding } from "../gdskills/references-check";
import type { ReferenceDeclaration } from "../gdskills/references-config";

export const NO_REFERENCES_TEXT = `no conditional references declared; to list the documents your rules cite, run: ${REFERENCES_SUGGEST_COMMAND}`;

type DeclaredStatus = Extract<NonNullable<ProjectContextStatus["references"]>, { state: "declared" }>;

/** The last resolve's entry for a declaration, or undefined when there is no resolve or it did not list the document. */
function entryFor(status: ProjectContextStatus, declaration: ReferenceDeclaration): ContextEntry | undefined {
  return status.last?.result.entries.find((entry) => entry.path === declaration.path && entry.condition !== undefined);
}

function promotedCount(status: ProjectContextStatus, references: DeclaredStatus): number {
  return references.declarations.filter((declaration) => entryFor(status, declaration)?.tier === "must_read").length;
}

/** `refs <promoted>/<declared>` with `-` before any resolve, `!<k>` for problems, `?` for an invalid file; undefined without a file. */
export function referencesSidebarSegment(status: ProjectContextStatus): string | undefined {
  const references = status.references;
  if (references === undefined) return undefined;
  if (references.state === "invalid") return "refs ?";
  const promoted = status.last === undefined ? "-" : String(promotedCount(status, references));
  const problems = references.findings.length > 0 ? ` !${references.findings.length}` : "";
  return `refs ${promoted}/${references.declarations.length}${problems}`;
}

const conditionText = (declaration: ReferenceDeclaration): string =>
  [...declaration.when.globs.map((glob) => `glob ${glob}`), ...declaration.when.keywords.map((keyword) => `keyword ${keyword}`)].join(", ");

/** `condition:glob:src/**` reads as "matched glob src/**"; any other reason is shown as recorded. */
function reasonText(reason: string): string {
  const match = /^condition:(glob|keyword):(.*)$/s.exec(reason);
  return match === null ? reason : `matched ${match[1]} ${match[2]}`;
}

function rowLines(status: ProjectContextStatus, declaration: ReferenceDeclaration): string[] {
  const lines = [declaration.anchor === undefined ? declaration.path : `${declaration.path} § ${declaration.anchor}`, `  when: ${conditionText(declaration)}`];
  if (status.last === undefined) return [...lines, "  not resolved"];
  const entry = entryFor(status, declaration);
  if (entry === undefined) return [...lines, "  not in the last resolve (see its warnings)"];
  if (entry.tier === "on_demand") return [...lines, `  on demand · ${entry.description ?? declaration.description}`];
  const size = entry.section_bytes !== undefined ? `section ${entry.section_bytes} bytes` : `${entry.bytes} bytes`;
  lines.push(`  promoted · ${reasonText(entry.reason)} · ${size}`);
  const budget = status.last.result.budget;
  if (budget.exceeded) lines.push(`  over the cap: ${budget.usedBytes} of ${budget.limitBytes} bytes`);
  return lines;
}

const findingLine = (finding: ReferencesFinding): string => `  [${finding.severity}] ${finding.code} ${finding.path}: ${finding.message}`;

export function formatProjectReferencesLines(status: ProjectContextStatus): string[] {
  const references = status.references;
  if (references === undefined) return [NO_REFERENCES_TEXT];
  if (references.state === "invalid") return ["References file is invalid:", ...references.errors.map((message) => `  ${message}`)];
  const total = references.declarations.length;
  const lines = [status.last === undefined ? `References: ${total} declared, no resolve yet` : `References: ${promotedCount(status, references)} promoted of ${total} declared`];
  if (total === 0) lines.push("", NO_REFERENCES_TEXT);
  for (const declaration of references.declarations) lines.push("", ...rowLines(status, declaration));
  if (references.findings.length > 0) lines.push("", `problems (${references.findings.length}):`, ...references.findings.map(findingLine));
  return lines;
}
