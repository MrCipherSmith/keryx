// Flow 308 (W8, Lane B, T6): pure composition of the impact-evidence sections
// for one file. No writes — session state and logging live in `state.ts`,
// consulted only by `provider.ts`.

import { buildAffectedReport } from "../../gdgraph/affected-report";
import { buildRelatedTestsReport } from "../../testing/related-report";
import { collectEntries } from "../../memory/store";
import { toPosix } from "../../lib/fs";
import type { ImpactEvidence, MemoryCaveatEntry } from "./types";

function normalizeForCompare(file: string): string {
  return toPosix(file).replace(/^\.\//, "");
}

export interface ComputeImpactEvidenceDeps {
  buildAffected?: typeof buildAffectedReport;
  buildRelated?: typeof buildRelatedTestsReport;
  collectMemoryEntries?: typeof collectEntries;
}

/**
 * Compose the evidence block for one file: importers (verbatim from
 * `buildAffectedReport` — AC9), related tests (verbatim from
 * `buildRelatedTestsReport`), and memory caveats — entries whose
 * `scopes.files` names this file, restricted to entries with a non-null
 * `caveat` and an "accepted"/"current" status (a superseded/deprecated/draft
 * entry's caveat is not live guidance).
 */
export async function computeImpactEvidence(
  root: string,
  file: string,
  deps: ComputeImpactEvidenceDeps = {},
): Promise<ImpactEvidence> {
  const buildAffected = deps.buildAffected ?? buildAffectedReport;
  const buildRelated = deps.buildRelated ?? buildRelatedTestsReport;
  const collect = deps.collectMemoryEntries ?? collectEntries;

  const affectedReport = await buildAffected(root, file);
  const importersStatus: ImpactEvidence["importers"]["status"] =
    affectedReport.json["code"] === "index-incomplete"
      ? "index-incomplete"
      : affectedReport.json["code"] === "target-not-indexed"
        ? "not-indexed"
        : "ok";

  const relatedReport = await buildRelated(root, file);

  const entries = await collect(root);
  const normalizedFile = normalizeForCompare(file);
  const memoryCaveats: MemoryCaveatEntry[] = entries
    .filter((entry) => entry.status === "accepted")
    // "current" (bitemporal, C2): an open/current validity interval — a
    // populated `validTo` means the claim's event-time window already
    // closed, so its caveat is historical, not live guidance.
    .filter((entry) => !entry.validTo)
    .filter((entry) => typeof entry.caveat === "string" && entry.caveat.length > 0)
    .filter((entry) => entry.scopes.files.some((f) => normalizeForCompare(f) === normalizedFile))
    .map((entry) => ({ entry: entry.relativePath, caveat: entry.caveat as string }));

  return {
    file,
    importers: {
      status: importersStatus,
      json: JSON.stringify(affectedReport.json, null, 2),
    },
    relatedTests: {
      status: relatedReport.context.status,
      json: JSON.stringify(relatedReport, null, 2),
    },
    memoryCaveats,
  };
}

/**
 * Render a batch of evidence for a human-readable surface (the additional
 * context injected into a tool call, and `security impact-evidence test`'s
 * dry-run output). `siblings` names every OTHER file in the same batch, so a
 * multi-file first-touch (AC12) names every file in one block, not just the
 * one this section is about.
 */
export function renderEvidenceBlock(evidences: ImpactEvidence[], siblings: string[]): string {
  const lines: string[] = [];
  const allFiles = [...new Set([...evidences.map((e) => e.file), ...siblings])];
  lines.push(`Impact evidence for ${allFiles.length} file(s): ${allFiles.join(", ")}`);
  for (const evidence of evidences) {
    lines.push("");
    lines.push(`## ${evidence.file}`);
    if (evidence.importers.status === "not-indexed") {
      lines.push("- importers: not indexed (this file is not a node in the built graph)");
    } else if (evidence.importers.status === "index-incomplete") {
      lines.push("- importers: index incomplete (the graph has not been built here)");
    } else {
      try {
        const parsed = JSON.parse(evidence.importers.json) as { dependents?: string[] };
        const dependents = Array.isArray(parsed.dependents) ? parsed.dependents : [];
        lines.push(
          dependents.length > 0
            ? `- importers (${dependents.length}): ${dependents.join(", ")}`
            : "- importers: none",
        );
      } catch {
        lines.push("- importers: (unparseable evidence)");
      }
    }
    if (evidence.relatedTests.status === "incomplete") {
      lines.push("- related tests: incomplete (the testing-context refresh could not walk the whole tree)");
    } else {
      try {
        const parsed = JSON.parse(evidence.relatedTests.json) as { related?: string[] };
        const related = Array.isArray(parsed.related) ? parsed.related : [];
        lines.push(related.length > 0 ? `- related tests (${related.length}): ${related.join(", ")}` : "- related tests: none");
      } catch {
        lines.push("- related tests: (unparseable evidence)");
      }
    }
    if (evidence.memoryCaveats.length > 0) {
      lines.push(`- memory caveats (${evidence.memoryCaveats.length}):`);
      for (const caveat of evidence.memoryCaveats) {
        lines.push(`  - [${caveat.entry}] ${caveat.caveat}`);
      }
    } else {
      lines.push("- memory caveats: none");
    }
  }
  return lines.join("\n");
}
