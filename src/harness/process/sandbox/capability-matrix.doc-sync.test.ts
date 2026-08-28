// AC4 (flow 142): the capability matrix in `keryx sandbox status` output and
// the matrix in docs/verification/linux-sandbox-verification.md must not be
// able to drift apart silently. capability-matrix.ts is the single source;
// this test is the enforcement — it parses the runbook's own Markdown table
// and asserts every row matches SANDBOX_CAPABILITY_MATRIX. A hand-edit to
// either side that stops agreeing with the other fails here.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SANDBOX_CAPABILITY_MATRIX,
  capabilityStatusFor,
  statusCellText,
  type SandboxCapabilityRow,
} from "./capability-matrix";

const DOC_PATH = path.join(import.meta.dir, "..", "..", "..", "..", "docs", "verification", "linux-sandbox-verification.md");

interface DocRow {
  label: string;
  linuxCell: string;
  macosCell: string;
}

/**
 * Parse the "## Scope on Linux" table. Deliberately narrow: only pipe-table
 * rows between that heading and the next `---` divider, header/separator rows
 * skipped, `**bold**` stripped so presentation does not count as content.
 */
function parseScopeTable(markdown: string): DocRow[] {
  const headingIndex = markdown.indexOf("## Scope on Linux");
  if (headingIndex === -1) {
    throw new Error("docs/verification/linux-sandbox-verification.md: '## Scope on Linux' heading not found");
  }
  const dividerIndex = markdown.indexOf("\n---", headingIndex);
  const section = dividerIndex === -1 ? markdown.slice(headingIndex) : markdown.slice(headingIndex, dividerIndex);

  const rows: DocRow[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim().replace(/\*\*/g, ""));
    if (cells.length !== 3) continue;
    const [label, linuxCell, macosCell] = cells as [string, string, string];
    if (label === "Capability") continue; // header row
    if (/^-+$/.test(label.replace(/[:\s]/g, ""))) continue; // separator row
    rows.push({ label, linuxCell, macosCell });
  }
  return rows;
}

/** Find the matrix row a doc row describes: by flag first (more specific), then by capability name. */
function matchingMatrixRow(docRow: DocRow): SandboxCapabilityRow | undefined {
  return SANDBOX_CAPABILITY_MATRIX.find((row) => {
    if (row.flag !== undefined) return docRow.label.includes(row.flag);
    return docRow.label.includes(row.capability);
  });
}

describe("sandbox capability matrix — doc sync (AC4)", () => {
  const markdown = readFileSync(DOC_PATH, "utf8");
  const docRows = parseScopeTable(markdown);

  test("the doc table has exactly the rows the matrix defines", () => {
    expect(docRows.length).toBe(SANDBOX_CAPABILITY_MATRIX.length);
  });

  test("every doc row matches a matrix row", () => {
    const unmatched = docRows.filter((docRow) => matchingMatrixRow(docRow) === undefined).map((r) => r.label);
    expect(unmatched).toEqual([]);
  });

  test("every matrix row's Linux status agrees with the doc", () => {
    for (const row of SANDBOX_CAPABILITY_MATRIX) {
      const docRow = docRows.find((r) => matchingMatrixRow(r) === row);
      expect(docRow).toBeDefined();
      expect(docRow!.linuxCell).toBe(statusCellText(capabilityStatusFor(row, "linux")));
    }
  });

  test("every matrix row's macOS status agrees with the doc", () => {
    for (const row of SANDBOX_CAPABILITY_MATRIX) {
      const docRow = docRows.find((r) => matchingMatrixRow(r) === row);
      expect(docRow).toBeDefined();
      expect(docRow!.macosCell).toBe(statusCellText(capabilityStatusFor(row, "darwin")));
    }
  });

  test("falsifiable: a row deliberately mismatched against the parsed doc is caught", () => {
    // Proves the equality assertions above are load-bearing, not vacuous: flip
    // one status and the same comparison must fail.
    const flipped: SandboxCapabilityRow = { capability: "Filesystem containment", linux: "not-implemented", darwin: "supported" };
    const docRow = docRows.find((r) => r.label.includes("Filesystem containment"));
    expect(docRow).toBeDefined();
    expect(docRow!.linuxCell).not.toBe(statusCellText(capabilityStatusFor(flipped, "linux")));
  });
});
